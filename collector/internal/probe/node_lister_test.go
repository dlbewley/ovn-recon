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

func runningPodOnNode(namespace, name, nodeName string) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name},
		Spec: corev1.PodSpec{
			NodeName:   nodeName,
			Containers: []corev1.Container{{Name: "nbdb"}},
		},
		Status: corev1.PodStatus{Phase: corev1.PodRunning},
	}
}

func TestListNodesDiscoversFromFirstPopulatedNamespace(t *testing.T) {
	clientset := fake.NewSimpleClientset(
		runningPodOnNode("openshift-ovn-kubernetes", "ovnkube-node-a", "worker-a"),
		runningPodOnNode("openshift-ovn-kubernetes", "ovnkube-node-b", "worker-b"),
		runningPodOnNode("openshift-ovn-kubernetes", "ovnkube-node-a2", "worker-a"),
		// FRR namespace pods must not add nodes when OVN namespace answers.
		runningPodOnNode("openshift-frr-k8s", "frr-c", "worker-c"),
	)

	factory := NewKubernetesExecRunnerFactory(
		clientset,
		&rest.Config{Host: "https://example.invalid"},
		[]string{"openshift-ovn-kubernetes", "openshift-frr-k8s"},
		slog.Default(),
	)

	nodes, err := factory.ListNodes(context.Background())
	if err != nil {
		t.Fatalf("list nodes failed: %v", err)
	}
	if len(nodes) != 2 || nodes[0] != "worker-a" || nodes[1] != "worker-b" {
		t.Fatalf("unexpected nodes: %v", nodes)
	}
}

func TestListNodesFailsWhenNoPodsExist(t *testing.T) {
	factory := NewKubernetesExecRunnerFactory(
		fake.NewSimpleClientset(),
		&rest.Config{Host: "https://example.invalid"},
		[]string{"openshift-ovn-kubernetes"},
		slog.Default(),
	)

	if _, err := factory.ListNodes(context.Background()); err == nil {
		t.Fatal("expected error when no pods are running")
	}
}
