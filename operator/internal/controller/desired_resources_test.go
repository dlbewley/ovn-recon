package controller

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"testing"

	reconv1alpha1 "github.com/dlbewley/ovn-recon-operator/api/v1alpha1"
)

func TestCollectorImageInheritance(t *testing.T) {
	cr := &reconv1alpha1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "test"},
		Spec: reconv1alpha1.OvnReconSpec{
			Image: reconv1alpha1.ImageSpec{
				Repository: "quay.io/dbewley/ovn-recon",
				Tag:        "v1.2.3",
				PullPolicy: string(corev1.PullAlways),
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
	cr := &reconv1alpha1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "test"},
		Spec: reconv1alpha1.OvnReconSpec{
			Image: reconv1alpha1.ImageSpec{
				Tag:        "v1.2.3",
				PullPolicy: string(corev1.PullIfNotPresent),
			},
			CollectorImage: reconv1alpha1.CollectorImageSpec{
				Repository: "quay.io/acme/custom-collector",
				Tag:        "collector-tag",
				PullPolicy: string(corev1.PullNever),
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
	cr := &reconv1alpha1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon"},
		Spec: reconv1alpha1.OvnReconSpec{
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
	if dep.Spec.Template.Spec.Containers[0].Name != "ovn-collector" {
		t.Fatalf("unexpected collector container name: %s", dep.Spec.Template.Spec.Containers[0].Name)
	}
	if dep.Spec.Template.Spec.Containers[0].Ports[0].ContainerPort != 8090 {
		t.Fatalf("unexpected collector port")
	}

	svc := DesiredCollectorService(cr)
	if svc.Name != "ovn-recon-collector" {
		t.Fatalf("unexpected collector service name: %s", svc.Name)
	}
	if svc.Spec.Ports[0].Port != 8090 {
		t.Fatalf("unexpected collector service port")
	}
}
