package controller

import (
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	reconv1beta1 "github.com/dlbewley/ovn-recon-operator/api/v1beta1"
)

func TestPluginImageDefaults(t *testing.T) {
	t.Setenv("OPERATOR_VERSION", "")
	cr := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "test"},
	}

	if got := imageRepositoryFor(cr); got != "quay.io/dbewley/ovn-recon" {
		t.Fatalf("unexpected plugin repository default: %s", got)
	}
	if got := imageTagFor(cr); got != "latest" {
		t.Fatalf("unexpected plugin tag default: %s", got)
	}
	if got := imagePullPolicyFor(cr); got != corev1.PullIfNotPresent {
		t.Fatalf("unexpected plugin pullPolicy default: %s", got)
	}
}

func TestPluginImageDefaultsToOperatorVersion(t *testing.T) {
	t.Setenv("OPERATOR_VERSION", "v1.2.3")
	cr := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "test"},
	}

	if got := imageTagFor(cr); got != "v1.2.3" {
		t.Fatalf("unexpected plugin tag default from OPERATOR_VERSION: %s", got)
	}
}

func TestPluginImageDefaultsToNormalizedOperatorVersion(t *testing.T) {
	t.Setenv("OPERATOR_VERSION", "v1.2.3:quay.io/dbewley/ovn-recon-operator:v1.2.3")
	cr := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "test"},
	}

	if got := imageTagFor(cr); got != "v1.2.3" {
		t.Fatalf("unexpected plugin tag default from normalized OPERATOR_VERSION: %s", got)
	}
}

func TestOperatorVersionAnnotationsNormalizeOperatorVersion(t *testing.T) {
	t.Setenv("OPERATOR_VERSION", "v1.2.3:quay.io/dbewley/ovn-recon-operator:v1.2.3")

	got := operatorVersionAnnotations()["ovnrecon.bewley.net/operator-version"]
	if got != "v1.2.3" {
		t.Fatalf("unexpected operator version annotation value: %s", got)
	}
}

func TestDesiredDeploymentUsesPluginImageFallbacks(t *testing.T) {
	t.Setenv("OPERATOR_VERSION", "")
	cr := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
	}

	deployment := DesiredDeployment(cr)
	container := deployment.Spec.Template.Spec.Containers[0]
	if container.Image != "quay.io/dbewley/ovn-recon:latest" {
		t.Fatalf("unexpected plugin image: %s", container.Image)
	}
	if container.ImagePullPolicy != corev1.PullIfNotPresent {
		t.Fatalf("unexpected plugin pullPolicy: %s", container.ImagePullPolicy)
	}
	if got, ok := envValue(container.Env, "OVN_RECON_NGINX_ERROR_LOG_LEVEL"); !ok || got != "info" {
		t.Fatalf("expected default nginx error log level env=info, got %q (present=%v)", got, ok)
	}
	if got, ok := envValue(container.Env, "OVN_RECON_NGINX_ACCESS_LOG"); !ok || got != "off" {
		t.Fatalf("expected default nginx access log env=off, got %q (present=%v)", got, ok)
	}
	if deployment.Spec.Selector == nil {
		t.Fatalf("expected deployment selector to be set")
	}
	if got := deployment.Spec.Selector.MatchLabels["app.kubernetes.io/component"]; got != "plugin" {
		t.Fatalf("expected plugin deployment selector component=plugin, got %q", got)
	}
}

func TestConsolePluginLoggingEnvOverrides(t *testing.T) {
	cr := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
		Spec: reconv1beta1.OvnReconSpec{
			ConsolePlugin: reconv1beta1.ConsolePluginSpec{
				Logging: reconv1beta1.ConsolePluginLoggingSpec{
					Level: "debug",
					AccessLog: reconv1beta1.AccessLogSpec{
						Enabled: true,
					},
				},
			},
		},
	}

	deployment := DesiredDeployment(cr)
	container := deployment.Spec.Template.Spec.Containers[0]
	if got, ok := envValue(container.Env, "OVN_RECON_NGINX_ERROR_LOG_LEVEL"); !ok || got != "debug" {
		t.Fatalf("expected nginx error log level env=debug, got %q (present=%v)", got, ok)
	}
	if got, ok := envValue(container.Env, "OVN_RECON_NGINX_ACCESS_LOG"); !ok || got != "/dev/stdout main" {
		t.Fatalf("expected nginx access log env=\"/dev/stdout main\", got %q (present=%v)", got, ok)
	}
}

