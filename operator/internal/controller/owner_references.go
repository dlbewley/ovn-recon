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
	"errors"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	reconv1beta1 "github.com/dlbewley/ovn-recon-operator/api/v1beta1"
)

// setManagedOwner points a managed resource back at the OvnRecon that created
// it, so the garbage collector reaps it if the finalizer never runs.
//
// This works for every resource this operator manages, including the
// RoleBindings it creates in the collector probe namespaces. OvnRecon is
// cluster-scoped, so it has no namespace of its own: controllerutil's
// validateOwner short-circuits, the cross-namespace prohibition does not
// apply, and cluster-scoped dependents are fine too because their owner is
// itself cluster-scoped. Being cluster-scoped is what makes ownership
// universally available here, not what prevents it.
//
// blockOwnerDeletion is deliberately false. It only takes effect during
// foreground cascading deletion, the finalizer already sequences teardown, and
// leaving it unset avoids any dependency on the OwnerReferencesPermissionEnforcement
// admission plugin.
//
// This is a backstop, not a replacement for the finalizer. Garbage collection
// gives no ordering guarantees, and the plugin must be de-registered from the
// Console operator before its ConsolePlugin is removed.
func setManagedOwner(ovnRecon *reconv1beta1.OvnRecon, obj client.Object, scheme *runtime.Scheme) error {
	if err := controllerutil.SetControllerReference(ovnRecon, obj, scheme,
		controllerutil.WithBlockOwnerDeletion(false)); err != nil {
		var alreadyOwned *controllerutil.AlreadyOwnedError
		if !errors.As(err, &alreadyOwned) {
			return err
		}
		// Something already claims to control this object. If it is a stale
		// OvnRecon - the usual case is a CR deleted and recreated under the
		// same name, leaving resources behind with the previous UID - take it
		// over. Anything else is genuinely foreign and must not be touched.
		if !isStaleOvnReconOwner(alreadyOwned.Owner) {
			return fmt.Errorf("refusing to adopt %s/%s: already controlled by %s %s",
				obj.GetNamespace(), obj.GetName(), alreadyOwned.Owner.Kind, alreadyOwned.Owner.Name)
		}
		dropControllerRef(obj)
		if err := controllerutil.SetControllerReference(ovnRecon, obj, scheme,
			controllerutil.WithBlockOwnerDeletion(false)); err != nil {
			return err
		}
	}
	return nil
}

// isStaleOvnReconOwner reports whether an existing controller reference points
// at an OvnRecon. SetControllerReference only raises AlreadyOwnedError when the
// reference does not match the owner being set, so an OvnRecon here is always a
// different one - a previous generation of the same CR, or a former primary.
func isStaleOvnReconOwner(ref metav1.OwnerReference) bool {
	return ref.Kind == "OvnRecon" &&
		ref.APIVersion == reconv1beta1.GroupVersion.String()
}

func dropControllerRef(obj client.Object) {
	refs := obj.GetOwnerReferences()
	kept := make([]metav1.OwnerReference, 0, len(refs))
	for _, ref := range refs {
		if ref.Controller != nil && *ref.Controller {
			continue
		}
		kept = append(kept, ref)
	}
	obj.SetOwnerReferences(kept)
}
