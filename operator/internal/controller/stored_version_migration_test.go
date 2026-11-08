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

// retiredVersion stands in for v1alpha1, which v1.0.4 and v1.0.5 declared as
// an unserved placeholder so this migration could clear it (ovn-recon-crv).
// The shipped CRD no longer declares it (ovn-recon-5uj); the tests declare it
// temporarily to exercise the migrator.
const retiredVersion = "v1alpha1"

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

	// Seed the state an install upgraded from before v1.0.4 carried: a
	// retired version still listed as stored. The apiserver only accepts a
	// stored version the spec declares, so the test declares one (unserved,
	// non-storage, as the v1.0.4/v1.0.5 placeholder was) for its duration and
	// removes it again on cleanup. The shipped CRD declares v1beta1 alone.
	seedStale := func() {
		preserve := true
		crd := getCRD()
		crd.Spec.Versions = append(crd.Spec.Versions, apiextensionsv1.CustomResourceDefinitionVersion{
			Name:    retiredVersion,
			Served:  false,
			Storage: false,
			Schema: &apiextensionsv1.CustomResourceValidation{
				OpenAPIV3Schema: &apiextensionsv1.JSONSchemaProps{
					Type:                   "object",
					XPreserveUnknownFields: &preserve,
				},
			},
		})
		Expect(k8sClient.Update(ctx, crd)).To(Succeed())
		DeferCleanup(func() {
			// A declared version cannot be removed while still listed as
			// stored, so clear the list first in case the spec failed.
			crd := getCRD()
			crd.Status.StoredVersions = []string{apiversions.StorageVersion}
			Expect(k8sClient.Status().Update(ctx, crd)).To(Succeed())
			crd = getCRD()
			kept := crd.Spec.Versions[:0]
			for _, v := range crd.Spec.Versions {
				if v.Name != retiredVersion {
					kept = append(kept, v)
				}
			}
			crd.Spec.Versions = kept
			Expect(k8sClient.Update(ctx, crd)).To(Succeed())
			Expect(getCRD().Spec.Versions).To(HaveLen(1))
		})

		crd = getCRD()
		crd.Status.StoredVersions = []string{retiredVersion, apiversions.StorageVersion}
		Expect(k8sClient.Status().Update(ctx, crd)).To(Succeed())
		Expect(getCRD().Status.StoredVersions).To(ConsistOf(retiredVersion, apiversions.StorageVersion))
	}

	newMigrator := func() *storagemigration.StoredVersionMigrator {
		return &storagemigration.StoredVersionMigrator{
			Reader:  k8sClient,
			Writer:  k8sClient,
			CRDName: apiversions.CRDName,
		}
	}

	It("declares v1beta1 as the only version, served and stored", func() {
		crd := getCRD()
		Expect(crd.Spec.Versions).To(HaveLen(1))
		v := crd.Spec.Versions[0]
		Expect(v.Name).To(Equal(apiversions.StorageVersion))
		Expect(v.Served).To(BeTrue())
		Expect(v.Storage).To(BeTrue())
		Expect(crd.Status.StoredVersions).To(Equal([]string{apiversions.StorageVersion}))
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
		Expect(res.StorageVersion).To(Equal(apiversions.StorageVersion))
		Expect(res.Stale).To(ConsistOf(retiredVersion))
		Expect(res.Rewritten).To(BeNumerically(">=", 1))

		Expect(getCRD().Status.StoredVersions).To(Equal([]string{apiversions.StorageVersion}))

		// The rewrite must be invisible to consumers of the object.
		after := &reconv1beta1.OvnRecon{}
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(cr), after)).To(Succeed())
		Expect(after.Spec.TargetNamespace).To(Equal("migrate-target"))
		Expect(after.Generation).To(Equal(cr.Generation))
	})

	It("is a no-op when only the storage version is stored", func() {
		Expect(getCRD().Status.StoredVersions).To(Equal([]string{apiversions.StorageVersion}))

		res, err := newMigrator().Migrate(ctx)
		Expect(err).NotTo(HaveOccurred())
		Expect(res.Stale).To(BeEmpty())
		Expect(res.Rewritten).To(BeZero())
		Expect(getCRD().Status.StoredVersions).To(Equal([]string{apiversions.StorageVersion}))
	})

	It("clears the stale stored version even with no objects present", func() {
		seedStale()

		res, err := newMigrator().Migrate(ctx)
		Expect(err).NotTo(HaveOccurred())
		Expect(res.Stale).To(ConsistOf(retiredVersion))
		Expect(getCRD().Status.StoredVersions).To(Equal([]string{apiversions.StorageVersion}))
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
