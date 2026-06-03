package probe

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
	k8stesting "k8s.io/client-go/testing"
)

func TestKubernetesExecRunnerFactoryRunnerForNodeValidation(t *testing.T) {
	factory := NewKubernetesExecRunnerFactory(nil, nil, []string{"openshift-ovn-kubernetes"}, slog.Default())
	if _, err := factory.RunnerForNode("worker-a"); err == nil {
		t.Fatalf("expected error when kubernetes client is not configured")
	}

	factory = NewKubernetesExecRunnerFactory(fake.NewSimpleClientset(), &rest.Config{Host: "https://example.invalid"}, []string{"openshift-ovn-kubernetes"}, slog.Default())
	if _, err := factory.RunnerForNode("   "); err == nil {
		t.Fatalf("expected error for empty node name")
	}
}

func TestKubernetesExecRunnerResolveExecTargetsPrefersSameNode(t *testing.T) {
	clientset := fake.NewSimpleClientset(
		newRunningPod("openshift-ovn-kubernetes", "ovnkube-node-a", "worker-a", []string{"ovn-controller", "nbdb"}),
		newRunningPod("openshift-ovn-kubernetes", "ovnkube-node-b", "worker-b", []string{"ovn-controller", "nbdb"}),
	)

	runner := &KubernetesExecRunner{
		clientset:        clientset,
		restConfig:       &rest.Config{Host: "https://example.invalid"},
		targetNamespaces: []string{"openshift-ovn-kubernetes"},
		nodeName:         "worker-a",
		logger:           slog.Default(),
	}

	targets, err := runner.resolveExecTargets(context.Background())
	if err != nil {
		t.Fatalf("resolveExecTargets returned error: %v", err)
	}
	if len(targets) == 0 {
		t.Fatalf("expected at least one target")
	}
	if targets[0].podName != "ovnkube-node-a" {
		t.Fatalf("expected first target pod on requested node, got %q", targets[0].podName)
	}
}

func TestKubernetesExecRunnerResolveExecTargetsReturnsErrorWhenNoPods(t *testing.T) {
	runner := &KubernetesExecRunner{
		clientset:        fake.NewSimpleClientset(),
		restConfig:       &rest.Config{Host: "https://example.invalid"},
		targetNamespaces: []string{"openshift-ovn-kubernetes"},
		nodeName:         "worker-a",
		logger:           slog.Default(),
	}

	if _, err := runner.resolveExecTargets(context.Background()); err == nil {
		t.Fatalf("expected error when no probe targets are available")
	}
}

func TestKubernetesExecRunnerResolveExecTargetsSkipsMissingFRRNamespace(t *testing.T) {
	clientset := fake.NewSimpleClientset(
		newRunningPod("openshift-ovn-kubernetes", "ovnkube-node-a", "worker-a", []string{"nbdb"}),
	)
	clientset.Fake.PrependReactor("list", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		listAction, ok := action.(k8stesting.ListAction)
		if !ok || listAction.GetNamespace() != "openshift-frr-k8s" {
			return false, nil, nil
		}
		return true, nil, apierrors.NewNotFound(schema.GroupResource{Resource: "namespaces"}, "openshift-frr-k8s")
	})

	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	runner := &KubernetesExecRunner{
		clientset:        clientset,
		restConfig:       &rest.Config{Host: "https://example.invalid"},
		targetNamespaces: []string{"openshift-frr-k8s", "openshift-ovn-kubernetes"},
		nodeName:         "worker-a",
		logger:           logger,
	}

	targets, err := runner.resolveExecTargets(context.Background())
	if err != nil {
		t.Fatalf("resolveExecTargets returned error: %v", err)
	}
	if len(targets) != 1 {
		t.Fatalf("expected one OVN target, got %#v", targets)
	}
	if targets[0].namespace != "openshift-ovn-kubernetes" {
		t.Fatalf("expected OVN namespace target, got %#v", targets[0])
	}
	logOutput := buf.String()
	if !strings.Contains(logOutput, "openshift-frr-k8s") || !strings.Contains(logOutput, "notFound") {
		t.Fatalf("expected missing FRR namespace warning, got: %s", logOutput)
	}
}

