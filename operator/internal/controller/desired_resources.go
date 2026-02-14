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

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/utils/pointer"

	reconv1alpha1 "github.com/dlbewley/ovn-recon-operator/api/v1alpha1"
)

const defaultCollectorRepository = "quay.io/dbewley/ocn-collector"

// DesiredDeployment renders the Deployment for a given OvnRecon instance.
func DesiredDeployment(ovnRecon *reconv1alpha1.OvnRecon) *appsv1.Deployment {
	namespace := targetNamespace(ovnRecon)
	imageTag := imageTagFor(ovnRecon)
	appLabels := labelsForOvnReconWithVersion(ovnRecon.Name, imageTag)
	operatorAnnotations := operatorVersionAnnotations()

	pullPolicy := corev1.PullIfNotPresent
	if ovnRecon.Spec.Image.PullPolicy != "" {
		pullPolicy = corev1.PullPolicy(ovnRecon.Spec.Image.PullPolicy)
	}
	image := ovnRecon.Spec.Image.Repository
	if imageTag != "" {
		image = fmt.Sprintf("%s:%s", image, imageTag)
	}
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
				MatchLabels: labelsForOvnRecon(ovnRecon.Name),
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

// DesiredCollectorDeployment renders the collector Deployment for a given OvnRecon instance.
func DesiredCollectorDeployment(ovnRecon *reconv1alpha1.OvnRecon) *appsv1.Deployment {
	namespace := targetNamespace(ovnRecon)
	imageTag := collectorImageTagFor(ovnRecon)
	name := collectorName(ovnRecon)
	appLabels := labelsForOvnReconWithVersion(ovnRecon.Name, imageTag)
	appLabels["app.kubernetes.io/component"] = "collector"
	operatorAnnotations := operatorVersionAnnotations()

	pullPolicy := collectorImagePullPolicyFor(ovnRecon)
	image := collectorImageRepositoryFor(ovnRecon)
	if imageTag != "" {
		image = fmt.Sprintf("%s:%s", image, imageTag)
	}
	replicas := int32(1)

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
				},
			},
		},
	}
}

// DesiredCollectorService renders the collector Service for a given OvnRecon instance.
func DesiredCollectorService(ovnRecon *reconv1alpha1.OvnRecon) *corev1.Service {
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
func DesiredService(ovnRecon *reconv1alpha1.OvnRecon) *corev1.Service {
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
			Selector: labelsForOvnRecon(ovnRecon.Name),
			Ports: []corev1.ServicePort{{
				Port:       9443,
				TargetPort: intstr.FromInt32(9443),
				Name:       "https",
			}},
		},
	}
}

func collectorImageRepositoryFor(ovnRecon *reconv1alpha1.OvnRecon) string {
	if ovnRecon.Spec.CollectorImage.Repository != "" {
		return ovnRecon.Spec.CollectorImage.Repository
	}
	return defaultCollectorRepository
}

func collectorImageTagFor(ovnRecon *reconv1alpha1.OvnRecon) string {
	if ovnRecon.Spec.CollectorImage.Tag != "" {
		return ovnRecon.Spec.CollectorImage.Tag
	}
	// Inherit plugin image tag behavior by default.
	return imageTagFor(ovnRecon)
}

func collectorImagePullPolicyFor(ovnRecon *reconv1alpha1.OvnRecon) corev1.PullPolicy {
	if ovnRecon.Spec.CollectorImage.PullPolicy != "" {
		return corev1.PullPolicy(ovnRecon.Spec.CollectorImage.PullPolicy)
	}
	if ovnRecon.Spec.Image.PullPolicy != "" {
		return corev1.PullPolicy(ovnRecon.Spec.Image.PullPolicy)
	}
	return corev1.PullIfNotPresent
}

// DesiredConsolePlugin renders the ConsolePlugin for a given OvnRecon instance.
func DesiredConsolePlugin(ovnRecon *reconv1alpha1.OvnRecon) *unstructured.Unstructured {
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