func TestCollectorImageInheritance(t *testing.T) {
	cr := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "test"},
		Spec: reconv1beta1.OvnReconSpec{
			ConsolePlugin: reconv1beta1.ConsolePluginSpec{
				Image: reconv1beta1.ImageSpec{
					Repository: "quay.io/dbewley/ovn-recon",
					Tag:        "v1.2.3",
					PullPolicy: string(corev1.PullAlways),
				},
			},
		},
	}

	if got := collectorImageRepositoryFor(cr); got != "quay.io/dbewley/ovn-collector" {
		t.Fatalf("unexpected collector repository: %s", got)
	}
	if got := collectorImageTagFor(cr); got != "v1.2.3" {
		t.Fatalf("collector tag should inherit image.tag, got: %s", got)
	}
	if got := collectorImagePullPolicyFor(cr); got != corev1.PullAlways {
		t.Fatalf("collector pullPolicy should inherit image.pullPolicy, got: %s", got)
	}
}

func TestCollectorImageOverrides(t *testing.T) {
	cr := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "test"},
		Spec: reconv1beta1.OvnReconSpec{
			ConsolePlugin: reconv1beta1.ConsolePluginSpec{
				Image: reconv1beta1.ImageSpec{
					Tag:        "v1.2.3",
					PullPolicy: string(corev1.PullIfNotPresent),
				},
			},
			Collector: reconv1beta1.CollectorSpec{
				Image: reconv1beta1.CollectorImageSpec{
					Repository: "quay.io/acme/custom-collector",
					Tag:        "collector-tag",
					PullPolicy: string(corev1.PullNever),
				},
			},
		},
	}

	if got := collectorImageRepositoryFor(cr); got != "quay.io/acme/custom-collector" {
		t.Fatalf("collector repository override not applied: %s", got)
	}
	if got := collectorImageTagFor(cr); got != "collector-tag" {
		t.Fatalf("collector tag override not applied: %s", got)
	}
	if got := collectorImagePullPolicyFor(cr); got != corev1.PullNever {
		t.Fatalf("collector pullPolicy override not applied: %s", got)
	}
}

func TestCollectorDesiredResourcesNamesAndPorts(t *testing.T) {
	cr := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
		Spec: reconv1beta1.OvnReconSpec{
			TargetNamespace: "ovn-recon",
		},
	}

	dep := DesiredCollectorDeployment(cr, nil)
	if dep.Name != "ovn-recon-collector" {
		t.Fatalf("unexpected collector deployment name: %s", dep.Name)
	}
	if len(dep.Spec.Template.Spec.Containers) != 1 {
		t.Fatalf("expected one collector container")
	}
	if dep.Spec.Template.Spec.ServiceAccountName != "ovn-recon-collector" {
		t.Fatalf("unexpected collector service account: %s", dep.Spec.Template.Spec.ServiceAccountName)
	}
	if dep.Spec.Template.Spec.Containers[0].Name != "ovn-collector" {
		t.Fatalf("unexpected collector container name: %s", dep.Spec.Template.Spec.Containers[0].Name)
	}
	if dep.Spec.Template.Spec.Containers[0].Ports[0].ContainerPort != 8090 {
		t.Fatalf("unexpected collector port")
	}
	if got, ok := envValue(dep.Spec.Template.Spec.Containers[0].Env, "COLLECTOR_LOG_LEVEL"); !ok || got != "info" {
		t.Fatalf("expected default collector log level env=info, got %q (present=%v)", got, ok)
	}
	if got, ok := envValue(dep.Spec.Template.Spec.Containers[0].Env, "COLLECTOR_INCLUDE_PROBE_OUTPUT"); !ok || got != "false" {
		t.Fatalf("expected default include-probe-output env=false, got %q (present=%v)", got, ok)
	}

	svc := DesiredCollectorService(cr)
	if svc.Name != "ovn-recon-collector" {
		t.Fatalf("unexpected collector service name: %s", svc.Name)
	}
	if svc.Spec.Ports[0].Port != 8090 {
		t.Fatalf("unexpected collector service port")
	}
}

func TestPluginServiceSelectorTargetsPluginComponentOnly(t *testing.T) {
	cr := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
		Spec: reconv1beta1.OvnReconSpec{
			TargetNamespace: "ovn-recon",
		},
	}

	svc := DesiredService(cr)
	if svc.Spec.Selector["app.kubernetes.io/name"] != "ovn-recon" {
		t.Fatalf("unexpected selector app name: %#v", svc.Spec.Selector)
	}
	if svc.Spec.Selector["app.kubernetes.io/instance"] != "ovn-recon" {
		t.Fatalf("unexpected selector instance: %#v", svc.Spec.Selector)
	}
	if svc.Spec.Selector["app.kubernetes.io/component"] != "plugin" {
		t.Fatalf("expected plugin component selector, got %#v", svc.Spec.Selector)
	}
}