func TestKubernetesExecRunnerCollectsSnapshotWhenFRRNamespaceIsMissing(t *testing.T) {
	clientset := fake.NewSimpleClientset(
		newRunningPod("openshift-ovn-kubernetes", "ovnkube-node-a", "worker-a", []string{"nbdb"}),
	)
	clientset.Fake.PrependReactor("list", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		listAction, ok := action.(k8stesting.ListAction)
		if !ok || listAction.GetNamespace() != "openshift-frr-k8s" {
			return false, nil, nil
		}
		return true, nil, apierrors.NewNotFound(schema.GroupResource{Resource: "namespaces"}, "openshift-frr-k8s")
	})

	outputs := map[string]string{
		strings.Join(logicalRouterCommand, " "):     `{"headings":["_uuid","name","ports"],"data":[[["uuid","lr-1"],"cluster-router",["set",[["uuid","lrp-1"]]]]]}`,
		strings.Join(logicalRouterPortCommand, " "): `{"headings":["_uuid","name"],"data":[[["uuid","lrp-1"],"rtos-red"]]}`,
		strings.Join(logicalSwitchCommand, " "):     `{"headings":["_uuid","name","ports"],"data":[[["uuid","ls-1"],"red-net",["set",[["uuid","lsp-r"]]]]]}`,
		strings.Join(logicalSwitchPortCommand, " "): `{"headings":["_uuid","name","type","options"],"data":[[["uuid","lsp-r"],"red-router-port","router",["map",[["router-port","rtos-red"]]]]]}`,
	}

	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	runner := &KubernetesExecRunner{
		clientset:        clientset,
		restConfig:       &rest.Config{Host: "https://example.invalid"},
		targetNamespaces: []string{"openshift-frr-k8s", "openshift-ovn-kubernetes"},
		nodeName:         "worker-a",
		logger:           logger,
		execPod: func(_ context.Context, namespace, _, _ string, command []string) (string, string, error) {
			if namespace != "openshift-ovn-kubernetes" {
				t.Fatalf("expected exec only in OVN namespace, got %q", namespace)
			}
			output, ok := outputs[strings.Join(command, " ")]
			if !ok {
				t.Fatalf("unexpected command: %v", command)
			}
			return output, "", nil
		},
	}

	snapshot, err := CollectSnapshotWithOptions(context.Background(), runner, "worker-a", time.Date(2026, 6, 3, 12, 0, 0, 0, time.UTC), CollectOptions{
		Logger: logger,
	})
	if err != nil {
		t.Fatalf("collect snapshot failed: %v", err)
	}
	if snapshot.Metadata.SourceHealth != "healthy" {
		t.Fatalf("expected healthy snapshot from available OVN target, got %q", snapshot.Metadata.SourceHealth)
	}
	if len(snapshot.Warnings) != 0 {
		t.Fatalf("expected no snapshot warnings for optional FRR namespace, got %#v", snapshot.Warnings)
	}
	if len(snapshot.Nodes) == 0 {
		t.Fatalf("expected topology nodes")
	}
	logOutput := buf.String()
	if !strings.Contains(logOutput, "openshift-frr-k8s") || !strings.Contains(logOutput, "notFound") {
		t.Fatalf("expected missing FRR namespace warning, got: %s", logOutput)
	}
}

func TestKubernetesExecRunnerResolveExecTargetsSkipsEmptyFRRNamespace(t *testing.T) {
	clientset := fake.NewSimpleClientset(
		newRunningPod("openshift-ovn-kubernetes", "ovnkube-node-a", "worker-a", []string{"nbdb"}),
	)

	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	runner := &KubernetesExecRunner{
		clientset:        clientset,
		restConfig:       &rest.Config{Host: "https://example.invalid"},
		targetNamespaces: []string{"openshift-frr-k8s", "openshift-ovn-kubernetes"},
		nodeName:         "worker-a",
		logger:           logger,
	}

	targets, err := runner.resolveExecTargets(context.Background())
	if err != nil {
		t.Fatalf("resolveExecTargets returned error: %v", err)
	}
	if len(targets) != 1 || targets[0].namespace != "openshift-ovn-kubernetes" {
		t.Fatalf("expected one OVN target, got %#v", targets)
	}
	logOutput := buf.String()
	if !strings.Contains(logOutput, "openshift-frr-k8s") || !strings.Contains(logOutput, "no running pods") {
		t.Fatalf("expected empty FRR namespace warning, got: %s", logOutput)
	}
}

func newRunningPod(namespace, name, nodeName string, containers []string) *corev1.Pod {
	podContainers := make([]corev1.Container, 0, len(containers))
	for _, container := range containers {
		podContainers = append(podContainers, corev1.Container{Name: container})
	}

	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: namespace,
			Name:      name,
		},
		Spec: corev1.PodSpec{
			NodeName:   nodeName,
			Containers: podContainers,
		},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning,
		},
	}
}
