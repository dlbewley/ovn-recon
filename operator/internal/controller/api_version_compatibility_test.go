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
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/rand"

	reconv1alpha1 "github.com/dlbewley/ovn-recon-operator/api/v1alpha1"
	reconv1beta1 "github.com/dlbewley/ovn-recon-operator/api/v1beta1"
)

var _ = Describe("OvnRecon API Version Policy", func() {
	It("rejects v1alpha1 resources", func() {
		ctx := context.Background()
		name := "compat-alpha-" + rand.String(6)

		alpha := &reconv1alpha1.OvnRecon{
			ObjectMeta: metav1.ObjectMeta{Name: name},
			Spec: reconv1alpha1.OvnReconSpec{
				TargetNamespace: "compat-alpha",
			},
		}
		err := k8sClient.Create(ctx, alpha)
		Expect(err).To(HaveOccurred())
		Expect(apierrors.IsNotFound(err) || meta.IsNoMatchError(err)).To(BeTrue())
	})

	It("accepts v1beta1 resources", func() {
		ctx := context.Background()
		name := "compat-beta-" + rand.String(6)

		beta := &reconv1beta1.OvnRecon{
			ObjectMeta: metav1.ObjectMeta{Name: name},
			Spec: reconv1beta1.OvnReconSpec{
				TargetNamespace: "compat-beta",
			},
		}
		Expect(k8sClient.Create(ctx, beta)).To(Succeed())
		DeferCleanup(func() {
			_ = k8sClient.Delete(ctx, beta)
		})

		retrieved := &reconv1beta1.OvnRecon{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: name}, retrieved)).To(Succeed())
		Expect(retrieved.Spec.TargetNamespace).To(Equal("compat-beta"))
	})
})