func TestCollectorLoggingEnvOverrides(t *testing.T) {
	cr := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
		Spec: reconv1beta1.OvnReconSpec{
			Collector: reconv1beta1.CollectorSpec{
				Logging: reconv1beta1.CollectorLoggingSpec{
					Level:              "trace",
					IncludeProbeOutput: true,
				},
			},
		},
	}

	dep := DesiredCollectorDeployment(cr, nil)
	env := dep.Spec.Template.Spec.Containers[0].Env

	if got, ok := envValue(env, "COLLECTOR_LOG_LEVEL"); !ok || got != "trace" {
		t.Fatalf("expected collector log level env=trace, got %q (present=%v)", got, ok)
	}
	if got, ok := envValue(env, "COLLECTOR_INCLUDE_PROBE_OUTPUT"); !ok || got != "true" {
		t.Fatalf("expected include-probe-output env=true, got %q (present=%v)", got, ok)
	}
}

func TestCollectorProbeNamespacesDefaultsAndOverrides(t *testing.T) {
	defaultCR := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
	}
	defaults := collectorProbeNamespacesFor(defaultCR)
	if len(defaults) != 2 {
		t.Fatalf("expected 2 default probe namespaces, got %d", len(defaults))
	}
	if defaults[0] != "openshift-ovn-kubernetes" || defaults[1] != "openshift-frr-k8s" {
		t.Fatalf("unexpected default probe namespaces: %#v", defaults)
	}

	overrideCR := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
		Spec: reconv1beta1.OvnReconSpec{
			Collector: reconv1beta1.CollectorSpec{
				ProbeNamespaces: []string{"custom-a", "custom-b"},
			},
		},
	}
	overrides := collectorProbeNamespacesFor(overrideCR)
	if len(overrides) != 2 || overrides[0] != "custom-a" || overrides[1] != "custom-b" {
		t.Fatalf("unexpected override probe namespaces: %#v", overrides)
	}
}

func TestHierarchicalFieldsTakePrecedenceOverLegacy(t *testing.T) {
	cr := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "test"},
		Spec: reconv1beta1.OvnReconSpec{
			ConsolePlugin: reconv1beta1.ConsolePluginSpec{
				Image: reconv1beta1.ImageSpec{
					Repository: "quay.io/example/new-plugin",
					Tag:        "new-tag",
					PullPolicy: string(corev1.PullAlways),
				},
			},
			Collector: reconv1beta1.CollectorSpec{
				Image: reconv1beta1.CollectorImageSpec{
					Repository: "quay.io/example/new-collector",
					Tag:        "collector-new-tag",
					PullPolicy: string(corev1.PullNever),
				},
				ProbeNamespaces: []string{"new-ns"},
			},
			Image: reconv1beta1.ImageSpec{
				Repository: "quay.io/example/legacy-plugin",
				Tag:        "legacy-tag",
				PullPolicy: string(corev1.PullIfNotPresent),
			},
			CollectorImage: reconv1beta1.LegacyCollectorImageSpec{
				Repository: "quay.io/example/legacy-collector",
				Tag:        "collector-legacy-tag",
				PullPolicy: string(corev1.PullIfNotPresent),
			},
		},
	}

	if got := imageRepositoryFor(cr); got != "quay.io/example/new-plugin" {
		t.Fatalf("unexpected plugin repository precedence: %s", got)
	}
	if got := imageTagFor(cr); got != "new-tag" {
		t.Fatalf("unexpected plugin tag precedence: %s", got)
	}
	if got := imagePullPolicyFor(cr); got != corev1.PullAlways {
		t.Fatalf("unexpected plugin pullPolicy precedence: %s", got)
	}
	if got := collectorImageRepositoryFor(cr); got != "quay.io/example/new-collector" {
		t.Fatalf("unexpected collector repository precedence: %s", got)
	}
	if got := collectorImageTagFor(cr); got != "collector-new-tag" {
		t.Fatalf("unexpected collector tag precedence: %s", got)
	}
	if got := collectorImagePullPolicyFor(cr); got != corev1.PullNever {
		t.Fatalf("unexpected collector pullPolicy precedence: %s", got)
	}
	if got := collectorProbeNamespacesFor(cr); len(got) != 1 || got[0] != "new-ns" {
		t.Fatalf("unexpected collector probe namespace precedence: %#v", got)
	}
}

