package probe

import (
	"context"
	"log/slog"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
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
