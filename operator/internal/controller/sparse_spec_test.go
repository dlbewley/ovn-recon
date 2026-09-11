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
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/rand"
	"sigs.k8s.io/controller-runtime/pkg/client"

	reconv1beta1 "github.com/dlbewley/ovn-recon-operator/api/v1beta1"
)

// The CRD carries no schema defaults (ovn-recon-n7t), so what the user writes
// is what is stored. This is the apiserver-level half of the guarantee; the
// controller-level half is TestEmptySpecRendersSameAsExplicitDefaults.
var _ = Describe("OvnRecon sparse spec", func() {
	ctx := context.Background()

	It("stores an empty spec without materializing any defaults", func() {
		cr := &reconv1beta1.OvnRecon{ObjectMeta: metav1.ObjectMeta{Name: "sparse-" + rand.String(6)}}
		Expect(k8sClient.Create(ctx, cr)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, cr) })

		stored := &reconv1beta1.OvnRecon{}
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(cr), stored)).To(Succeed())
		Expect(stored.Spec).To(Equal(reconv1beta1.OvnReconSpec{}),
			"apiserver wrote defaults into the object; the CRD schema must not declare any")
	})

	It("keeps only the fields the user set", func() {
		cr := &reconv1beta1.OvnRecon{
			ObjectMeta: metav1.ObjectMeta{Name: "sparse-" + rand.String(6)},
			Spec:       reconv1beta1.OvnReconSpec{Collector: reconv1beta1.CollectorSpec{Cache: reconv1beta1.CollectorCacheSpec{TTLSeconds: 45}}},
		}
		Expect(k8sClient.Create(ctx, cr)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, cr) })

		stored := &reconv1beta1.OvnRecon{}
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(cr), stored)).To(Succeed())
		Expect(stored.Spec.Collector.Cache.TTLSeconds).To(Equal(int32(45)))
		Expect(stored.Spec.Collector.Enabled).To(BeNil())
		Expect(stored.Spec.Collector.Cache.Storage).To(Equal(reconv1beta1.CollectorCacheStorageSpec{}))
		Expect(stored.Spec.TargetNamespace).To(BeEmpty())
	})
})
