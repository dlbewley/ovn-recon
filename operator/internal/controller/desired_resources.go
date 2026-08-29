/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package controller

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/utils/pointer"

	reconv1beta1 "github.com/dlbewley/ovn-recon-operator/api/v1beta1"
)

const defaultCollectorRepository = "quay.io/dbewley/ovn-collector"

var defaultCollectorProbeNamespaces = []string{"openshift-ovn-kubernetes", "openshift-frr-k8s"}

// DesiredDeployment renders the Deployment for a given OvnRecon instance.
func DesiredDeployment(ovnRecon *reconv1beta1.OvnRecon) *appsv1.Deployment {
	namespace := targetNamespace(ovnRecon)
	imageTag := imageTagFor(ovnRecon)
	appLabels := labelsForOvnReconWithVersion(ovnRecon.Name, imageTag)
	operatorAnnotations := operatorVersionAnnotations()

	pullPolicy := imagePullPolicyFor(ovnRecon)
	image := pluginImageFor(ovnRecon)
	replicas := int32(1)

	return &appsv1.Deployment{
		TypeMeta: metav1.TypeMeta{
			APIVersion: "apps/v1",
			Kind:       "Deployment",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:        ovnRecon.Name,
			Namespace:   namespace,
			Labels:      appLabels,
			Annotations: operatorAnnotations,
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{
				MatchLabels: map[string]string{
					"app.kubernetes.io/name":      "ovn-recon",
					"app.kubernetes.io/instance":  ovnRecon.Name,
					"app.kubernetes.io/component": "plugin",
				},
			},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: appLabels,
				},
				Spec: corev1.PodSpec{
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot: pointer.Bool(true),
						SeccompProfile: &corev1.SeccompProfile{
							Type: corev1.SeccompProfileTypeRuntimeDefault,
						},
					},
					Containers: []corev1.Container{{
						Name:  "ovn-recon",
						Image: image,
						Env: []corev1.EnvVar{
							{
								Name:  "OVN_RECON_NGINX_ERROR_LOG_LEVEL",
								Value: consolePluginErrorLogLevelFor(ovnRecon),
							},
							{
								Name:  "OVN_RECON_NGINX_ACCESS_LOG",
								Value: consolePluginAccessLogDirectiveFor(ovnRecon),
							},
						},
						Ports: []corev1.ContainerPort{{
							ContainerPort: 9443,
							Name:          "https",
							Protocol:      corev1.ProtocolTCP,
						}},
						ImagePullPolicy: pullPolicy,
						SecurityContext: &corev1.SecurityContext{
							AllowPrivilegeEscalation: pointer.Bool(false),
							Capabilities: &corev1.Capabilities{
								Drop: []corev1.Capability{"ALL"},
							},
							ReadOnlyRootFilesystem: pointer.Bool(false),
							RunAsNonRoot:           pointer.Bool(true),
						},
						Resources: corev1.ResourceRequirements{
							Requests: corev1.ResourceList{
								corev1.ResourceCPU:    resource.MustParse("50m"),
								corev1.ResourceMemory: resource.MustParse("32Mi"),
							},
							Limits: corev1.ResourceList{
								corev1.ResourceCPU:    resource.MustParse("500m"),
								corev1.ResourceMemory: resource.MustParse("512Mi"),
							},
						},
						LivenessProbe: &corev1.Probe{
							ProbeHandler: corev1.ProbeHandler{
								HTTPGet: &corev1.HTTPGetAction{
									Path:   "/healthz",
									Port:   intstr.FromInt32(9443),
									Scheme: corev1.URISchemeHTTPS,
								},
							},
							InitialDelaySeconds: 30,
							PeriodSeconds:       10,
							TimeoutSeconds:      5,
							FailureThreshold:    3,
						},
						ReadinessProbe: &corev1.Probe{
							ProbeHandler: corev1.ProbeHandler{
								HTTPGet: &corev1.HTTPGetAction{
									Path:   "/readyz",
									Port:   intstr.FromInt32(9443),
									Scheme: corev1.URISchemeHTTPS,
								},
							},
							InitialDelaySeconds: 5,
							PeriodSeconds:       5,
							TimeoutSeconds:      3,
							FailureThreshold:    3,
						},
						VolumeMounts: []corev1.VolumeMount{{
							Name:      "plugin-serving-cert",
							ReadOnly:  true,
							MountPath: "/var/serving-cert",
						}},
					}},
					Volumes: []corev1.Volume{{
						Name: "plugin-serving-cert",
						VolumeSource: corev1.VolumeSource{
							Secret: &corev1.SecretVolumeSource{
								SecretName:  "plugin-serving-cert",
								DefaultMode: pointer.Int32(420),
							},
						},
					}},
				},
			},
		},
	}
}

