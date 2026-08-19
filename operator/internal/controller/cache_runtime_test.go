package controller

import (
	"context"
	"errors"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"

	reconv1beta1 "github.com/dlbewley/ovn-recon-operator/api/v1beta1"
)

// startCache builds a real informer cache against envtest and runs it until the
// spec finishes. ReaderFailOnMissingInformer turns "would lazily open a new
// cluster-wide informer" from silent behaviour into a returned error, which is
// what lets these specs assert on informer reuse instead of inferring it.
func startCache(opts cache.Options) cache.Cache {
	GinkgoHelper()

	opts.Scheme = scheme.Scheme
	opts.ReaderFailOnMissingInformer = true

	c, err := cache.New(cfg, opts)
	Expect(err).NotTo(HaveOccurred())

	cacheCtx, stop := context.WithCancel(ctx)
	DeferCleanup(stop)
	go func() {
		defer GinkgoRecover()
		Expect(c.Start(cacheCtx)).To(Succeed())
	}()
	Expect(c.WaitForCacheSync(cacheCtx)).To(BeTrue())

	return c
}

var _ = Describe("Manager cache policy", func() {
	// ovn-recon-5gu.5 (T5): the anti-pattern scan flagged the two
	// r.List(&OvnReconList{}) calls as CRITICAL invisible informers. They are
	// not: For(&OvnRecon{}) already opens that informer and the List is served
	// from it.
	Context("OvnRecon list reads", func() {
		It("is served by the informer that For() already opened", func() {
			c := startCache(cache.Options{})

			// What builder.For(&OvnRecon{}) does under the hood.
			_, err := c.GetInformer(ctx, &reconv1beta1.OvnRecon{})
			Expect(err).NotTo(HaveOccurred())

			// If this needed an informer of its own, ReaderFailOnMissingInformer
			// would fail it.
			Expect(c.List(ctx, &reconv1beta1.OvnReconList{})).To(Succeed())
		})

		It("fails without that informer, proving the check has teeth", func() {
			c := startCache(cache.Options{})

			err := c.List(ctx, &reconv1beta1.OvnReconList{})
			Expect(err).To(HaveOccurred())

			var notCached *cache.ErrResourceNotCached
			Expect(errors.As(err, &notCached)).To(BeTrue(), "expected ErrResourceNotCached, got %v", err)
			Expect(notCached.GVK.Group).To(Equal(reconv1beta1.GroupVersion.Group))
		})
	})

	// ovn-recon-5gu.2 (T2) and the runtime gap left by ovn-recon-5gu.1 (T1):
	// the unit tests assert the policy's shape, this asserts its effect.
	Context("managed Deployment informer", func() {
		const namespace = "default"

		It("caches only Deployments this operator owns", func() {
			mine := deploymentFixture("cache-scoped-mine", namespace, labelsForOvnRecon("sample"))
			theirs := deploymentFixture("cache-scoped-theirs", namespace, map[string]string{"app": "somebody-else"})
			Expect(k8sClient.Create(ctx, mine)).To(Succeed())
			Expect(k8sClient.Create(ctx, theirs)).To(Succeed())
			DeferCleanup(func() {
				Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, mine))).To(Succeed())
				Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, theirs))).To(Succeed())
			})

			c := startCache(ManagerCacheOptions())

			// The first cached Deployment read opens this informer; ByObject
			// decides how wide it is.
			_, err := c.GetInformer(ctx, &appsv1.Deployment{})
			Expect(err).NotTo(HaveOccurred())

			cached := &appsv1.DeploymentList{}
			Expect(c.List(ctx, cached, client.InNamespace(namespace))).To(Succeed())

			names := make([]string, 0, len(cached.Items))
			for i := range cached.Items {
				names = append(names, cached.Items[i].Name)
			}
			Expect(names).To(ContainElement("cache-scoped-mine"))
			Expect(names).NotTo(ContainElement("cache-scoped-theirs"),
				"the informer is not label-scoped; it is watching every Deployment in the cluster")
		})
	})

	// ovn-recon-5gu.6 (T6): label-filtered caching is only safe while every
	// write re-asserts the filter label. This shows both halves: losing the
	// label really does make a managed object vanish from the informer, and
	// ensureManagedLabels brings it back.
	Context("filter label preservation", func() {
		const namespace = "default"

		It("recovers a managed object that lost the filter label", func() {
			deployment := deploymentFixture("label-recovery", namespace, labelsForOvnRecon("sample"))
			Expect(k8sClient.Create(ctx, deployment)).To(Succeed())
			DeferCleanup(func() {
				Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, deployment))).To(Succeed())
			})

			c := startCache(ManagerCacheOptions())
			_, err := c.GetInformer(ctx, &appsv1.Deployment{})
			Expect(err).NotTo(HaveOccurred())

			visible := func() bool {
				cached := &appsv1.Deployment{}
				err := c.Get(ctx, client.ObjectKeyFromObject(deployment), cached)
				return err == nil
			}
			Eventually(visible).Should(BeTrue(), "managed Deployment should start out cached")

			By("stripping the filter label")
			stripped := deployment.DeepCopy()
			stripped.Labels = map[string]string{"example.com/owner": "platform-team"}
			Expect(k8sClient.Update(ctx, stripped)).To(Succeed())
			Eventually(visible).Should(BeFalse(),
				"a label-filtered informer must drop an object that no longer matches")

			By("re-applying it the way every managed write path now does")
			ensureManagedLabels(stripped, labelsForOvnRecon("sample"))
			Expect(k8sClient.Update(ctx, stripped)).To(Succeed())
			Eventually(visible).Should(BeTrue(),
				"ensureManagedLabels must restore cache visibility")
		})
	})

	// ovn-recon-5gu.3 (T3): the probe-namespace watch must not cache whole
	// Namespace objects.
	Context("probe namespace watch", func() {
		It("uses a metadata-only informer", func() {
			c := startCache(cache.Options{})

			// What builder.WatchesMetadata(&corev1.Namespace{}, ...) does.
			metadataOnly := &metav1.PartialObjectMetadata{}
			metadataOnly.SetGroupVersionKind(corev1.SchemeGroupVersion.WithKind("Namespace"))
			_, err := c.GetInformer(ctx, metadataOnly)
			Expect(err).NotTo(HaveOccurred())

			metadataList := &metav1.PartialObjectMetadataList{}
			metadataList.SetGroupVersionKind(corev1.SchemeGroupVersion.WithKind("NamespaceList"))
			Expect(c.List(ctx, metadataList)).To(Succeed())
			Expect(metadataList.Items).NotTo(BeEmpty())

			// A typed Namespace read is a different informer entirely, which is
			// why ManagerClientOptions puts corev1.Namespace in DisableFor.
			err = c.List(ctx, &corev1.NamespaceList{})
			var notCached *cache.ErrResourceNotCached
			Expect(errors.As(err, &notCached)).To(BeTrue(),
				"typed Namespace reads must not be served by the metadata informer, got %v", err)
			Expect(notCached.GVK).To(Equal(corev1.SchemeGroupVersion.WithKind("Namespace")))
		})
	})
})

func deploymentFixture(name, namespace string, labels map[string]string) *appsv1.Deployment {
	selector := map[string]string{"app": name}
	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace, Labels: labels},
		Spec: appsv1.DeploymentSpec{
			Selector: &metav1.LabelSelector{MatchLabels: selector},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: selector},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{{Name: "c", Image: "registry.example.com/pause:latest"}},
				},
			},
		},
	}
}
