package controller

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"testing"

	reconv1beta1 "github.com/dlbewley/ovn-recon-operator/api/v1beta1"
)

func TestPluginImageDefaults(t *testing.T) {
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

func TestDesiredDeploymentUsesPluginImageFallbacks(t *testing.T) {
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

	dep := DesiredCollectorDeployment(cr)
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

	dep := DesiredCollectorDeployment(cr)
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
			CollectorImage: reconv1beta1.CollectorImageSpec{
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
