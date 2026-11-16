package probe

import (
	"context"
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"testing"

	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
)

func TestOrderTargetsForCommandFrontsOVNControllerForOVSAppctl(t *testing.T) {
	targets := []execTarget{
		{namespace: "openshift-ovn-kubernetes", podName: "ovnkube-node-a", containerName: "nbdb"},
		{namespace: "openshift-ovn-kubernetes", podName: "ovnkube-node-a", containerName: "ovnkube-controller"},
		{namespace: "openshift-ovn-kubernetes", podName: "ovnkube-node-a", containerName: "ovn-controller"},
	}
	got := orderTargetsForCommand(targets, ovsBondShowCommand)
	if got[0].containerName != "ovn-controller" {
		t.Fatalf("ovs-appctl should go to ovn-controller first, got %#v", got)
	}
	if len(got) != len(targets) {
		t.Fatalf("ordering must keep every target, got %d of %d", len(got), len(targets))
	}
}

// TestNodeLocalRunnerNeverLeavesTheNode: bond/show read from another
// node's pod would describe that node's bonds, so a node-local runner
// tries only the requested node's containers, ovn-controller first, and
// fails rather than falling back (ovn-recon-1tw.7).
func TestNodeLocalRunnerNeverLeavesTheNode(t *testing.T) {
	clientset := fake.NewSimpleClientset(
		newRunningPod("openshift-ovn-kubernetes", "ovnkube-node-a", "worker-a", []string{"nbdb", "ovn-controller"}),
		newRunningPod("openshift-ovn-kubernetes", "ovnkube-node-b", "worker-b", []string{"nbdb", "ovn-controller"}),
	)
	factory := NewKubernetesExecRunnerFactory(clientset, &rest.Config{Host: "https://example.invalid"}, []string{"openshift-ovn-kubernetes"}, slog.Default())

	runner, err := factory.NodeLocalRunnerForNode("worker-a")
	if err != nil {
		t.Fatalf("NodeLocalRunnerForNode: %v", err)
	}
	var tried []string
	runner.(*KubernetesExecRunner).execPod = func(_ context.Context, _, pod, container string, command []string) (string, string, error) {
		tried = append(tried, pod+"/"+container)
		return "", "socket missing", errors.New("exit 1")
	}
	if _, err := runner.Run(context.Background(), ovsBondShowCommand); err == nil {
		t.Fatalf("expected the run to fail when every container on the node fails")
	}
	want := []string{"ovnkube-node-a/ovn-controller", "ovnkube-node-a/nbdb"}
	if !reflect.DeepEqual(tried, want) {
		t.Fatalf("tried %v, want %v (never another node's pod)", tried, want)
	}

	runner, err = factory.NodeLocalRunnerForNode("worker-c")
	if err != nil {
		t.Fatalf("NodeLocalRunnerForNode: %v", err)
	}
	runner.(*KubernetesExecRunner).execPod = func(context.Context, string, string, string, []string) (string, string, error) {
		t.Fatalf("a node without pods must not exec anywhere")
		return "", "", nil
	}
	if _, err := runner.Run(context.Background(), ovsBondShowCommand); err == nil || !strings.Contains(err.Error(), "worker-c") {
		t.Fatalf("expected a no-pods-on-node error naming worker-c, got %v", err)
	}
}

func TestOVSBondCollectorRunsBondShowOnTheNode(t *testing.T) {
	clientset := fake.NewSimpleClientset(
		newRunningPod("openshift-ovn-kubernetes", "ovnkube-node-a", "worker-a", []string{"nbdb", "ovn-controller"}),
	)
	factory := &recordingNodeLocalFactory{inner: NewKubernetesExecRunnerFactory(clientset, &rest.Config{Host: "https://example.invalid"}, []string{"openshift-ovn-kubernetes"}, slog.Default())}
	factory.exec = func(_ context.Context, _, _, container string, command []string) (string, string, error) {
		if container != "ovn-controller" {
			t.Fatalf("expected bond/show in ovn-controller, got %q", container)
		}
		if strings.Join(command, " ") != "ovs-appctl --timeout=10 bond/show" {
			t.Fatalf("unexpected command %v", command)
		}
		return capturedBondShow, "", nil
	}

	bonds, err := NewOVSBondCollector(factory, slog.Default(), false).CollectOVSBonds(context.Background(), "worker-a")
	if err != nil {
		t.Fatalf("CollectOVSBonds: %v", err)
	}
	if len(bonds) != 1 || bonds[0].Name != "bond1" || bonds[0].ActiveMember == nil || bonds[0].ActiveMember.Name != "ens161" {
		t.Fatalf("unexpected bonds %+v", bonds)
	}
	if factory.node != "worker-a" {
		t.Fatalf("runner resolved for %q", factory.node)
	}

	factory.exec = func(context.Context, string, string, string, []string) (string, string, error) {
		return "", "", nil
	}
	bonds, err = NewOVSBondCollector(factory, slog.Default(), false).CollectOVSBonds(context.Background(), "worker-a")
	if err != nil || bonds == nil || len(bonds) != 0 {
		t.Fatalf("a node without bonds should give an empty list and no error, got %v, %v", bonds, err)
	}

	factory.exec = func(context.Context, string, string, string, []string) (string, string, error) {
		return "", "ovs-vswitchd not running", errors.New("exit 1")
	}
	if _, err := NewOVSBondCollector(factory, slog.Default(), false).CollectOVSBonds(context.Background(), "worker-a"); err == nil {
		t.Fatalf("expected an error when bond/show fails")
	}
}

type recordingNodeLocalFactory struct {
	inner *KubernetesExecRunnerFactory
	exec  podExecFunc
	node  string
}

func (f *recordingNodeLocalFactory) NodeLocalRunnerForNode(nodeName string) (Runner, error) {
	f.node = nodeName
	runner, err := f.inner.NodeLocalRunnerForNode(nodeName)
	if err != nil {
		return nil, err
	}
	runner.(*KubernetesExecRunner).execPod = f.exec
	return runner, nil
}