// collectorCacheUsesPVC reports whether the rendered cache volume will be
// PVC-backed (mode PVC with a claim name; otherwise EmptyDir).
func collectorCacheUsesPVC(ovnRecon *reconv1beta1.OvnRecon) bool {
	storage := ovnRecon.Spec.Collector.Cache.Storage
	return collectorCacheEnabledFor(ovnRecon) &&
		strings.EqualFold(storage.Mode, "PVC") &&
		strings.TrimSpace(storage.ClaimName) != ""
}

// collectorRolloutStrategy picks the rollout strategy from the cache volume:
// RollingUpdate everywhere except a non-RWX PVC, where the surge pod could
// deadlock on the RWO volume attach against the old pod's node. A nil PVC
// (not found, or not yet looked up) is treated as non-RWX.
func collectorRolloutStrategy(ovnRecon *reconv1beta1.OvnRecon, cachePVC *corev1.PersistentVolumeClaim) appsv1.DeploymentStrategy {
	if !collectorCacheUsesPVC(ovnRecon) {
		return appsv1.DeploymentStrategy{}
	}
	if cachePVC != nil {
		for _, mode := range cachePVC.Spec.AccessModes {
			if mode == corev1.ReadWriteMany {
				return appsv1.DeploymentStrategy{}
			}
		}
	}
	return appsv1.DeploymentStrategy{Type: appsv1.RecreateDeploymentStrategyType}
}

