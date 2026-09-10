/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package controller

import (
	"context"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/rand"
	"sigs.k8s.io/controller-runtime/pkg/client"

	reconv1beta1 "github.com/dlbewley/ovn-recon-operator/api/v1beta1"
	"github.com/dlbewley/ovn-recon-operator/internal/apiversions"
	"github.com/dlbewley/ovn-recon-operator/internal/storagemigration"
)

// Lives in the controller suite to reuse its envtest environment; the
// migrator itself is in internal/storagemigration.
var _ = Describe("OvnRecon stored version migration", func() {
	ctx := context.Background()
	crdKey := types.NamespacedName{Name: apiversions.CRDName}

	getCRD := func() *apiextensionsv1.CustomResourceDefinition {
		crd := &apiextensionsv1.CustomResourceDefinition{}
		Expect(k8sClient.Get(ctx, crdKey, crd)).To(Succeed())
		return crd
	}

	// Seed the state an upgraded early install carries: v1alpha1 still listed
	// as stored. The apiserver only accepts this because the placeholder
	// version is declared, which is the whole point of keeping it.
	seedStale := func() {
		crd := getCRD()
		crd.Status.StoredVersions = []string{apiversions.RetiredV1alpha1, "v1beta1"}
		Expect(k8sClient.Status().Update(ctx, crd)).To(Succeed())
		Expect(getCRD().Status.StoredVersions).To(ConsistOf(apiversions.RetiredV1alpha1, "v1beta1"))
	}

	newMigrator := func() *storagemigration.StoredVersionMigrator {
		return &storagemigration.StoredVersionMigrator{
			Reader:  k8sClient,
			Writer:  k8sClient,
			CRDName: apiversions.CRDName,
		}
	}

	It("declares the retired v1alpha1 placeholder alongside the v1beta1 storage version", func() {
		crd := getCRD()
		names := map[string]apiextensionsv1.CustomResourceDefinitionVersion{}
		for _, v := range crd.Spec.Versions {
			names[v.Name] = v
		}
		Expect(names).To(HaveKey("v1beta1"))
		Expect(names["v1beta1"].Served).To(BeTrue())
		Expect(names["v1beta1"].Storage).To(BeTrue())

		Expect(names).To(HaveKey(apiversions.RetiredV1alpha1))
		alpha := names[apiversions.RetiredV1alpha1]
		Expect(alpha.Served).To(BeFalse())
		Expect(alpha.Storage).To(BeFalse())
		Expect(alpha.Schema.OpenAPIV3Schema.XPreserveUnknownFields).To(HaveValue(BeTrue()))
	})

	It("rewrites every object and clears the stale stored version", func() {
		name := "migrate-" + rand.String(6)
		cr := &reconv1beta1.OvnRecon{
			ObjectMeta: metav1.ObjectMeta{Name: name},
			Spec:       reconv1beta1.OvnReconSpec{TargetNamespace: "migrate-target"},
		}
		Expect(k8sClient.Create(ctx, cr)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, cr) })

		seedStale()

		res, err := newMigrator().Migrate(ctx)
		Expect(err).NotTo(HaveOccurred())
		Expect(res.StorageVersion).To(Equal("v1beta1"))
		Expect(res.Stale).To(ConsistOf(apiversions.RetiredV1alpha1))
		Expect(res.Rewritten).To(BeNumerically(">=", 1))

		Expect(getCRD().Status.StoredVersions).To(Equal([]string{"v1beta1"}))

		// The rewrite must be invisible to consumers of the object.
		after := &reconv1beta1.OvnRecon{}
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(cr), after)).To(Succeed())
		Expect(after.Spec.TargetNamespace).To(Equal("migrate-target"))
		Expect(after.Generation).To(Equal(cr.Generation))
	})

	It("is a no-op when only the storage version is stored", func() {
		Expect(getCRD().Status.StoredVersions).To(Equal([]string{"v1beta1"}))

		res, err := newMigrator().Migrate(ctx)
		Expect(err).NotTo(HaveOccurred())
		Expect(res.Stale).To(BeEmpty())
		Expect(res.Rewritten).To(BeZero())
		Expect(getCRD().Status.StoredVersions).To(Equal([]string{"v1beta1"}))
	})

	It("clears the stale stored version even with no objects present", func() {
		seedStale()

		res, err := newMigrator().Migrate(ctx)
		Expect(err).NotTo(HaveOccurred())
		Expect(res.Stale).To(ConsistOf(apiversions.RetiredV1alpha1))
		Expect(getCRD().Status.StoredVersions).To(Equal([]string{"v1beta1"}))
	})

	It("treats a missing CRD as nothing to do", func() {
		m := newMigrator()
		m.CRDName = "does-not-exist.recon.bewley.net"
		res, err := m.Migrate(ctx)
		Expect(err).NotTo(HaveOccurred())
		Expect(res.Stale).To(BeEmpty())
	})

	It("never lets Start fail the manager", func() {
		m := newMigrator()
		m.Writer = nil
		Expect(m.Start(ctx)).To(Succeed())
	})
})
