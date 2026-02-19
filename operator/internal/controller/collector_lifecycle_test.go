package controller

import (
	"context"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	reconv1beta1 "github.com/dlbewley/ovn-recon-operator/api/v1beta1"
)

func TestDeleteCollectorDeploymentKeepsService(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := appsv1.AddToScheme(scheme); err != nil {
		t.Fatalf("failed to add apps/v1 scheme: %v", err)
	}
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatalf("failed to add core/v1 scheme: %v", err)
	}

	ovnRecon := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
		Spec: reconv1beta1.OvnReconSpec{
			TargetNamespace: "ovn-recon",
		},
	}

	collectorDeployment := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "ovn-recon-collector",
			Namespace: "ovn-recon",
		},
	}
	collectorService := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "ovn-recon-collector",
			Namespace: "ovn-recon",
		},
	}

	reconciler := &OvnReconReconciler{
		Client: fake.NewClientBuilder().
			WithScheme(scheme).
			WithObjects(collectorDeployment, collectorService).
			Build(),
		Scheme: scheme,
	}

	if err := reconciler.deleteCollectorDeployment(context.Background(), ovnRecon); err != nil {
		t.Fatalf("deleteCollectorDeployment failed: %v", err)
	}

	deployment := &appsv1.Deployment{}
	err := reconciler.Get(context.Background(), types.NamespacedName{Name: "ovn-recon-collector", Namespace: "ovn-recon"}, deployment)
	if !apierrors.IsNotFound(err) {
		t.Fatalf("expected collector deployment to be deleted, got err=%v", err)
	}

	service := &corev1.Service{}
	err = reconciler.Get(context.Background(), types.NamespacedName{Name: "ovn-recon-collector", Namespace: "ovn-recon"}, service)
	if err != nil {
		t.Fatalf("expected collector service to remain, got err=%v", err)
	}
}

func TestDeleteCollectorResourcesRemovesService(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := appsv1.AddToScheme(scheme); err != nil {
		t.Fatalf("failed to add apps/v1 scheme: %v", err)
	}
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatalf("failed to add core/v1 scheme: %v", err)
	}

	ovnRecon := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
		Spec: reconv1beta1.OvnReconSpec{
			TargetNamespace: "ovn-recon",
		},
	}

	collectorDeployment := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "ovn-recon-collector",
			Namespace: "ovn-recon",
		},
	}
	collectorService := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "ovn-recon-collector",
			Namespace: "ovn-recon",
		},
	}

	reconciler := &OvnReconReconciler{
		Client: fake.NewClientBuilder().
			WithScheme(scheme).
			WithObjects(collectorDeployment, collectorService).
			Build(),
		Scheme: scheme,
	}

	if err := reconciler.deleteCollectorResources(context.Background(), ovnRecon); err != nil {
		t.Fatalf("deleteCollectorResources failed: %v", err)
	}

	deployment := &appsv1.Deployment{}
	err := reconciler.Get(context.Background(), types.NamespacedName{Name: "ovn-recon-collector", Namespace: "ovn-recon"}, deployment)
	if !apierrors.IsNotFound(err) {
		t.Fatalf("expected collector deployment to be deleted, got err=%v", err)
	}

	service := &corev1.Service{}
	err = reconciler.Get(context.Background(), types.NamespacedName{Name: "ovn-recon-collector", Namespace: "ovn-recon"}, service)
	if !apierrors.IsNotFound(err) {
		t.Fatalf("expected collector service to be deleted during full cleanup, got err=%v", err)
	}
}
