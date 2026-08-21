package controller

import (
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"

	reconv1beta1 "github.com/dlbewley/ovn-recon-operator/api/v1beta1"
)

func ownerTestScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	s := runtime.NewScheme()
	if err := scheme.AddToScheme(s); err != nil {
		t.Fatalf("failed to add client-go scheme: %v", err)
	}
	if err := reconv1beta1.AddToScheme(s); err != nil {
		t.Fatalf("failed to add recon/v1beta1 scheme: %v", err)
	}
	return s
}

func ownerTestCR() *reconv1beta1.OvnRecon {
	return &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "sample", UID: types.UID("uid-current")},
	}
}

// OvnRecon is cluster-scoped, so it can own a namespaced dependent in ANY
// namespace. This is the case the old "no owner refs with cluster-scoped CRs"
// comment claimed was impossible, and it is the one that matters most: the
// collector RoleBindings live in the probe namespaces, not the target one.
func TestSetManagedOwnerAcrossNamespaces(t *testing.T) {
	s := ownerTestScheme(t)
	cr := ownerTestCR()

	for _, namespace := range []string{"ovn-recon", "openshift-ovn-kubernetes", "openshift-frr-k8s"} {
		rb := &rbacv1.RoleBinding{ObjectMeta: metav1.ObjectMeta{Name: "collector", Namespace: namespace}}
		if err := setManagedOwner(cr, rb, s); err != nil {
			t.Fatalf("namespace %s: %v", namespace, err)
		}
		refs := rb.GetOwnerReferences()
		if len(refs) != 1 {
			t.Fatalf("namespace %s: expected one owner reference, got %#v", namespace, refs)
		}
		if refs[0].Kind != "OvnRecon" || refs[0].UID != cr.UID {
			t.Errorf("namespace %s: wrong owner %#v", namespace, refs[0])
		}
		if refs[0].Controller == nil || !*refs[0].Controller {
			t.Errorf("namespace %s: expected a controller reference", namespace)
		}
		// Only matters under foreground deletion, and the finalizer already
		// sequences teardown; leaving it false avoids depending on the
		// OwnerReferencesPermissionEnforcement admission plugin.
		if refs[0].BlockOwnerDeletion != nil && *refs[0].BlockOwnerDeletion {
			t.Errorf("namespace %s: blockOwnerDeletion should be false", namespace)
		}
	}
}

// Cluster-scoped dependents are fine too, because the owner is cluster-scoped.
func TestSetManagedOwnerOnClusterScopedDependents(t *testing.T) {
	s := ownerTestScheme(t)
	cr := ownerTestCR()

	clusterRole := &rbacv1.ClusterRole{ObjectMeta: metav1.ObjectMeta{Name: "ovn-recon-collector"}}
	if err := setManagedOwner(cr, clusterRole, s); err != nil {
		t.Fatalf("ClusterRole: %v", err)
	}

	plugin := &unstructured.Unstructured{}
	plugin.SetGroupVersionKind(schema.GroupVersionKind{Group: "console.openshift.io", Version: "v1", Kind: "ConsolePlugin"})
	plugin.SetName("sample")
	if err := setManagedOwner(cr, plugin, s); err != nil {
		t.Fatalf("ConsolePlugin: %v", err)
	}
	if len(plugin.GetOwnerReferences()) != 1 {
		t.Errorf("ConsolePlugin owner refs: %#v", plugin.GetOwnerReferences())
	}
}

// A CR deleted and recreated under the same name leaves resources behind
// carrying the previous UID. The new generation must adopt them rather than
// wedging the reconcile on AlreadyOwnedError forever.
func TestSetManagedOwnerAdoptsStaleOvnReconOwner(t *testing.T) {
	s := ownerTestScheme(t)
	cr := ownerTestCR()

	deployment := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{
		Name:      "sample",
		Namespace: "ovn-recon",
		OwnerReferences: []metav1.OwnerReference{{
			APIVersion: reconv1beta1.GroupVersion.String(),
			Kind:       "OvnRecon",
			Name:       "sample",
			UID:        types.UID("uid-previous"),
			Controller: ptr.To(true),
		}},
	}}

	if err := setManagedOwner(cr, deployment, s); err != nil {
		t.Fatalf("expected the stale owner to be adopted, got %v", err)
	}
	refs := deployment.GetOwnerReferences()
	if len(refs) != 1 {
		t.Fatalf("expected exactly one owner reference after takeover, got %#v", refs)
	}
	if refs[0].UID != cr.UID {
		t.Errorf("expected the current CR's UID, got %s", refs[0].UID)
	}
}

// Anything not an OvnRecon is genuinely somebody else's object.
func TestSetManagedOwnerRefusesForeignController(t *testing.T) {
	s := ownerTestScheme(t)
	cr := ownerTestCR()

	deployment := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{
		Name:      "sample",
		Namespace: "ovn-recon",
		OwnerReferences: []metav1.OwnerReference{{
			APIVersion: "apps/v1",
			Kind:       "ReplicaSet",
			Name:       "someone-elses",
			UID:        types.UID("uid-foreign"),
			Controller: ptr.To(true),
		}},
	}}

	err := setManagedOwner(cr, deployment, s)
	if err == nil {
		t.Fatal("expected adoption of a foreign object to be refused")
	}
	if !strings.Contains(err.Error(), "ReplicaSet") {
		t.Errorf("error should name the foreign controller, got %v", err)
	}
	if refs := deployment.GetOwnerReferences(); len(refs) != 1 || refs[0].Kind != "ReplicaSet" {
		t.Errorf("foreign owner reference must be left untouched, got %#v", refs)
	}
}

// Non-controller references from other actors must survive a takeover.
func TestSetManagedOwnerPreservesNonControllerRefs(t *testing.T) {
	s := ownerTestScheme(t)
	cr := ownerTestCR()

	obj := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{
		Name:      "sample",
		Namespace: "ovn-recon",
		OwnerReferences: []metav1.OwnerReference{
			{APIVersion: "v1", Kind: "ConfigMap", Name: "bystander", UID: types.UID("uid-bystander")},
			{
				APIVersion: reconv1beta1.GroupVersion.String(),
				Kind:       "OvnRecon", Name: "sample", UID: types.UID("uid-previous"),
				Controller: ptr.To(true),
			},
		},
	}}

	if err := setManagedOwner(cr, obj, s); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	refs := obj.GetOwnerReferences()
	kinds := make([]string, 0, len(refs))
	for _, ref := range refs {
		kinds = append(kinds, ref.Kind)
	}
	if len(kinds) != 2 {
		t.Fatalf("expected the bystander reference to survive, got %v", kinds)
	}
}

var _ client.Object = &appsv1.Deployment{}
