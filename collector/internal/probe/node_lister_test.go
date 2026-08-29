package probe

import (
	"context"
	"log/slog"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
	k8stesting "k8s.io/client-go/testing"
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

func TestOrderTargetsForCommandFrontsDatabaseContainer(t *testing.T) {
	targets := []execTarget{
		{namespace: "ovn", podName: "p", containerName: "ovn-controller"},
		{namespace: "ovn", podName: "p", containerName: "northd"},
		{namespace: "ovn", podName: "p", containerName: "nbdb"},
		{namespace: "ovn", podName: "p", containerName: "sbdb"},
	}

	if got := orderTargetsForCommand(targets, "ovn-nbctl"); got[0].containerName != "nbdb" {
		t.Fatalf("ovn-nbctl should try nbdb first, got %q", got[0].containerName)
	}
	if got := orderTargetsForCommand(targets, "ovn-sbctl"); got[0].containerName != "sbdb" {
		t.Fatalf("ovn-sbctl should try sbdb first, got %q", got[0].containerName)
	}
	if got := orderTargetsForCommand(targets, "ip"); got[0].containerName != "ovn-controller" {
		t.Fatalf("unknown commands keep original order, got %q", got[0].containerName)
	}
}

func TestRunnerResolvesExecTargetsOnce(t *testing.T) {
	clientset := fake.NewSimpleClientset(
		runningPodOnNode("openshift-ovn-kubernetes", "ovnkube-node-a", "worker-a"),
	)
	listCount := 0
	clientset.Fake.PrependReactor("list", "pods", func(k8stesting.Action) (bool, runtime.Object, error) {
		listCount++
		return false, nil, nil
	})

	runner := &KubernetesExecRunner{
		clientset:        clientset,
		restConfig:       &rest.Config{Host: "https://example.invalid"},
		targetNamespaces: []string{"openshift-ovn-kubernetes"},
		nodeName:         "worker-a",
		logger:           slog.Default(),
		execPod: func(_ context.Context, _, _, _ string, _ []string) (string, string, error) {
			return `{"headings":["_uuid"],"data":[]}`, "", nil
		},
	}

	for i := 0; i < 7; i++ {
		if _, err := runner.Run(context.Background(), []string{"ovn-nbctl", "--format=json", "list", "Logical_Router"}); err != nil {
			t.Fatalf("run %d failed: %v", i, err)
		}
	}
	if listCount != 1 {
		t.Fatalf("expected one pod listing across a runner's lifetime, got %d", listCount)
	}
}
