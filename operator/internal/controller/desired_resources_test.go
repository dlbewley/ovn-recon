package controller

import (
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"testing"

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
			CollectorProbeNamespaces: []string{"legacy-ns"},
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

func TestCollectorCacheDefaultsToEmptyDirWithFloorTTL(t *testing.T) {
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
	if len(dep.Spec.Template.Spec.Volumes) != 1 || dep.Spec.Template.Spec.Volumes[0].EmptyDir == nil {
		t.Fatalf("expected EmptyDir cache volume, got %#v", dep.Spec.Template.Spec.Volumes)
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

	// PVC mode without a claim name falls back to EmptyDir rather than
	// rendering an unmountable volume.
	cr.Spec.Collector.Cache.Storage.ClaimName = ""
	dep = DesiredCollectorDeployment(cr, nil)
	if dep.Spec.Template.Spec.Volumes[0].EmptyDir == nil {
		t.Fatalf("expected EmptyDir fallback, got %#v", dep.Spec.Template.Spec.Volumes)
	}
}

func TestCollectorRolloutStrategyFollowsCacheVolume(t *testing.T) {
	emptyDirCR := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
		Spec:       reconv1beta1.OvnReconSpec{TargetNamespace: "ovn-recon"},
	}
	if dep := DesiredCollectorDeployment(emptyDirCR, nil); dep.Spec.Strategy.Type == appsv1.RecreateDeploymentStrategyType {
		t.Fatal("EmptyDir cache must keep the default RollingUpdate strategy")
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
	if dep := DesiredCollectorDeployment(pvcCR, rwoPVC); dep.Spec.Strategy.Type != appsv1.RecreateDeploymentStrategyType {
		t.Fatal("RWO PVC cache must use Recreate")
	}

	rwxPVC := &corev1.PersistentVolumeClaim{
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce, corev1.ReadWriteMany},
		},
	}
	if dep := DesiredCollectorDeployment(pvcCR, rwxPVC); dep.Spec.Strategy.Type == appsv1.RecreateDeploymentStrategyType {
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
					Storage: reconv1beta1.CollectorCacheStorageSpec{Managed: true},
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

func TestManagedCacheImpliesPVCVolumeAndRecreate(t *testing.T) {
	cr := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
		Spec: reconv1beta1.OvnReconSpec{
			TargetNamespace: "ovn-recon",
			Collector: reconv1beta1.CollectorSpec{
				Cache: reconv1beta1.CollectorCacheSpec{
					// Mode left at its EmptyDir default: managed implies PVC.
					Storage: reconv1beta1.CollectorCacheStorageSpec{Managed: true},
				},
			},
		},
	}

	if !collectorCacheUsesPVC(cr) {
		t.Fatal("managed cache must be PVC-backed regardless of mode")
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
	if dep := DesiredCollectorDeployment(cr, rwoPVC); dep.Spec.Strategy.Type != appsv1.RecreateDeploymentStrategyType {
		t.Fatal("managed RWO cache must use Recreate")
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
