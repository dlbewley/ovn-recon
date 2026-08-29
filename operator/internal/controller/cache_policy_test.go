package controller

import (
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"

	reconv1beta1 "github.com/dlbewley/ovn-recon-operator/api/v1beta1"
)

// Every object the operator writes must match the cache filter, or a
// label-filtered informer will report it as missing and CreateOrUpdate will
// loop on AlreadyExists.
func TestManagedResourceSelectorMatchesEveryManagedWritePath(t *testing.T) {
	cr := &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: "sample"},
		Spec: reconv1beta1.OvnReconSpec{
			Collector: reconv1beta1.CollectorSpec{Enabled: ptr.To(true)},
		},
	}

	cases := map[string]map[string]string{
		"plugin Deployment":    DesiredDeployment(cr).Labels,
		"collector Deployment": DesiredCollectorDeployment(cr, nil).Labels,
		"plugin Service":       DesiredService(cr).Labels,
		"collector Service":    DesiredCollectorService(cr).Labels,
		// RBAC objects are built inline in reconcileCollectorAccessControls.
		"collector RBAC": labelsForOvnRecon(cr.Name),
	}

	selector := ManagedResourceSelector()
	for name, got := range cases {
		if !selector.Matches(labels.Set(got)) {
			t.Errorf("%s labels %v do not match cache selector %q", name, got, selector)
		}
	}
}

func TestManagerCacheOptionsScopeCachedTypes(t *testing.T) {
	opts := ManagerCacheOptions()

	want := map[string]bool{"*v1.Deployment": false, "*v1.Service": false}
	for obj, byObject := range opts.ByObject {
		switch obj.(type) {
		case *appsv1.Deployment:
			want["*v1.Deployment"] = true
		case *corev1.Service:
			want["*v1.Service"] = true
		default:
			t.Errorf("unexpected cached type %T; add it to the documented policy first", obj)
		}
		if byObject.Label == nil || byObject.Label.Empty() {
			t.Errorf("cached type %T has no label selector, so its informer is cluster-wide", obj)
		}
	}
	for kind, found := range want {
		if !found {
			t.Errorf("%s is not scoped in ManagerCacheOptions", kind)
		}
	}
}

func TestManagerClientOptionsBypassCacheForUnwatchedTypes(t *testing.T) {
	opts := ManagerClientOptions()
	if opts.Cache == nil {
		t.Fatal("client cache options must be set explicitly")
	}
	if opts.Cache.Unstructured {
		t.Fatal("caching unstructured reads spawns cluster-wide informers for ConsolePlugin and Console")
	}

	disabled := map[string]bool{}
	for _, obj := range opts.Cache.DisableFor {
		switch obj.(type) {
		case *corev1.Namespace:
			disabled["Namespace"] = true
		case *corev1.ServiceAccount:
			disabled["ServiceAccount"] = true
		case *rbacv1.ClusterRole:
			disabled["ClusterRole"] = true
		case *rbacv1.RoleBinding:
			disabled["RoleBinding"] = true
		}
	}
	for _, kind := range []string{"Namespace", "ServiceAccount", "ClusterRole", "RoleBinding"} {
		if !disabled[kind] {
			t.Errorf("%s reads still go through the cache, creating a cluster-wide informer", kind)
		}
	}

	// OvnRecon must stay cached and unfiltered: primaryInstance() lists every
	// CR in the cluster off the For() informer.
	for _, obj := range opts.Cache.DisableFor {
		if _, isOvnRecon := obj.(*reconv1beta1.OvnRecon); isOvnRecon {
			t.Error("OvnRecon must be served by the For() informer, not read live")
		}
	}
	var _ client.Object = &reconv1beta1.OvnRecon{}
}

func TestEnsureManagedLabelsReassertsTheCacheFilter(t *testing.T) {
	t.Parallel()

	deployment := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name: "sample",
			// What the object looks like after something stripped the filter
			// label: an unrelated label an admin added survives, ours is gone.
			Labels: map[string]string{"example.com/owner": "platform-team"},
		},
	}

	// Desired labels that omit the filter label entirely - the case a plain
	// mergeStringMap would not repair.
	ensureManagedLabels(deployment, map[string]string{"app.kubernetes.io/component": "test-component"})

	got := deployment.GetLabels()
	if got[ManagedByLabelKey] != ManagedByLabelValue {
		t.Fatalf("filter label not re-applied: %v", got)
	}
	if got["example.com/owner"] != "platform-team" {
		t.Errorf("third-party label was dropped: %v", got)
	}
	if got["app.kubernetes.io/component"] != "test-component" {
		t.Errorf("desired label was not applied: %v", got)
	}
	if !ManagedResourceSelector().Matches(labels.Set(got)) {
		t.Errorf("object still invisible to the label-filtered informer: %v", got)
	}
}
