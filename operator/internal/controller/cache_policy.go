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
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/labels"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// Label key/value stamped on every resource this operator creates. These are
// the source of truth for both labelsForOvnRecon and the informer filter in
// ManagerCacheOptions: if the two ever drift, managed objects become invisible
// to the cache and the operator fights itself.
const (
	ManagedByLabelKey   = "app.kubernetes.io/name"
	ManagedByLabelValue = "ovn-recon"
)

// ManagedResourceSelector matches only resources created by this operator.
func ManagedResourceSelector() labels.Selector {
	return labels.SelectorFromSet(labels.Set{ManagedByLabelKey: ManagedByLabelValue})
}

// ManagerCacheOptions returns the manager's informer policy.
//
// Without an explicit Cache, controller-runtime lazily spawns a *cluster-wide*
// informer (LIST+WATCH over every object of that type, in every namespace) the
// first time the cached client touches a type. OvnRecon is cluster-scoped with
// a per-CR target namespace, so DefaultNamespaces scoping is not viable; the
// label the operator already stamps on everything it creates is.
//
// Cached here, label-filtered:
//
//   - appsv1.Deployment - read on every reconcile by checkDeploymentReady and
//     by the plugin/collector CreateOrUpdate paths.
//   - corev1.Service    - read on every reconcile by the plugin/collector
//     CreateOrUpdate paths.
//
// Everything else is either served by an existing informer or read live; see
// ManagerClientOptions.
func ManagerCacheOptions() cache.Options {
	selector := ManagedResourceSelector()
	return cache.Options{
		ByObject: map[client.Object]cache.ByObject{
			&appsv1.Deployment{}: {Label: selector},
			&corev1.Service{}:    {Label: selector},
		},
		// ReaderFailOnMissingInformer is deliberately left off. It would turn
		// an unconfigured cached read into a loud error instead of a silent
		// cluster-wide informer, but it also makes every future cached type an
		// outage rather than a regression. Revisit under the T7 validation
		// bead once the informer footprint is measured.
	}
}

// ManagerClientOptions returns the cached client's read policy.
//
// Uncached (always a live API read):
//
//   - corev1.Namespace      - existence checks only (ensureTargetNamespaceExists,
//     the collector probe-namespace loop). The Namespace informer that backs the
//     probe-namespace watch is metadata-only, so it cannot serve typed reads.
//   - corev1.ServiceAccount,
//     rbacv1.ClusterRole,
//     rbacv1.RoleBinding    - collector access controls, written rarely and read
//     only inside CreateOrUpdate. Not worth a cluster-wide informer.
//
// Unstructured is pinned to false (also the controller-runtime default) so the
// ConsolePlugin (console.openshift.io/v1) and Console (operator.openshift.io/v1)
// reads keep bypassing the cache. This is what makes the unstructured access in
// ovnrecon_controller.go safe today, and pinning it explicitly stops a future
// flip of that flag from silently creating two more cluster-wide informers.
//
// Not listed, and cached on purpose:
//
//   - reconv1beta1.OvnRecon - the For() informer already exists. It is left
//     unfiltered so primaryInstance() sees every CR in the cluster, including
//     CRs created before the operator started stamping labels.
func ManagerClientOptions() client.Options {
	return client.Options{
		Cache: &client.CacheOptions{
			Unstructured: false,
			DisableFor: []client.Object{
				&corev1.Namespace{},
				&corev1.ServiceAccount{},
				&rbacv1.ClusterRole{},
				&rbacv1.RoleBinding{},
			},
		},
	}
}