func TestCollectorEnabledPrefersHierarchicalOverFeatureGate(t *testing.T) {
	trueValue := true
	falseValue := false

	newDisabledLegacyEnabled := &reconv1beta1.OvnRecon{
		Spec: reconv1beta1.OvnReconSpec{
			Collector: reconv1beta1.CollectorSpec{
				Enabled: &falseValue,
			},
			FeatureGates: reconv1beta1.FeatureGateSpec{
				OVNCollector: true,
			},
		},
	}
	if collectorFeatureEnabled(newDisabledLegacyEnabled) {
		t.Fatalf("collector.enabled=false should override legacy feature gate")
	}

	newUnsetLegacyEnabled := &reconv1beta1.OvnRecon{
		Spec: reconv1beta1.OvnReconSpec{
			Collector: reconv1beta1.CollectorSpec{
				Enabled: nil,
			},
			FeatureGates: reconv1beta1.FeatureGateSpec{
				OVNCollector: true,
			},
		},
	}
	if !collectorFeatureEnabled(newUnsetLegacyEnabled) {
		t.Fatalf("legacy feature gate should be honored when collector.enabled is unset")
	}

	newEnabledLegacyDisabled := &reconv1beta1.OvnRecon{
		Spec: reconv1beta1.OvnReconSpec{
			Collector: reconv1beta1.CollectorSpec{
				Enabled: &trueValue,
			},
			FeatureGates: reconv1beta1.FeatureGateSpec{
				OVNCollector: false,
			},
		},
	}
	if !collectorFeatureEnabled(newEnabledLegacyDisabled) {
		t.Fatalf("collector.enabled=true should override legacy feature gate")
	}
}

func envValue(envVars []corev1.EnvVar, name string) (string, bool) {
	for _, env := range envVars {
		if env.Name == name {
			return env.Value, true
		}
	}
	return "", false
}

func TestPluginImageUsesRelatedImageWhenCRSaysNothing(t *testing.T) {
	t.Setenv("OPERATOR_VERSION", "v1.2.3")
	t.Setenv("RELATED_IMAGE_PLUGIN", "registry.mirror.example/ovn-recon@sha256:abc")
	cr := &reconv1beta1.OvnRecon{}
	if got := pluginImageFor(cr); got != "registry.mirror.example/ovn-recon@sha256:abc" {
		t.Fatalf("expected the related image, got %s", got)
	}
}

func TestPluginImageCROverrideBeatsRelatedImage(t *testing.T) {
	t.Setenv("OPERATOR_VERSION", "v1.2.3")
	t.Setenv("RELATED_IMAGE_PLUGIN", "registry.mirror.example/ovn-recon@sha256:abc")
	cr := &reconv1beta1.OvnRecon{}
	cr.Spec.ConsolePlugin.Image.Tag = "pinned"
	// A user pinning a tag must keep the composed behaviour, not silently get
	// the mirrored digest instead.
	if got := pluginImageFor(cr); got != "quay.io/dbewley/ovn-recon:pinned" {
		t.Fatalf("CR override should win, got %s", got)
	}
}

func TestPluginImageFallsBackToComposedDefault(t *testing.T) {
	t.Setenv("OPERATOR_VERSION", "v1.2.3")
	t.Setenv("RELATED_IMAGE_PLUGIN", "")
	cr := &reconv1beta1.OvnRecon{}
	if got := pluginImageFor(cr); got != "quay.io/dbewley/ovn-recon:v1.2.3" {
		t.Fatalf("expected the composed default, got %s", got)
	}
}

func TestCollectorImageUsesRelatedImageWhenCRSaysNothing(t *testing.T) {
	t.Setenv("OPERATOR_VERSION", "v1.2.3")
	t.Setenv("RELATED_IMAGE_COLLECTOR", "registry.mirror.example/ovn-collector@sha256:def")
	cr := &reconv1beta1.OvnRecon{}
	if got := collectorImageFor(cr); got != "registry.mirror.example/ovn-collector@sha256:def" {
		t.Fatalf("expected the related image, got %s", got)
	}
}

