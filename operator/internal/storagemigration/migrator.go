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

// Package storagemigration clears retired API versions from the OvnRecon
// CRD's status.storedVersions so that a later release can drop them.
//
// This is the same procedure the Kubernetes storage version migrator runs:
// rewrite every object (the apiserver re-encodes it at the current storage
// version), then declare that only the storage version remains stored. It has
// to run from a release that still declares the retired version, because OLM
// applies CRD updates before the CSV and rejects a CRD that removes a version
// still listed as stored. See internal/apiversions for why v1alpha1 is still
// declared and ovn-recon-5uj for its eventual removal.
package storagemigration

import (
	"context"
	"errors"
	"fmt"

	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
)

// The CRD is read by name and its status patched; nothing else in the operator
// touches CRDs, so both grants are pinned to the one resource name.
// +kubebuilder:rbac:groups=apiextensions.k8s.io,resources=customresourcedefinitions,verbs=get,resourceNames=ovnrecons.recon.bewley.net
// +kubebuilder:rbac:groups=apiextensions.k8s.io,resources=customresourcedefinitions/status,verbs=get;update;patch,resourceNames=ovnrecons.recon.bewley.net

// StoredVersionMigrator is a manager Runnable that migrates one CRD's stored
// versions once at startup. It runs only on the leader and never fails the
// manager: a migration error is logged and reconciliation proceeds, because
// the operator is still fully functional with a stale storedVersions list.
type StoredVersionMigrator struct {
	// Reader must be an uncached reader. Reading the CRD through the manager's
	// cached client would spawn a cluster-wide CRD informer for a single
	// object; see internal/controller/cache_policy.go for the policy.
	Reader client.Reader
	// Writer is used for the no-op object patches and the CRD status patch.
	Writer client.Client
	// CRDName is the CustomResourceDefinition to migrate.
	CRDName string
}

// Result reports what a migration run did.
type Result struct {
	// StorageVersion is the CRD's current storage version.
	StorageVersion string
	// Stale lists the stored versions other than StorageVersion found on entry.
	// Empty means the CRD was already clean and nothing was written.
	Stale []string
	// Rewritten is the number of objects patched so the apiserver re-encoded
	// them at StorageVersion.
	Rewritten int
}

// NeedLeaderElection makes the manager start this runnable only on the leader.
func (m *StoredVersionMigrator) NeedLeaderElection() bool { return true }

// Start runs the migration once and returns nil so the manager keeps running.
func (m *StoredVersionMigrator) Start(ctx context.Context) error {
	log := logf.FromContext(ctx).WithName("storage-migration").WithValues("crd", m.CRDName)
	res, err := m.Migrate(ctx)
	switch {
	case err != nil:
		log.Error(err, "stored version migration failed; the next release that "+
			"removes a retired API version will be blocked by OLM until "+
			"status.storedVersions is cleaned manually (see OPERATOR.md)")
	case len(res.Stale) == 0:
		log.V(1).Info("stored versions already clean", "storageVersion", res.StorageVersion)
	default:
		log.Info("cleared retired API versions from status.storedVersions",
			"removed", res.Stale, "storageVersion", res.StorageVersion, "objectsRewritten", res.Rewritten)
	}
	return nil
}

// Migrate performs the migration and returns what it did. It is idempotent.
// The CRD status is only patched after every object was rewritten, so a
// partial failure never declares a version unstored while objects may still
// be encoded in it.
func (m *StoredVersionMigrator) Migrate(ctx context.Context) (Result, error) {
	var res Result
	if m.Reader == nil || m.Writer == nil || m.CRDName == "" {
		return res, errors.New("migrator is missing Reader, Writer or CRDName")
	}

	crd := &apiextensionsv1.CustomResourceDefinition{}
	if err := m.Reader.Get(ctx, types.NamespacedName{Name: m.CRDName}, crd); err != nil {
		if apierrors.IsNotFound(err) {
			return res, nil
		}
		return res, fmt.Errorf("get CRD: %w", err)
	}

	for _, v := range crd.Spec.Versions {
		if v.Storage {
			res.StorageVersion = v.Name
			break
		}
	}
	if res.StorageVersion == "" {
		return res, errors.New("CRD declares no storage version")
	}
	for _, stored := range crd.Status.StoredVersions {
		if stored != res.StorageVersion {
			res.Stale = append(res.Stale, stored)
		}
	}
	if len(res.Stale) == 0 {
		return res, nil
	}

	list := &unstructured.UnstructuredList{}
	list.SetGroupVersionKind(schema.GroupVersionKind{
		Group:   crd.Spec.Group,
		Version: res.StorageVersion,
		Kind:    crd.Spec.Names.ListKind,
	})
	if err := m.Reader.List(ctx, list); err != nil {
		return res, fmt.Errorf("list %s: %w", crd.Spec.Names.Plural, err)
	}

	// An empty merge patch changes nothing the client can see, but the
	// apiserver still re-serializes the object at the storage version and
	// writes it when the stored bytes differ. No resourceVersion is sent, so
	// a concurrent reconcile cannot cause a conflict.
	var failed []error
	for i := range list.Items {
		obj := &list.Items[i]
		if err := m.Writer.Patch(ctx, obj, client.RawPatch(types.MergePatchType, []byte("{}"))); err != nil {
			if apierrors.IsNotFound(err) {
				continue
			}
			failed = append(failed, fmt.Errorf("rewrite %s: %w", obj.GetName(), err))
			continue
		}
		res.Rewritten++
	}
	if len(failed) > 0 {
		return res, errors.Join(failed...)
	}

	patch := fmt.Sprintf(`{"status":{"storedVersions":[%q]}}`, res.StorageVersion)
	if err := m.Writer.Status().Patch(ctx, crd, client.RawPatch(types.MergePatchType, []byte(patch))); err != nil {
		return res, fmt.Errorf("patch CRD status.storedVersions: %w", err)
	}
	return res, nil
}
