package controller

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/tools/record"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/event"
	"sigs.k8s.io/controller-runtime/pkg/predicate"

	reconv1beta1 "github.com/dlbewley/ovn-recon-operator/api/v1beta1"
)

// WatchesMetadata delivers *metav1.PartialObjectMetadata, not *corev1.Namespace.
// The map function must keep working on the stripped object.
func TestProbeNamespaceMapFuncAcceptsPartialObjectMetadata(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatalf("failed to add core/v1 scheme: %v", err)
	}
	if err := reconv1beta1.AddToScheme(scheme); err != nil {
		t.Fatalf("failed to add recon/v1beta1 scheme: %v", err)
	}

	cr := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "matching"},
		Spec: reconv1beta1.OvnReconSpec{
			Collector: reconv1beta1.CollectorSpec{
				Enabled:         ptr.To(true),
				ProbeNamespaces: []string{"openshift-ovn-kubernetes"},
			},
		},
	}

	reconciler := &OvnReconReconciler{
		Client:   fake.NewClientBuilder().WithScheme(scheme).WithObjects(cr).Build(),
		Scheme:   scheme,
		Recorder: record.NewFakeRecorder(10),
	}

	// Exactly what the metadata informer hands the handler: name only, no spec
	// or status.
	metadataOnly := &metav1.PartialObjectMetadata{
		TypeMeta:   metav1.TypeMeta{APIVersion: "v1", Kind: "Namespace"},
		ObjectMeta: metav1.ObjectMeta{Name: "openshift-ovn-kubernetes"},
	}

	requests := reconciler.reconcileRequestsForProbeNamespace(context.Background(), metadataOnly)
	if len(requests) != 1 || requests[0].Name != "matching" {
		t.Fatalf("metadata-only namespace event did not enqueue the matching CR: %#v", requests)
	}
}

func TestProbeNamespaceExistencePredicateDropsUpdatesOnly(t *testing.T) {
	t.Parallel()

	p := probeNamespaceExistencePredicate()
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "openshift-ovn-kubernetes"}}

	if !p.Create(event.CreateEvent{Object: ns}) {
		t.Error("probe namespace creation must trigger a reconcile")
	}
	if !p.Delete(event.DeleteEvent{Object: ns}) {
		t.Error("probe namespace deletion must trigger a reconcile")
	}
	if p.Update(event.UpdateEvent{ObjectOld: ns, ObjectNew: ns}) {
		t.Error("namespace updates carry no signal for RoleBinding reconciliation and must be dropped")
	}
}

// The generation predicate used to be a WithEventFilter, which applied it to
// the Namespace watch too. Namespaces never bump generation, so it silently
// discarded every namespace update; this documents why it now sits on For().
func TestGenerationPredicateIsMeaninglessForNamespaces(t *testing.T) {
	t.Parallel()

	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "openshift-ovn-kubernetes"}}
	generationChanged := predicate.GenerationChangedPredicate{}
	if generationChanged.Update(event.UpdateEvent{ObjectOld: ns, ObjectNew: ns}) {
		t.Error("expected the generation predicate to drop namespace updates, confirming it never belonged on that watch")
	}
}