func TestCollectorImageIgnoresRelatedImageWhenPluginTagPinned(t *testing.T) {
	t.Setenv("OPERATOR_VERSION", "v1.2.3")
	t.Setenv("RELATED_IMAGE_COLLECTOR", "registry.mirror.example/ovn-collector@sha256:def")
	cr := &reconv1beta1.OvnRecon{}
	cr.Spec.ConsolePlugin.Image.Tag = "pinned"
	// collectorImageTagFor inherits the plugin tag, so a pinned plugin tag must
	// keep the collector composed too -- otherwise the two disagree, which is
	// exactly what put the collector into ImagePullBackOff during 4.22 testing.
	if got := collectorImageFor(cr); got != "quay.io/dbewley/ovn-collector:pinned" {
		t.Fatalf("plugin tag should still drive the collector, got %s", got)
	}
}

func TestCollectorCacheDefaultsToManagedPVCWithFloorTTL(t *testing.T) {
	cr := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
		Spec:       reconv1beta1.OvnReconSpec{TargetNamespace: "ovn-recon"},
	}

	dep := DesiredCollectorDeployment(cr, nil)
	container := dep.Spec.Template.Spec.Containers[0]

	if got, ok := envValue(container.Env, "COLLECTOR_CACHE_DIR"); !ok || got != "/var/cache/ovn-recon" {
		t.Fatalf("expected cache dir env, got %q (present=%v)", got, ok)
	}
	if got, ok := envValue(container.Env, "COLLECTOR_CACHE_TTL_SECONDS"); !ok || got != "120" {
		t.Fatalf("expected default cache TTL 120, got %q (present=%v)", got, ok)
	}
	if len(container.VolumeMounts) != 1 || container.VolumeMounts[0].MountPath != "/var/cache/ovn-recon" {
		t.Fatalf("expected cache volume mount, got %#v", container.VolumeMounts)
	}
	// Bare spec: managed defaults true and mode defaults auto, so the
	// spec-optimistic render mounts the managed default claim.
	volumes := dep.Spec.Template.Spec.Volumes
	if len(volumes) != 1 || volumes[0].PersistentVolumeClaim == nil ||
		volumes[0].PersistentVolumeClaim.ClaimName != "ovn-recon-collector-cache" {
		t.Fatalf("expected managed default claim volume, got %#v", volumes)
	}
	// A resolved EmptyDir fallback renders EmptyDir for the same spec.
	dep = DesiredCollectorDeployment(cr, &collectorCacheStorage{fallbackReason: "no viable StorageClass"})
	if dep.Spec.Template.Spec.Volumes[0].EmptyDir == nil {
		t.Fatalf("expected EmptyDir volume after fallback, got %#v", dep.Spec.Template.Spec.Volumes)
	}
}

func TestCollectorCacheDisabled(t *testing.T) {
	disabled := false
	cr := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
		Spec: reconv1beta1.OvnReconSpec{
			TargetNamespace: "ovn-recon",
			Collector: reconv1beta1.CollectorSpec{
				Cache: reconv1beta1.CollectorCacheSpec{Enabled: &disabled},
			},
		},
	}

	dep := DesiredCollectorDeployment(cr, nil)
	container := dep.Spec.Template.Spec.Containers[0]
	if _, ok := envValue(container.Env, "COLLECTOR_CACHE_DIR"); ok {
		t.Fatal("expected no cache dir env when cache disabled")
	}
	if len(container.VolumeMounts) != 0 || len(dep.Spec.Template.Spec.Volumes) != 0 {
		t.Fatalf("expected no cache volume when disabled, got %#v / %#v", container.VolumeMounts, dep.Spec.Template.Spec.Volumes)
	}
}

func TestCollectorCacheTTLClampedToFloor(t *testing.T) {
	cr := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
		Spec: reconv1beta1.OvnReconSpec{
			TargetNamespace: "ovn-recon",
			Collector: reconv1beta1.CollectorSpec{
				Cache: reconv1beta1.CollectorCacheSpec{TTLSeconds: 5},
			},
		},
	}

	dep := DesiredCollectorDeployment(cr, nil)
	if got, ok := envValue(dep.Spec.Template.Spec.Containers[0].Env, "COLLECTOR_CACHE_TTL_SECONDS"); !ok || got != "30" {
		t.Fatalf("expected TTL clamped to 30, got %q (present=%v)", got, ok)
	}
}