// DesiredCollectorDeployment renders the collector Deployment for a given
// OvnRecon instance. cachePVC is the looked-up cache claim when the cache is
// PVC-backed (nil when absent); it only influences the rollout strategy.
func DesiredCollectorDeployment(ovnRecon *reconv1beta1.OvnRecon, cachePVC *corev1.PersistentVolumeClaim) *appsv1.Deployment {
	namespace := targetNamespace(ovnRecon)
	imageTag := collectorImageTagFor(ovnRecon)
	name := collectorName(ovnRecon)
	appLabels := labelsForOvnReconWithVersion(ovnRecon.Name, imageTag)
	appLabels["app.kubernetes.io/component"] = "collector"
	operatorAnnotations := operatorVersionAnnotations()

	pullPolicy := collectorImagePullPolicyFor(ovnRecon)
	image := collectorImageFor(ovnRecon)
	replicas := int32(1)

	env := []corev1.EnvVar{
		{
			Name:  "COLLECTOR_TARGET_NAMESPACES",
			Value: strings.Join(collectorProbeNamespacesFor(ovnRecon), ","),
		},
		{
			Name:  "COLLECTOR_LOG_LEVEL",
			Value: collectorLogLevelFor(ovnRecon),
		},
		{
			Name:  "COLLECTOR_INCLUDE_PROBE_OUTPUT",
			Value: strconv.FormatBool(collectorIncludeProbeOutputFor(ovnRecon)),
		},
	}
	var volumes []corev1.Volume
	var volumeMounts []corev1.VolumeMount
	if collectorCacheEnabledFor(ovnRecon) {
		env = append(env,
			corev1.EnvVar{Name: "COLLECTOR_CACHE_DIR", Value: collectorCacheDir},
			corev1.EnvVar{Name: "COLLECTOR_CACHE_TTL_SECONDS", Value: strconv.FormatInt(int64(collectorCacheTTLSecondsFor(ovnRecon)), 10)},
		)
		volumes = append(volumes, collectorCacheVolumeFor(ovnRecon))
		volumeMounts = append(volumeMounts, corev1.VolumeMount{
			Name:      "snapshot-cache",
			MountPath: collectorCacheDir,
		})
	}

	return &appsv1.Deployment{
		TypeMeta: metav1.TypeMeta{
			APIVersion: "apps/v1",
			Kind:       "Deployment",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:        name,
			Namespace:   namespace,
			Labels:      appLabels,
			Annotations: operatorAnnotations,
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Strategy: collectorRolloutStrategy(ovnRecon, cachePVC),
			Selector: &metav1.LabelSelector{
				MatchLabels: map[string]string{
					"app.kubernetes.io/name":      "ovn-recon",
					"app.kubernetes.io/instance":  ovnRecon.Name,
					"app.kubernetes.io/component": "collector",
				},
			},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: map[string]string{
						"app.kubernetes.io/name":       "ovn-recon",
						"app.kubernetes.io/instance":   ovnRecon.Name,
						"app.kubernetes.io/managed-by": "ovn-recon-operator",
						"app.kubernetes.io/component":  "collector",
					},
				},
				Spec: corev1.PodSpec{
					ServiceAccountName: collectorServiceAccountName(ovnRecon),
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot: pointer.Bool(true),
						SeccompProfile: &corev1.SeccompProfile{
							Type: corev1.SeccompProfileTypeRuntimeDefault,
						},
					},
					Containers: []corev1.Container{{
						Name:            "ovn-collector",
						Image:           image,
						ImagePullPolicy: pullPolicy,
						Env:             env,
						VolumeMounts:    volumeMounts,
						Ports: []corev1.ContainerPort{{
							ContainerPort: 8090,
							Name:          "http",
							Protocol:      corev1.ProtocolTCP,
						}},
						SecurityContext: &corev1.SecurityContext{
							AllowPrivilegeEscalation: pointer.Bool(false),
							Capabilities: &corev1.Capabilities{
								Drop: []corev1.Capability{"ALL"},
							},
							ReadOnlyRootFilesystem: pointer.Bool(false),
							RunAsNonRoot:           pointer.Bool(true),
						},
						Resources: corev1.ResourceRequirements{
							Requests: corev1.ResourceList{
								corev1.ResourceCPU:    resource.MustParse("50m"),
								corev1.ResourceMemory: resource.MustParse("64Mi"),
							},
							Limits: corev1.ResourceList{
								corev1.ResourceCPU:    resource.MustParse("500m"),
								corev1.ResourceMemory: resource.MustParse("512Mi"),
							},
						},
						LivenessProbe: &corev1.Probe{
							ProbeHandler: corev1.ProbeHandler{
								HTTPGet: &corev1.HTTPGetAction{
									Path: "/healthz",
									Port: intstr.FromInt32(8090),
								},
							},
							InitialDelaySeconds: 10,
							PeriodSeconds:       10,
							TimeoutSeconds:      3,
							FailureThreshold:    3,
						},
						ReadinessProbe: &corev1.Probe{
							ProbeHandler: corev1.ProbeHandler{
								HTTPGet: &corev1.HTTPGetAction{
									Path: "/readyz",
									Port: intstr.FromInt32(8090),
								},
							},
							InitialDelaySeconds: 5,
							PeriodSeconds:       5,
							TimeoutSeconds:      3,
							FailureThreshold:    3,
						},
					}},
					Volumes: volumes,
				},
			},
		},
	}
}

