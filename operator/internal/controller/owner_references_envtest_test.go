package controller

import (
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"

	reconv1beta1 "github.com/dlbewley/ovn-recon-operator/api/v1beta1"
)

// These specs check that the API SERVER accepts what setManagedOwner produces.
// controllerutil validates ownership client-side, which proves only that the
// helper agrees with itself; the rule that actually matters is the apiserver's.
//
// What these specs cannot prove: that garbage collection reaps anything.
// envtest runs etcd and kube-apiserver only, with no kube-controller-manager,
// so no GC exists to observe. Reaping needs a real cluster.
var _ = Describe("Owner references on managed resources", func() {
	var cr *reconv1beta1.OvnRecon

	BeforeEach(func() {
		cr = &reconv1beta1.OvnRecon{ObjectMeta: metav1.ObjectMeta{Name: "owner-ref-sample"}}
		Expect(k8sClient.Create(ctx, cr)).To(Succeed())
		DeferCleanup(func() {
			Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, cr))).To(Succeed())
		})
		// A real UID only exists after the create round-trip.
		Expect(cr.UID).NotTo(BeEmpty())
	})

	It("accepts a cluster-scoped owner on a namespaced object in a foreign namespace", func() {
		probeNamespace := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "owner-ref-probe-ns"}}
		Expect(client.IgnoreAlreadyExists(k8sClient.Create(ctx, probeNamespace))).To(Succeed())

		// The collector's RoleBindings live here, not in the target namespace.
		// A namespaced owner could never own this; a cluster-scoped one can.
		rb := &rbacv1.RoleBinding{
			ObjectMeta: metav1.ObjectMeta{Name: "owner-ref-collector", Namespace: probeNamespace.Name},
			RoleRef:    rbacv1.RoleRef{APIGroup: rbacv1.GroupName, Kind: "ClusterRole", Name: "view"},
		}
		Expect(setManagedOwner(cr, rb, scheme.Scheme)).To(Succeed())
		Expect(k8sClient.Create(ctx, rb)).To(Succeed())
		DeferCleanup(func() {
			Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, rb))).To(Succeed())
		})

		stored := &rbacv1.RoleBinding{}
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(rb), stored)).To(Succeed())
		Expect(stored.OwnerReferences).To(HaveLen(1))
		Expect(stored.OwnerReferences[0].Kind).To(Equal("OvnRecon"))
		Expect(stored.OwnerReferences[0].UID).To(Equal(cr.UID))
		Expect(stored.OwnerReferences[0].Controller).To(HaveValue(BeTrue()))
	})

	It("accepts a cluster-scoped owner on a cluster-scoped dependent", func() {
		clusterRole := &rbacv1.ClusterRole{
			ObjectMeta: metav1.ObjectMeta{Name: "owner-ref-collector-role"},
			Rules:      []rbacv1.PolicyRule{{APIGroups: []string{""}, Resources: []string{"pods"}, Verbs: []string{"get"}}},
		}
		Expect(setManagedOwner(cr, clusterRole, scheme.Scheme)).To(Succeed())
		Expect(k8sClient.Create(ctx, clusterRole)).To(Succeed())
		DeferCleanup(func() {
			Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, clusterRole))).To(Succeed())
		})

		stored := &rbacv1.ClusterRole{}
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(clusterRole), stored)).To(Succeed())
		Expect(stored.OwnerReferences).To(HaveLen(1))
		Expect(stored.OwnerReferences[0].UID).To(Equal(cr.UID))
	})
})