func TestCollectorCachePVCStorage(t *testing.T) {
	cr := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
		Spec: reconv1beta1.OvnReconSpec{
			TargetNamespace: "ovn-recon",
			Collector: reconv1beta1.CollectorSpec{
				Cache: reconv1beta1.CollectorCacheSpec{
					Storage: reconv1beta1.CollectorCacheStorageSpec{Mode: "PVC", ClaimName: "snapshot-cache"},
				},
			},
		},
	}

	dep := DesiredCollectorDeployment(cr, nil)
	volumes := dep.Spec.Template.Spec.Volumes
	if len(volumes) != 1 || volumes[0].PersistentVolumeClaim == nil || volumes[0].PersistentVolumeClaim.ClaimName != "snapshot-cache" {
		t.Fatalf("expected PVC cache volume, got %#v", volumes)
	}

	// PVC mode without a claim name mounts the managed default claim —
	// managed defaults to true, so there is always a claim to name.
	cr.Spec.Collector.Cache.Storage.ClaimName = ""
	dep = DesiredCollectorDeployment(cr, nil)
	if got := dep.Spec.Template.Spec.Volumes[0].PersistentVolumeClaim; got == nil || got.ClaimName != "ovn-recon-collector-cache" {
		t.Fatalf("expected managed default claim, got %#v", dep.Spec.Template.Spec.Volumes)
	}
}

func TestCollectorRolloutStrategyFollowsCacheVolume(t *testing.T) {
	emptyDirCR := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
		Spec: reconv1beta1.OvnReconSpec{
			TargetNamespace: "ovn-recon",
			Collector: reconv1beta1.CollectorSpec{
				Cache: reconv1beta1.CollectorCacheSpec{
					Storage: reconv1beta1.CollectorCacheStorageSpec{Mode: "EmptyDir"},
				},
			},
		},
	}
	if dep := DesiredCollectorDeployment(emptyDirCR, nil); dep.Spec.Strategy.Type == appsv1.RecreateDeploymentStrategyType {
		t.Fatal("EmptyDir cache must keep the default RollingUpdate strategy")
	}
	// A resolved EmptyDir fallback also keeps RollingUpdate, whatever the spec asked.
	if dep := DesiredCollectorDeployment(emptyDirCR, &collectorCacheStorage{}); dep.Spec.Strategy.Type == appsv1.RecreateDeploymentStrategyType {
		t.Fatal("resolved EmptyDir storage must keep the default RollingUpdate strategy")
	}

	pvcCR := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
		Spec: reconv1beta1.OvnReconSpec{
			TargetNamespace: "ovn-recon",
			Collector: reconv1beta1.CollectorSpec{
				Cache: reconv1beta1.CollectorCacheSpec{
					Storage: reconv1beta1.CollectorCacheStorageSpec{Mode: "PVC", ClaimName: "collector-cache"},
				},
			},
		},
	}

	// Unresolvable claim: assume non-RWX so a later bind cannot deadlock.
	if dep := DesiredCollectorDeployment(pvcCR, nil); dep.Spec.Strategy.Type != appsv1.RecreateDeploymentStrategyType {
		t.Fatal("PVC cache with unknown claim must use Recreate")
	}

	rwoPVC := &corev1.PersistentVolumeClaim{
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
		},
	}
	if dep := DesiredCollectorDeployment(pvcCR, &collectorCacheStorage{usePVC: true, pvc: rwoPVC}); dep.Spec.Strategy.Type != appsv1.RecreateDeploymentStrategyType {
		t.Fatal("RWO PVC cache must use Recreate")
	}

	rwxPVC := &corev1.PersistentVolumeClaim{
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce, corev1.ReadWriteMany},
		},
	}
	if dep := DesiredCollectorDeployment(pvcCR, &collectorCacheStorage{usePVC: true, pvc: rwxPVC}); dep.Spec.Strategy.Type == appsv1.RecreateDeploymentStrategyType {
		t.Fatal("RWX PVC cache should keep RollingUpdate for zero-gap rollouts")
	}
}