// DesiredCollectorService renders the collector Service for a given OvnRecon instance.
func DesiredCollectorService(ovnRecon *reconv1beta1.OvnRecon) *corev1.Service {
	namespace := targetNamespace(ovnRecon)
	name := collectorName(ovnRecon)
	appLabels := labelsForOvnReconWithVersion(ovnRecon.Name, collectorImageTagFor(ovnRecon))
	appLabels["app.kubernetes.io/component"] = "collector"

	return &corev1.Service{
		TypeMeta: metav1.TypeMeta{
			APIVersion: "v1",
			Kind:       "Service",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:        name,
			Namespace:   namespace,
			Labels:      appLabels,
			Annotations: operatorVersionAnnotations(),
		},
		Spec: corev1.ServiceSpec{
			Selector: map[string]string{
				"app.kubernetes.io/name":      "ovn-recon",
				"app.kubernetes.io/instance":  ovnRecon.Name,
				"app.kubernetes.io/component": "collector",
			},
			Ports: []corev1.ServicePort{{
				Port:       8090,
				TargetPort: intstr.FromInt32(8090),
				Name:       "http",
			}},
		},
	}
}

// DesiredService renders the Service for a given OvnRecon instance.
func DesiredService(ovnRecon *reconv1beta1.OvnRecon) *corev1.Service {
	namespace := targetNamespace(ovnRecon)
	appLabels := labelsForOvnReconWithVersion(ovnRecon.Name, imageTagFor(ovnRecon))
	annotations := mergeStringMap(nil, operatorVersionAnnotations())
	annotations["service.alpha.openshift.io/serving-cert-secret-name"] = "plugin-serving-cert"
	annotations["service.beta.openshift.io/serving-cert-secret-name"] = "plugin-serving-cert"

	return &corev1.Service{
		TypeMeta: metav1.TypeMeta{
			APIVersion: "v1",
			Kind:       "Service",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:        ovnRecon.Name,
			Namespace:   namespace,
			Labels:      appLabels,
			Annotations: annotations,
		},
		Spec: corev1.ServiceSpec{
			Selector: map[string]string{
				"app.kubernetes.io/name":      "ovn-recon",
				"app.kubernetes.io/instance":  ovnRecon.Name,
				"app.kubernetes.io/component": "plugin",
			},
			Ports: []corev1.ServicePort{{
				Port:       9443,
				TargetPort: intstr.FromInt32(9443),
				Name:       "https",
			}},
		},
	}
}

func collectorImageRepositoryFor(ovnRecon *reconv1beta1.OvnRecon) string {
	if ovnRecon.Spec.Collector.Image.Repository != "" {
		return ovnRecon.Spec.Collector.Image.Repository
	}
	if ovnRecon.Spec.CollectorImage.Repository != "" {
		return ovnRecon.Spec.CollectorImage.Repository
	}
	return defaultCollectorRepository
}

func collectorImageTagFor(ovnRecon *reconv1beta1.OvnRecon) string {
	if ovnRecon.Spec.Collector.Image.Tag != "" {
		return ovnRecon.Spec.Collector.Image.Tag
	}
	if ovnRecon.Spec.CollectorImage.Tag != "" {
		return ovnRecon.Spec.CollectorImage.Tag
	}
	// Inherit plugin image tag behavior by default.
	return imageTagFor(ovnRecon)
}

func collectorImagePullPolicyFor(ovnRecon *reconv1beta1.OvnRecon) corev1.PullPolicy {
	if ovnRecon.Spec.Collector.Image.PullPolicy != "" {
		return corev1.PullPolicy(ovnRecon.Spec.Collector.Image.PullPolicy)
	}
	if ovnRecon.Spec.CollectorImage.PullPolicy != "" {
		return corev1.PullPolicy(ovnRecon.Spec.CollectorImage.PullPolicy)
	}
	return imagePullPolicyFor(ovnRecon)
}

func collectorProbeNamespacesFor(ovnRecon *reconv1beta1.OvnRecon) []string {
	if len(ovnRecon.Spec.Collector.ProbeNamespaces) != 0 {
		return append([]string{}, ovnRecon.Spec.Collector.ProbeNamespaces...)
	}
	if len(ovnRecon.Spec.CollectorProbeNamespaces) == 0 {
		return append([]string{}, defaultCollectorProbeNamespaces...)
	}
	return append([]string{}, ovnRecon.Spec.CollectorProbeNamespaces...)
}

