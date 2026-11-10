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
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	reconv1beta1 "github.com/dlbewley/ovn-recon-operator/api/v1beta1"
)

// removeAllOvnRecons clears every OvnRecon, finalizers included. Reconcile
// adds a finalizer that envtest has no controller to remove, so an object left
// by another spec would stay Terminating, remain the oldest, and make the
// object under test a non-primary that is never resolved.
func removeAllOvnRecons(ctx context.Context) {
	list := &reconv1beta1.OvnReconList{}
	Expect(k8sClient.List(ctx, list)).To(Succeed())
	for i := range list.Items {
		item := &list.Items[i]
		if len(item.Finalizers) > 0 {
			item.Finalizers = nil
			Expect(client.IgnoreNotFound(k8sClient.Update(ctx, item))).To(Succeed())
		}
		Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, item))).To(Succeed())
	}
	Eventually(func(g Gomega) {
		remaining := &reconv1beta1.OvnReconList{}
		g.Expect(k8sClient.List(ctx, remaining)).To(Succeed())
		g.Expect(remaining.Items).To(BeEmpty())
	}).Should(Succeed())
}

// The console integration switches (ovn-recon-zdt.7) gate tabs and actions on
// console pages OVN Recon does not own. The plugin reads them from
// status.effective, so what the apiserver stores and what the controller
// publishes are both part of the contract: unset must be stored as unset and
// published as off.
var _ = Describe("Console integration switches", func() {
	ctx := context.Background()
	const targetNamespace = "ovn-recon-integration-test"

	BeforeEach(func() {
		// Reconcile stops before status.effective when the target namespace
		// is missing. envtest never finishes deleting a namespace, so keep it.
		ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: targetNamespace}}
		Expect(client.IgnoreAlreadyExists(k8sClient.Create(ctx, ns))).To(Succeed())
		removeAllOvnRecons(ctx)
		DeferCleanup(func() { removeAllOvnRecons(ctx) })
	})

	resolve := func(integration reconv1beta1.ConsolePluginIntegrationSpec) (*reconv1beta1.OvnRecon, *reconv1beta1.OvnRecon) {
		cr := &reconv1beta1.OvnRecon{
			ObjectMeta: metav1.ObjectMeta{Name: "integration-sample"},
			Spec: reconv1beta1.OvnReconSpec{
				TargetNamespace: targetNamespace,
				ConsolePlugin:   reconv1beta1.ConsolePluginSpec{Integration: integration},
			},
		}
		Expect(k8sClient.Create(ctx, cr)).To(Succeed())

		stored := &reconv1beta1.OvnRecon{}
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(cr), stored)).To(Succeed())

		reconciler := &OvnReconReconciler{
			Client:   k8sClient,
			Scheme:   k8sClient.Scheme(),
			Recorder: record.NewFakeRecorder(50),
		}
		// envtest has no ConsolePlugin API, so Reconcile errors at that step;
		// status.effective is published before it (see the controller test).
		_, _ = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: client.ObjectKeyFromObject(cr)})

		resolved := &reconv1beta1.OvnRecon{}
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(cr), resolved)).To(Succeed())
		Expect(resolved.Status.Effective).NotTo(BeNil())
		return stored, resolved
	}

	It("stores unset switches as unset and publishes both as off", func() {
		stored, resolved := resolve(reconv1beta1.ConsolePluginIntegrationSpec{})
		Expect(stored.Spec.ConsolePlugin.Integration.ResourceTabs).To(BeNil())
		Expect(stored.Spec.ConsolePlugin.Integration.ResourceActions).To(BeNil())
		Expect(resolved.Status.Effective.ConsolePlugin.Integration).To(Equal(
			reconv1beta1.EffectiveConsolePluginIntegration{ResourceTabs: false, ResourceActions: false}))
	})

	It("publishes switches set to true as on", func() {
		_, resolved := resolve(reconv1beta1.ConsolePluginIntegrationSpec{
			ResourceTabs:    boolPtr(true),
			ResourceActions: boolPtr(true),
		})
		Expect(resolved.Status.Effective.ConsolePlugin.Integration).To(Equal(
			reconv1beta1.EffectiveConsolePluginIntegration{ResourceTabs: true, ResourceActions: true}))
	})

	It("publishes switches set to false as off", func() {
		stored, resolved := resolve(reconv1beta1.ConsolePluginIntegrationSpec{
			ResourceTabs:    boolPtr(false),
			ResourceActions: boolPtr(false),
		})
		Expect(stored.Spec.ConsolePlugin.Integration.ResourceTabs).To(Equal(boolPtr(false)))
		Expect(resolved.Status.Effective.ConsolePlugin.Integration).To(Equal(
			reconv1beta1.EffectiveConsolePluginIntegration{ResourceTabs: false, ResourceActions: false}))
	})

	It("resolves each switch independently", func() {
		_, resolved := resolve(reconv1beta1.ConsolePluginIntegrationSpec{ResourceActions: boolPtr(true)})
		Expect(resolved.Status.Effective.ConsolePlugin.Integration).To(Equal(
			reconv1beta1.EffectiveConsolePluginIntegration{ResourceTabs: false, ResourceActions: true}))
	})
})