func TestManagedCachePVCRendering(t *testing.T) {
	cr := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
		Spec: reconv1beta1.OvnReconSpec{
			TargetNamespace: "ovn-recon",
			Collector: reconv1beta1.CollectorSpec{
				Cache: reconv1beta1.CollectorCacheSpec{
					Storage: reconv1beta1.CollectorCacheStorageSpec{Managed: boolPtr(true)},
				},
			},
		},
	}

	pvc := DesiredCollectorCachePVC(cr)
	if pvc.Name != "ovn-recon-collector-cache" {
		t.Fatalf("unexpected default claim name: %s", pvc.Name)
	}
	if got := pvc.Spec.Resources.Requests[corev1.ResourceStorage]; got.String() != "1Gi" {
		t.Fatalf("expected default size 1Gi, got %s", got.String())
	}
	if pvc.Spec.StorageClassName != nil {
		t.Fatalf("expected cluster-default storage class, got %v", *pvc.Spec.StorageClassName)
	}
	if len(pvc.Spec.AccessModes) != 1 || pvc.Spec.AccessModes[0] != corev1.ReadWriteOnce {
		t.Fatalf("expected RWO access, got %v", pvc.Spec.AccessModes)
	}
	if pvc.Labels["app.kubernetes.io/component"] != "collector-cache" {
		t.Fatalf("expected collector-cache component label, got %v", pvc.Labels)
	}

	cr.Spec.Collector.Cache.Storage.ClaimName = "custom-cache"
	cr.Spec.Collector.Cache.Storage.Size = "256Mi"
	className := "fast"
	cr.Spec.Collector.Cache.Storage.StorageClassName = className
	pvc = DesiredCollectorCachePVC(cr)
	if pvc.Name != "custom-cache" {
		t.Fatalf("explicit claim name not respected: %s", pvc.Name)
	}
	if got := pvc.Spec.Resources.Requests[corev1.ResourceStorage]; got.String() != "256Mi" {
		t.Fatalf("expected 256Mi, got %s", got.String())
	}
	if pvc.Spec.StorageClassName == nil || *pvc.Spec.StorageClassName != className {
		t.Fatalf("storage class not respected: %v", pvc.Spec.StorageClassName)
	}

	// Garbage size falls back to the default rather than failing render.
	cr.Spec.Collector.Cache.Storage.Size = "a-few-bytes"
	pvc = DesiredCollectorCachePVC(cr)
	if got := pvc.Spec.Resources.Requests[corev1.ResourceStorage]; got.String() != "1Gi" {
		t.Fatalf("expected fallback to 1Gi on unparseable size, got %s", got.String())
	}
}

func boolPtr(b bool) *bool { return &b }

func TestManagedCacheDefaultsToPVCVolumeAndRecreate(t *testing.T) {
	// A bare CR: managed defaults true, mode defaults auto → PVC-backed.
	cr := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
		Spec:       reconv1beta1.OvnReconSpec{TargetNamespace: "ovn-recon"},
	}

	if !collectorCacheWantsPVC(cr) {
		t.Fatal("bare spec must want the managed cache claim (managed and auto defaults)")
	}

	dep := DesiredCollectorDeployment(cr, nil)
	volumes := dep.Spec.Template.Spec.Volumes
	if len(volumes) != 1 || volumes[0].PersistentVolumeClaim == nil ||
		volumes[0].PersistentVolumeClaim.ClaimName != "ovn-recon-collector-cache" {
		t.Fatalf("expected managed default claim mounted, got %#v", volumes)
	}
	// Managed claims are RWO, so the strategy must be Recreate.
	rwoPVC := &corev1.PersistentVolumeClaim{
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
		},
	}
	if dep := DesiredCollectorDeployment(cr, &collectorCacheStorage{usePVC: true, pvc: rwoPVC}); dep.Spec.Strategy.Type != appsv1.RecreateDeploymentStrategyType {
		t.Fatal("managed RWO cache must use Recreate")
	}
}

func TestExplicitModeWinsOverManaged(t *testing.T) {
	// Explicit EmptyDir with managed true must never mount a PVC — the
	// original inconsistency this rework exists to fix.
	cr := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
		Spec: reconv1beta1.OvnReconSpec{
			TargetNamespace: "ovn-recon",
			Collector: reconv1beta1.CollectorSpec{
				Cache: reconv1beta1.CollectorCacheSpec{
					Storage: reconv1beta1.CollectorCacheStorageSpec{Mode: "EmptyDir", Managed: boolPtr(true)},
				},
			},
		},
	}
	if collectorCacheWantsPVC(cr) {
		t.Fatal("explicit EmptyDir must win over managed=true")
	}
	dep := DesiredCollectorDeployment(cr, nil)
	if dep.Spec.Template.Spec.Volumes[0].EmptyDir == nil {
		t.Fatalf("expected EmptyDir volume, got %#v", dep.Spec.Template.Spec.Volumes)
	}

	// Explicit managed=false with mode auto and no claimName: nothing to mount.
	cr.Spec.Collector.Cache.Storage = reconv1beta1.CollectorCacheStorageSpec{Managed: boolPtr(false)}
	if collectorCacheWantsPVC(cr) {
		t.Fatal("auto mode with managed=false and no claimName must use EmptyDir")
	}
}

