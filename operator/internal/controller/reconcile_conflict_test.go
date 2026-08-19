package controller

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	reconv1beta1 "github.com/dlbewley/ovn-recon-operator/api/v1beta1"
)

func conflictErr() error {
	return apierrors.NewConflict(
		schema.GroupResource{Group: "apps", Resource: "deployments"},
		"ovn-recon",
		errors.New("the object has been modified; please apply your changes to the latest version and try again"),
	)
}

// newConflictTestReconciler wires a reconciler around cr. updateCondition
// writes the status subresource, so a real (fake) client is required.
func newConflictTestReconciler(t *testing.T, cr *reconv1beta1.OvnRecon) (*OvnReconReconciler, *record.FakeRecorder) {
	t.Helper()

	scheme := runtime.NewScheme()
	if err := reconv1beta1.AddToScheme(scheme); err != nil {
		t.Fatalf("failed to add recon/v1beta1 scheme: %v", err)
	}
	recorder := record.NewFakeRecorder(16)
	return &OvnReconReconciler{
		Client: fake.NewClientBuilder().
			WithScheme(scheme).
			WithObjects(cr).
			WithStatusSubresource(cr).
			Build(),
		Scheme:      scheme,
		Recorder:    recorder,
		eventDedupe: map[string]time.Time{},
	}, recorder
}

// A conflict is optimistic concurrency doing its job. It must requeue silently:
// no error returned, no Warning event, and the condition left untouched.
func TestReconcileStepFailedTreatsConflictAsRequeue(t *testing.T) {
	cr := &reconv1beta1.OvnRecon{ObjectMeta: metav1.ObjectMeta{Name: "sample"}}
	cr.Status.Conditions = []metav1.Condition{{
		Type:   "Available",
		Status: metav1.ConditionTrue,
		Reason: "DeploymentReady",
	}}
	r, recorder := newConflictTestReconciler(t, cr)

	result, err := r.reconcileStepFailed(context.Background(), cr,
		operatorLogLevelDebug, operatorEventPolicy{}, conflictErr(),
		"Failed to reconcile Deployment", "DeploymentReconcileFailed", "Available")

	if err != nil {
		t.Fatalf("a conflict must not surface as a reconcile error, got %v", err)
	}
	if !result.Requeue {
		t.Error("a conflict must requeue so the next attempt sees the fresh object")
	}
	select {
	case ev := <-recorder.Events:
		t.Errorf("a conflict must not post an event to the CR, got %q", ev)
	default:
	}
	if got := cr.Status.Conditions[0]; got.Status != metav1.ConditionTrue {
		t.Errorf("a conflict must not flip the condition, got %s/%s", got.Status, got.Reason)
	}
}

// Anything else is a real failure and must stay loud.
func TestReconcileStepFailedKeepsRealErrorsLoud(t *testing.T) {
	cr := &reconv1beta1.OvnRecon{ObjectMeta: metav1.ObjectMeta{Name: "sample"}}
	cr.Status.Conditions = []metav1.Condition{{
		Type:   "Available",
		Status: metav1.ConditionTrue,
		Reason: "DeploymentReady",
	}}
	r, recorder := newConflictTestReconciler(t, cr)
	boom := errors.New("deployment is invalid")

	result, err := r.reconcileStepFailed(context.Background(), cr,
		operatorLogLevelDebug, operatorEventPolicy{}, boom,
		"Failed to reconcile Deployment", "DeploymentReconcileFailed", "Available")

	if !errors.Is(err, boom) {
		t.Fatalf("a real error must be returned unchanged, got %v", err)
	}
	// The Result must be zero: controller-runtime discards it when the error is
	// non-nil and requeues with exponential backoff, so a RequeueAfter here
	// would be dead code that also trips a warning on every failure.
	if !result.IsZero() {
		t.Errorf("a real error must return a zero Result, got %+v", result)
	}
	select {
	case ev := <-recorder.Events:
		if !strings.Contains(ev, "DeploymentReconcileFailed") {
			t.Errorf("unexpected event %q", ev)
		}
	default:
		t.Error("a real error must post a Warning event to the CR")
	}
	if got := cr.Status.Conditions[0]; got.Status != metav1.ConditionFalse || got.Reason != "DeploymentReconcileFailed" {
		t.Errorf("a real error must flip the condition, got %s/%s", got.Status, got.Reason)
	}
}

func TestReconcileStepFailedSkipsEmptyCondition(t *testing.T) {
	cr := &reconv1beta1.OvnRecon{ObjectMeta: metav1.ObjectMeta{Name: "sample"}}
	r, _ := newConflictTestReconciler(t, cr)

	if _, err := r.reconcileStepFailed(context.Background(), cr,
		operatorLogLevelDebug, operatorEventPolicy{}, errors.New("boom"),
		"Failed", "Reason", ""); err == nil {
		t.Fatal("expected the error to be returned")
	}
	if len(cr.Status.Conditions) != 0 {
		t.Errorf("no condition should have been set, got %#v", cr.Status.Conditions)
	}
}