func collectorLogLevelFor(ovnRecon *reconv1beta1.OvnRecon) string {
	if strings.TrimSpace(ovnRecon.Spec.Collector.Logging.Level) != "" {
		return strings.ToLower(strings.TrimSpace(ovnRecon.Spec.Collector.Logging.Level))
	}
	return "info"
}

func collectorIncludeProbeOutputFor(ovnRecon *reconv1beta1.OvnRecon) bool {
	return ovnRecon.Spec.Collector.Logging.IncludeProbeOutput
}

// collectorCacheDir is where the collector expects its snapshot cache
// volume; the collector receives it via COLLECTOR_CACHE_DIR.
const collectorCacheDir = "/var/cache/ovn-recon"

const minCollectorCacheTTLSeconds = int32(30)
const defaultCollectorCacheTTLSeconds = int32(120)

func collectorCacheEnabledFor(ovnRecon *reconv1beta1.OvnRecon) bool {
	enabled := ovnRecon.Spec.Collector.Cache.Enabled
	if enabled == nil {
		return true
	}
	return *enabled
}

// collectorCacheTTLSecondsFor applies the same floor the CRD validates, as a
// guard for objects created before the validation existed.
func collectorCacheTTLSecondsFor(ovnRecon *reconv1beta1.OvnRecon) int32 {
	ttl := ovnRecon.Spec.Collector.Cache.TTLSeconds
	if ttl == 0 {
		return defaultCollectorCacheTTLSeconds
	}
	if ttl < minCollectorCacheTTLSeconds {
		return minCollectorCacheTTLSeconds
	}
	return ttl
}

// collectorCacheVolumeFor renders the cache volume: a PVC when configured
// with a claim name, otherwise EmptyDir (also the documented fallback for
// PVC mode without a claimName).
func collectorCacheVolumeFor(ovnRecon *reconv1beta1.OvnRecon) corev1.Volume {
	storage := ovnRecon.Spec.Collector.Cache.Storage
	if strings.EqualFold(storage.Mode, "PVC") && strings.TrimSpace(storage.ClaimName) != "" {
		return corev1.Volume{
			Name: "snapshot-cache",
			VolumeSource: corev1.VolumeSource{
				PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
					ClaimName: storage.ClaimName,
				},
			},
		}
	}
	return corev1.Volume{
		Name: "snapshot-cache",
		VolumeSource: corev1.VolumeSource{
			EmptyDir: &corev1.EmptyDirVolumeSource{},
		},
	}
}

func consolePluginErrorLogLevelFor(ovnRecon *reconv1beta1.OvnRecon) string {
	level := strings.ToLower(strings.TrimSpace(ovnRecon.Spec.ConsolePlugin.Logging.Level))
	switch level {
	case "error", "warn", "info", "debug":
		return level
	default:
		return "info"
	}
}

func consolePluginAccessLogDirectiveFor(ovnRecon *reconv1beta1.OvnRecon) string {
	if ovnRecon.Spec.ConsolePlugin.Logging.AccessLog.Enabled {
		return "/dev/stdout main"
	}
	return "off"
}

// DesiredConsolePlugin renders the ConsolePlugin for a given OvnRecon instance.
func DesiredConsolePlugin(ovnRecon *reconv1beta1.OvnRecon) *unstructured.Unstructured {
	displayName := ovnRecon.Spec.ConsolePlugin.DisplayName
	if displayName == "" {
		displayName = "OVN Recon"
	}

	plugin := &unstructured.Unstructured{}
	plugin.SetGroupVersionKind(schema.GroupVersionKind{
		Group:   "console.openshift.io",
		Version: "v1",
		Kind:    "ConsolePlugin",
	})
	plugin.SetName(ovnRecon.Name)

	operatorAnnotations := operatorVersionAnnotations()
	if len(operatorAnnotations) > 0 {
		plugin.SetAnnotations(operatorAnnotations)
	}

	plugin.Object["spec"] = map[string]interface{}{
		"displayName": displayName,
		"backend": map[string]interface{}{
			"type": "Service",
			"service": map[string]interface{}{
				"name":      ovnRecon.Name,
				"namespace": targetNamespace(ovnRecon),
				"port":      9443,
				"basePath":  "/",
			},
		},
	}

	return plugin
}

