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

// Package apiversions pins the OvnRecon CRD's identity and API version
// policy, and tests that the generated CRD honors it.
//
// History: v1alpha1 was the storage version from v0.0.4 through v0.2.3-a8 and
// unserved from v0.3.1-b2. Its Go types were removed in v1.0.3-a5
// (ovn-recon-dtq), which stalled OLM upgrades on clusters that still listed
// it in status.storedVersions, so v1.0.4 and v1.0.5 declared it again as an
// unserved placeholder while a startup migration cleared the stale entry
// (ovn-recon-crv). The placeholder was dropped in ovn-recon-5uj and the
// migration removed in ovn-recon-0cl; the CRD now declares v1beta1 alone.
package apiversions

const (
	// CRDName is the OvnRecon CustomResourceDefinition name.
	CRDName = "ovnrecons.recon.bewley.net"

	// StorageVersion is the one API version the CRD declares, serves and
	// stores.
	StorageVersion = "v1beta1"
)