func TestResolveCollectorCacheStorage(t *testing.T) {
	now := time.Now()
	autoCR := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
		Spec:       reconv1beta1.OvnReconSpec{TargetNamespace: "ovn-recon"},
	}

	boundClaim := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{CreationTimestamp: metav1.NewTime(now.Add(-10 * time.Minute))},
		Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
	}
	youngPending := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{CreationTimestamp: metav1.NewTime(now.Add(-10 * time.Second))},
		Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimPending},
	}
	oldPending := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{CreationTimestamp: metav1.NewTime(now.Add(-10 * time.Minute))},
		Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimPending},
	}

	if got := ResolveCollectorCacheStorage(autoCR, boundClaim, true, now); !got.usePVC || got.fallbackReason != "" {
		t.Fatalf("bound claim must resolve to PVC, got %+v", got)
	}
	if got := ResolveCollectorCacheStorage(autoCR, youngPending, true, now); !got.usePVC {
		t.Fatalf("claim inside bind grace period must stay PVC, got %+v", got)
	}
	if got := ResolveCollectorCacheStorage(autoCR, oldPending, true, now); got.usePVC || got.fallbackReason == "" {
		t.Fatalf("claim unbound past the timeout must fall back with a reason, got %+v", got)
	}
	if got := ResolveCollectorCacheStorage(autoCR, nil, false, now); got.usePVC || got.fallbackReason == "" {
		t.Fatalf("no viable StorageClass must fall back with a reason, got %+v", got)
	}
	if got := ResolveCollectorCacheStorage(autoCR, nil, true, now); !got.usePVC {
		t.Fatalf("managed claim pending creation must resolve to PVC, got %+v", got)
	}
	// A fallback reverses once the claim binds.
	if got := ResolveCollectorCacheStorage(autoCR, boundClaim, false, now); !got.usePVC {
		t.Fatalf("bound claim must win even without a viable class, got %+v", got)
	}

	// Explicit PVC mode never falls back, even unbound past the timeout.
	pvcCR := autoCR.DeepCopy()
	pvcCR.Spec.Collector.Cache.Storage.Mode = "PVC"
	if got := ResolveCollectorCacheStorage(pvcCR, oldPending, false, now); !got.usePVC || got.fallbackReason != "" {
		t.Fatalf("explicit PVC mode must be honored verbatim, got %+v", got)
	}

	// Auto with an unmanaged, missing claim falls back until it exists.
	claimCR := autoCR.DeepCopy()
	claimCR.Spec.Collector.Cache.Storage.Managed = boolPtr(false)
	claimCR.Spec.Collector.Cache.Storage.ClaimName = "user-cache"
	if got := ResolveCollectorCacheStorage(claimCR, nil, true, now); got.usePVC || got.fallbackReason == "" {
		t.Fatalf("missing unmanaged claim must fall back with a reason, got %+v", got)
	}
	if got := ResolveCollectorCacheStorage(claimCR, boundClaim, true, now); !got.usePVC {
		t.Fatalf("bound unmanaged claim must resolve to PVC, got %+v", got)
	}
}

func TestConsolePluginEnabledDefaultsOn(t *testing.T) {
	cr := &reconv1beta1.OvnRecon{ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"}}
	if !consolePluginEnabledFor(cr) {
		t.Fatal("consolePlugin must default to enabled when spec.consolePlugin.enabled is unset")
	}
	cr.Spec.ConsolePlugin.Enabled = boolPtr(false)
	if consolePluginEnabledFor(cr) {
		t.Fatal("explicit enabled=false must disable console registration")
	}
}

func TestCollectorFeatureEnabledDefaultsOn(t *testing.T) {
	cr := &reconv1beta1.OvnRecon{ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"}}
	if !collectorFeatureEnabled(cr) {
		t.Fatal("collector must default to enabled when spec.collector.enabled is unset")
	}

	disabled := false
	cr.Spec.Collector.Enabled = &disabled
	if collectorFeatureEnabled(cr) {
		t.Fatal("explicit enabled=false must disable the collector")
	}

	// The legacy gate's materialized false must not read as an explicit
	// disable — only spec.collector.enabled carries an explicit signal.
	cr.Spec.Collector.Enabled = nil
	cr.Spec.FeatureGates.OVNCollector = false
	if !collectorFeatureEnabled(cr) {
		t.Fatal("legacy featureGates false must not override the default-on")
	}
}