func mergeStringMap(dst, src map[string]string) map[string]string {
	if dst == nil {
		dst = map[string]string{}
	}
	for k, v := range src {
		dst[k] = v
	}
	return dst
}

// relatedImageFor returns an operand image declared through the RELATED_IMAGE_*
// convention, or "" when unset.
//
// These env vars are the OLM contract for operand images: operator-sdk harvests
// them into the CSV's spec.relatedImages, and a mirroring tool rewrites them to
// point at the mirror registry when the catalog is mirrored for a disconnected
// cluster. Honouring them here is what makes the declaration true rather than
// decorative -- the image we deploy is the one the bundle declared.
func relatedImageFor(envVar string) string {
	return strings.TrimSpace(os.Getenv(envVar))
}

// composeImage joins a repository and tag, tolerating an empty tag.
func composeImage(repository, tag string) string {
	if tag == "" {
		return repository
	}
	return fmt.Sprintf("%s:%s", repository, tag)
}

// pluginImageFor resolves the console plugin image.
//
// An explicit repository or tag on the CR always wins, so a user pinning either
// one keeps the composed behaviour they expect. Only when the CR says nothing do
// we fall back to the RELATED_IMAGE_* value, and then to the built-in default.
func pluginImageFor(ovnRecon *reconv1beta1.OvnRecon) string {
	spec := ovnRecon.Spec
	if spec.ConsolePlugin.Image.Repository == "" && spec.ConsolePlugin.Image.Tag == "" &&
		spec.Image.Repository == "" && spec.Image.Tag == "" {
		if related := relatedImageFor("RELATED_IMAGE_PLUGIN"); related != "" {
			return related
		}
	}
	return composeImage(imageRepositoryFor(ovnRecon), imageTagFor(ovnRecon))
}

// collectorImageFor resolves the collector image, with the same precedence.
func collectorImageFor(ovnRecon *reconv1beta1.OvnRecon) string {
	spec := ovnRecon.Spec
	if spec.Collector.Image.Repository == "" && spec.Collector.Image.Tag == "" &&
		spec.CollectorImage.Repository == "" && spec.CollectorImage.Tag == "" &&
		spec.ConsolePlugin.Image.Tag == "" && spec.Image.Tag == "" {
		if related := relatedImageFor("RELATED_IMAGE_COLLECTOR"); related != "" {
			return related
		}
	}
	return composeImage(collectorImageRepositoryFor(ovnRecon), collectorImageTagFor(ovnRecon))
}

func imageRepositoryFor(ovnRecon *reconv1beta1.OvnRecon) string {
	if ovnRecon.Spec.ConsolePlugin.Image.Repository != "" {
		return ovnRecon.Spec.ConsolePlugin.Image.Repository
	}
	if ovnRecon.Spec.Image.Repository != "" {
		return ovnRecon.Spec.Image.Repository
	}
	return defaultImageRepository
}

func imagePullPolicyFor(ovnRecon *reconv1beta1.OvnRecon) corev1.PullPolicy {
	if ovnRecon.Spec.ConsolePlugin.Image.PullPolicy != "" {
		return corev1.PullPolicy(ovnRecon.Spec.ConsolePlugin.Image.PullPolicy)
	}
	if ovnRecon.Spec.Image.PullPolicy != "" {
		return corev1.PullPolicy(ovnRecon.Spec.Image.PullPolicy)
	}
	return corev1.PullIfNotPresent
}
