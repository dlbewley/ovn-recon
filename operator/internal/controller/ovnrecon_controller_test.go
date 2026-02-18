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
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	reconv1beta1 "github.com/dlbewley/ovn-recon-operator/api/v1beta1"
)

var _ = Describe("OvnRecon Controller", func() {
	Context("When reconciling a resource", func() {
		const resourceName = "test-resource"
		const targetNamespace = "ovn-recon-test"

		ctx := context.Background()

		typeNamespacedName := types.NamespacedName{
			Name:      resourceName,
			Namespace: "",
		}
		ovnrecon := &reconv1beta1.OvnRecon{}

		BeforeEach(func() {
			By("ensuring the target namespace exists")
			ns := &corev1.Namespace{
				ObjectMeta: metav1.ObjectMeta{
					Name: targetNamespace,
				},
			}
			err := k8sClient.Get(ctx, types.NamespacedName{Name: targetNamespace}, &corev1.Namespace{})
			if err != nil && errors.IsNotFound(err) {
				Expect(k8sClient.Create(ctx, ns)).To(Succeed())
			}

			By("creating the custom resource for the Kind OvnRecon")
			err = k8sClient.Get(ctx, typeNamespacedName, ovnrecon)
			if err != nil && errors.IsNotFound(err) {
				resource := &reconv1beta1.OvnRecon{
					ObjectMeta: metav1.ObjectMeta{
						Name:      resourceName,
						Namespace: "",
					},
					Spec: reconv1beta1.OvnReconSpec{
						TargetNamespace: targetNamespace,
					},
				}
				Expect(k8sClient.Create(ctx, resource)).To(Succeed())
			}
		})

		AfterEach(func() {
			resource := &reconv1beta1.OvnRecon{}
			err := k8sClient.Get(ctx, typeNamespacedName, resource)
			if err == nil {
				By("cleaning up the specific OvnRecon resource instance")
				Expect(k8sClient.Delete(ctx, resource)).To(Succeed())
			}

			ns := &corev1.Namespace{}
			err = k8sClient.Get(ctx, types.NamespacedName{Name: targetNamespace}, ns)
			if err == nil {
				By("cleaning up the target namespace")
				Expect(k8sClient.Delete(ctx, ns)).To(Succeed())
			}
		})
		It("should return an OpenShift API error on envtest without panicking", func() {
			By("Reconciling the created resource")
			controllerReconciler := &OvnReconReconciler{
				Client:   k8sClient,
				Scheme:   k8sClient.Scheme(),
				Recorder: record.NewFakeRecorder(10),
			}

			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespacedName,
			})
			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("ConsolePlugin"))
		})
	})
})
