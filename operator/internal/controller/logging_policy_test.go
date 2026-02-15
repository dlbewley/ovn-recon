package controller

import (
	"context"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/record"

	reconv1alpha1 "github.com/dlbewley/ovn-recon-operator/api/v1alpha1"
)

func TestResolveOperatorLogPolicyUsesPrimaryWhenPresent(t *testing.T) {
	t.Helper()

	current := &reconv1alpha1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "secondary"},
		Spec: reconv1alpha1.OvnReconSpec{
			Operator: reconv1alpha1.OperatorSpec{
				Logging: reconv1alpha1.OperatorLoggingSpec{
					Level: "info",
				},
			},
		},
	}
	primary := &reconv1alpha1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "primary"},
		Spec: reconv1alpha1.OvnReconSpec{
			Operator: reconv1alpha1.OperatorSpec{
				Logging: reconv1alpha1.OperatorLoggingSpec{
					Level: "debug",
				},
			},
		},
	}

	level, configuredLevel, source := resolveOperatorLogPolicy(current, primary)
	if level != operatorLogLevelDebug {
		t.Fatalf("expected debug level from primary, got %q", level.String())
	}
	if configuredLevel != "debug" {
		t.Fatalf("expected configured level debug, got %q", configuredLevel)
	}
	if source != "primary" {
		t.Fatalf("expected source primary, got %q", source)
	}
}

func TestResolveOperatorLogPolicyDefaultsToInfoWhenUnset(t *testing.T) {
	t.Helper()

	current := &reconv1alpha1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
	}

	level, configuredLevel, source := resolveOperatorLogPolicy(current, nil)
	if level != operatorLogLevelInfo {
		t.Fatalf("expected default info level, got %q", level.String())
	}
	if configuredLevel != "info" {
		t.Fatalf("expected configured level info, got %q", configuredLevel)
	}
	if source != "ovn-recon" {
		t.Fatalf("expected source ovn-recon, got %q", source)
	}
}

func TestSelectPrimaryInstanceUsesOldestThenName(t *testing.T) {
	t.Helper()

	now := time.Now().UTC()
	oldest := now.Add(-2 * time.Hour)
	newer := now.Add(-1 * time.Hour)

	items := []reconv1alpha1.OvnRecon{
		{
			ObjectMeta: metav1.ObjectMeta{
				Name:              "zeta",
				CreationTimestamp: metav1.NewTime(oldest),
			},
		},
		{
			ObjectMeta: metav1.ObjectMeta{
				Name:              "alpha",
				CreationTimestamp: metav1.NewTime(oldest),
			},
		},
		{
			ObjectMeta: metav1.ObjectMeta{
				Name:              "newer",
				CreationTimestamp: metav1.NewTime(newer),
			},
		},
	}

	primary := selectPrimaryInstance(items)
	if primary == nil {
		t.Fatalf("selectPrimaryInstance returned nil primary")
	}
	if primary.Name != "alpha" {
		t.Fatalf("expected alpha to be primary, got %q", primary.Name)
	}
}

func TestResolveOperatorEventPolicyUsesPrimaryWhenPresent(t *testing.T) {
	t.Helper()

	current := &reconv1alpha1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "secondary"},
		Spec: reconv1alpha1.OvnReconSpec{
			Operator: reconv1alpha1.OperatorSpec{
				Logging: reconv1alpha1.OperatorLoggingSpec{
					Events: reconv1alpha1.OperatorEventsSpec{
						MinType:      "Warning",
						DedupeWindow: "1m",
					},
				},
			},
		},
	}
	primary := &reconv1alpha1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "primary"},
		Spec: reconv1alpha1.OvnReconSpec{
			Operator: reconv1alpha1.OperatorSpec{
				Logging: reconv1alpha1.OperatorLoggingSpec{
					Events: reconv1alpha1.OperatorEventsSpec{
						MinType:      "Normal",
						DedupeWindow: "10m",
					},
				},
			},
		},
	}

	policy := resolveOperatorEventPolicy(current, primary)
	if policy.minType != corev1.EventTypeNormal {
		t.Fatalf("expected policy minType Normal from primary, got %q", policy.minType)
	}
	if policy.dedupeWindow != 10*time.Minute {
		t.Fatalf("expected 10m dedupe window from primary, got %s", policy.dedupeWindow)
	}
}

func TestResolveOperatorEventPolicyDefaultsAndInvalidValues(t *testing.T) {
	t.Helper()

	current := &reconv1alpha1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
		Spec: reconv1alpha1.OvnReconSpec{
			Operator: reconv1alpha1.OperatorSpec{
				Logging: reconv1alpha1.OperatorLoggingSpec{
					Events: reconv1alpha1.OperatorEventsSpec{
						MinType:      "normal",
						DedupeWindow: "not-a-duration",
					},
				},
			},
		},
	}

	policy := resolveOperatorEventPolicy(current, nil)
	if policy.minType != corev1.EventTypeNormal {
		t.Fatalf("expected default minType Normal for invalid value, got %q", policy.minType)
	}
	if policy.dedupeWindow != defaultEventDedupe {
		t.Fatalf("expected default dedupe window %s, got %s", defaultEventDedupe, policy.dedupeWindow)
	}
}

func TestShouldEmitNormalEventDedupe(t *testing.T) {
	t.Helper()

	r := &OvnReconReconciler{}
	policy := operatorEventPolicy{
		minType:      corev1.EventTypeNormal,
		dedupeWindow: time.Minute,
	}
	ovnRecon := &reconv1alpha1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
	}

	if !r.shouldEmitNormalEvent(ovnRecon, policy, "ServiceReady", "Service is ready") {
		t.Fatalf("expected first event to emit")
	}
	if r.shouldEmitNormalEvent(ovnRecon, policy, "ServiceReady", "Service is ready") {
		t.Fatalf("expected duplicate event within dedupe window to be suppressed")
	}
	if !r.shouldEmitNormalEvent(ovnRecon, policy, "ServiceReady", "Service changed") {
		t.Fatalf("expected different message to emit")
	}
}

func TestRecordEventHonorsMinTypeAndWarningAlways(t *testing.T) {
	t.Helper()

	recorder := record.NewFakeRecorder(10)
	r := &OvnReconReconciler{
		Recorder: recorder,
	}
	policy := operatorEventPolicy{
		minType:      corev1.EventTypeWarning,
		dedupeWindow: time.Minute,
	}
	ovnRecon := &reconv1alpha1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
	}

	// Normal should be filtered when minType is Warning.
	r.recordEvent(context.Background(), ovnRecon, policy, corev1.EventTypeNormal, "ServiceReady", "Service is ready")
	select {
	case event := <-recorder.Events:
		t.Fatalf("expected no Normal event, got %q", event)
	default:
	}

	// Warnings should always emit even when minType is Warning.
	r.recordEvent(context.Background(), ovnRecon, policy, corev1.EventTypeWarning, "ServiceReconcileFailed", "boom")
	select {
	case <-recorder.Events:
	case <-time.After(time.Second):
		t.Fatalf("expected Warning event to emit")
	}
}
