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

// Package apiversions holds the retired OvnRecon API versions that must stay
// declared on the CRD for upgrade safety, even though they carry no Go types.
package apiversions

import (
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
)

const (
	// CRDName is the OvnRecon CustomResourceDefinition name.
	CRDName = "ovnrecons.recon.bewley.net"

	// RetiredV1alpha1 is the OvnRecon API version that was the storage version
	// from v0.0.4 through v0.2.3-a8 and unserved from v0.3.1-b2 on.
	RetiredV1alpha1 = "v1alpha1"
)

// RetiredV1alpha1Placeholder returns the unserved, non-storage v1alpha1 CRD
// version entry that make manifests appends to the generated CRD.
//
// Why it exists: Kubernetes never removes an entry from a CRD's
// status.storedVersions on its own, so every cluster first installed while
// v1alpha1 was the storage version still lists it. Both the apiserver and OLM
// refuse a CRD update that drops a listed stored version, and OLM applies the
// CRD step before the CSV, so an operator release that removes v1alpha1 can
// never run on those clusters to clean up after itself. The placeholder keeps
// the version declared with a permissive schema (no per-field maintenance,
// which is what ovn-recon-dtq set out to eliminate) while the operator's
// storage migration rewrites objects and clears the stale stored version.
// Removal is tracked in ovn-recon-5uj.
func RetiredV1alpha1Placeholder() apiextensionsv1.CustomResourceDefinitionVersion {
	preserve := true
	return apiextensionsv1.CustomResourceDefinitionVersion{
		Name:    RetiredV1alpha1,
		Served:  false,
		Storage: false,
		Schema: &apiextensionsv1.CustomResourceValidation{
			OpenAPIV3Schema: &apiextensionsv1.JSONSchemaProps{
				Description: "Retired OvnRecon API version kept declared only so " +
					"clusters that once stored objects as v1alpha1 can upgrade; it is " +
					"not served. The operator clears it from status.storedVersions on " +
					"startup. Use recon.bewley.net/v1beta1.",
				Type:                   "object",
				XPreserveUnknownFields: &preserve,
			},
		},
	}
}
