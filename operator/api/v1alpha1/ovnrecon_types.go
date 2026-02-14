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

package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// EDIT THIS FILE!  THIS IS SCAFFOLDING FOR YOU TO OWN!
// NOTE: json tags are required.  Any new fields you add must have json tags for the fields to be serialized.

// OvnReconSpec defines the desired state of OvnRecon.
type OvnReconSpec struct {
	// TargetNamespace is where the OVN Recon workload and Service are created.
	// Defaults to "ovn-recon" when omitted.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:default=ovn-recon
	TargetNamespace string `json:"targetNamespace,omitempty"`

	// Image configuration for the plugin container
	Image ImageSpec `json:"image,omitempty"`

	// ConsolePlugin configuration
	ConsolePlugin ConsolePluginSpec `json:"consolePlugin,omitempty"`

	// FeatureGates controls optional OVN Recon capabilities.
	FeatureGates FeatureGateSpec `json:"featureGates,omitempty"`

	// CollectorImage configuration for the OVN collector container image.
	CollectorImage CollectorImageSpec `json:"collectorImage,omitempty"`

	// CollectorProbeNamespaces defines namespaces where collector is allowed to probe OVN pods.
	// +kubebuilder:default:={"openshift-ovn-kubernetes","openshift-frr-k8s"}
	CollectorProbeNamespaces []string `json:"collectorProbeNamespaces,omitempty"`
}

type ImageSpec struct {
	Repository string `json:"repository,omitempty"`
	Tag        string `json:"tag,omitempty"`
	PullPolicy string `json:"pullPolicy,omitempty"`
}

type CollectorImageSpec struct {
	// +kubebuilder:default=quay.io/dbewley/ovn-collector
	Repository string `json:"repository,omitempty"`
	Tag        string `json:"tag,omitempty"`
	PullPolicy string `json:"pullPolicy,omitempty"`
}

type ConsolePluginSpec struct {
	DisplayName string `json:"displayName,omitempty"`
	Enabled     bool   `json:"enabled,omitempty"`
}

type FeatureGateSpec struct {
	// OVNCollector enables logical topology features backed by the collector service.
	// +kubebuilder:default=false
	OVNCollector bool `json:"ovn-collector,omitempty"`
}

// OvnReconStatus defines the observed state of OvnRecon.
type OvnReconStatus struct {
	// Conditions represent the latest available observations of an object's state
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:resource:scope=Cluster
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status

// OvnRecon is the Schema for the ovnrecons API.
type OvnRecon struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   OvnReconSpec   `json:"spec,omitempty"`
	Status OvnReconStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// OvnReconList contains a list of OvnRecon.
type OvnReconList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []OvnRecon `json:"items"`
}

func init() {
	SchemeBuilder.Register(&OvnRecon{}, &OvnReconList{})
}
