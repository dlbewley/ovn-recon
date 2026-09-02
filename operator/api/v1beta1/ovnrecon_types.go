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

package v1beta1

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

	// Operator configuration.
	Operator OperatorSpec `json:"operator,omitempty"`

	// ConsolePlugin configuration
	ConsolePlugin ConsolePluginSpec `json:"consolePlugin,omitempty"`

	// Collector configuration.
	Collector CollectorSpec `json:"collector,omitempty"`

	// Deprecated: use consolePlugin.image instead.
	// Image configuration for the plugin container.
	Image ImageSpec `json:"image,omitempty"`

	// Deprecated: use collector.enabled instead.
	// FeatureGates controls optional OVN Recon capabilities.
	FeatureGates FeatureGateSpec `json:"featureGates,omitempty"`

	// Deprecated: use collector.image instead.
	// CollectorImage configuration for the OVN collector container image.
	CollectorImage LegacyCollectorImageSpec `json:"collectorImage,omitempty"`

	// Deprecated: use collector.probeNamespaces instead.
	// CollectorProbeNamespaces defines namespaces where collector is allowed to probe OVN pods.
	CollectorProbeNamespaces []string `json:"collectorProbeNamespaces,omitempty"`
}

type ImageSpec struct {
	// Repository is the plugin container image, without a tag.
	// +kubebuilder:default=quay.io/dbewley/ovn-recon
	Repository string `json:"repository,omitempty"`
	// Tag overrides the image tag. Defaults to the operator's own release
	// version, so the plugin upgrades in lockstep with the operator.
	Tag string `json:"tag,omitempty"`
	// PullPolicy for the plugin container. Defaults to IfNotPresent.
	PullPolicy string `json:"pullPolicy,omitempty"`
}

type CollectorImageSpec struct {
	// Repository is the collector container image, without a tag.
	// +kubebuilder:default=quay.io/dbewley/ovn-collector
	Repository string `json:"repository,omitempty"`
	// Tag overrides the image tag. Defaults to the console plugin's tag, so
	// the collector upgrades in lockstep with the plugin.
	Tag string `json:"tag,omitempty"`
	// PullPolicy for the collector container. Defaults to the console
	// plugin's pull policy.
	PullPolicy string `json:"pullPolicy,omitempty"`
}

type LegacyCollectorImageSpec struct {
	// Repository is the collector container image, without a tag.
	Repository string `json:"repository,omitempty"`
	// Tag overrides the image tag.
	Tag string `json:"tag,omitempty"`
	// PullPolicy for the collector container.
	PullPolicy string `json:"pullPolicy,omitempty"`
}

type OperatorSpec struct {
	// Logging controls for the operator controller.
	Logging OperatorLoggingSpec `json:"logging,omitempty"`
}

type OperatorLoggingSpec struct {
	// Level sets the operator controller's log verbosity. Defaults to info.
	// +kubebuilder:validation:Enum=error;warn;info;debug;trace
	// +kubebuilder:default=info
	Level string `json:"level,omitempty"`

	// Events controls Kubernetes Event behavior from the operator.
	Events OperatorEventsSpec `json:"events,omitempty"`
}

type OperatorEventsSpec struct {
	// MinType is the least severe Kubernetes Event type the operator emits:
	// Normal records routine reconcile progress, Warning restricts events to
	// problems. Defaults to Normal.
	// +kubebuilder:validation:Enum=Normal;Warning
	// +kubebuilder:default=Normal
	MinType string `json:"minType,omitempty"`

	// DedupeWindow suppresses repeat events with the same reason within this
	// duration (Go duration syntax, e.g. "5m"). Defaults to 5m.
	// +kubebuilder:default:="5m"
	DedupeWindow string `json:"dedupeWindow,omitempty"`
}

type ConsolePluginSpec struct {
	// DisplayName is shown for the plugin in the console UI. Defaults to
	// "OVN Recon".
	DisplayName string `json:"displayName,omitempty"`

	// Enabled auto-registers the plugin in the Console operator configuration.
	// Defaults to true — the plugin appears in the console without further
	// action. Set false to deploy the plugin resources without registering.
	// +kubebuilder:default=true
	Enabled *bool `json:"enabled,omitempty"`

	// Image configuration for the plugin container.
	Image ImageSpec `json:"image,omitempty"`

	// Logging controls for the console plugin backend.
	Logging ConsolePluginLoggingSpec `json:"logging,omitempty"`
}

type ConsolePluginLoggingSpec struct {
	// Level sets the plugin backend's log verbosity. Defaults to info.
	// +kubebuilder:validation:Enum=error;warn;info;debug
	// +kubebuilder:default=info
	Level string `json:"level,omitempty"`

	// AccessLog controls per-request access logging in the plugin backend.
	AccessLog AccessLogSpec `json:"accessLog,omitempty"`
}

type AccessLogSpec struct {
	// Enabled logs every HTTP request served by the plugin backend.
	// Defaults to false.
	// +kubebuilder:default=false
	Enabled bool `json:"enabled,omitempty"`
}

type CollectorSpec struct {
	// Enabled toggles logical topology features backed by the collector service.
	// Defaults to true; set false to disable the collector and the logical views.
	// +kubebuilder:default=true
	Enabled *bool `json:"enabled,omitempty"`

	// Image configuration for the OVN collector container image.
	Image CollectorImageSpec `json:"image,omitempty"`

	// ProbeNamespaces defines namespaces where collector is allowed to probe OVN pods.
	// +kubebuilder:default:={"openshift-ovn-kubernetes","openshift-frr-k8s"}
	ProbeNamespaces []string `json:"probeNamespaces,omitempty"`

	// Logging controls for the collector service.
	Logging CollectorLoggingSpec `json:"logging,omitempty"`

	// Cache controls collector-side snapshot caching.
	Cache CollectorCacheSpec `json:"cache,omitempty"`
}

// CollectorCacheSpec configures disk-backed caching of zone snapshots.
// Cached snapshots are served while younger than the TTL and recollected on
// expiry; on live-probe failure a stale cache entry is served (flagged
// SNAPSHOT_STALE) in preference to fixture data.
type CollectorCacheSpec struct {
	// Enabled toggles the snapshot cache. Defaults to true.
	// +kubebuilder:default=true
	Enabled *bool `json:"enabled,omitempty"`

	// TTLSeconds is how long a cached zone snapshot stays fresh.
	// +kubebuilder:validation:Minimum=30
	// +kubebuilder:default=120
	TTLSeconds int32 `json:"ttlSeconds,omitempty"`

	// Storage selects the volume backing the cache directory.
	Storage CollectorCacheStorageSpec `json:"storage,omitempty"`
}

type CollectorCacheStorageSpec struct {
	// Mode selects the cache backing. auto (the default) uses a PVC — the
	// managed claim, or claimName — and falls back to EmptyDir with a
	// Warning event when the claim cannot be provisioned. EmptyDir forces
	// ephemeral storage and never creates or mounts a PVC, even with
	// managed true. PVC requires persistent storage and never falls back;
	// provisioning failures are surfaced instead.
	// +kubebuilder:validation:Enum=auto;EmptyDir;PVC
	// +kubebuilder:default=auto
	Mode string `json:"mode,omitempty"`

	// ClaimName names an existing PersistentVolumeClaim to mount instead of
	// the managed claim. Ignored when mode is EmptyDir.
	ClaimName string `json:"claimName,omitempty"`

	// Managed has the operator create and own the claim (RWO, owner-referenced
	// to the OvnRecon for garbage collection), so PVC caching needs no
	// pre-provisioned claim. Defaults to true; an explicit false removes a
	// previously managed claim. When claimName is empty a default of
	// "<collector>-cache" is used. Users who need RWX or special claim
	// settings should pre-create their own claim and set managed false.
	// +kubebuilder:default=true
	Managed *bool `json:"managed,omitempty"`

	// Size of the managed claim. Deliberately generous default — the cache
	// needs only a few MiB, but some provisioners enforce minimum sizes.
	// +kubebuilder:default="1Gi"
	Size string `json:"size,omitempty"`

	// StorageClassName for the managed claim; empty uses the cluster default.
	StorageClassName string `json:"storageClassName,omitempty"`
}

// CollectorLoggingSpec controls the collector service's log output.
type CollectorLoggingSpec struct {
	// Level sets the collector log verbosity. Defaults to info. At debug the
	// collector logs each probe command and cache decision; trace adds
	// per-request detail.
	// +kubebuilder:validation:Enum=error;warn;info;debug;trace
	// +kubebuilder:default=info
	Level string `json:"level,omitempty"`

	// IncludeProbeOutput logs the raw output of every ovn-nbctl/ovn-sbctl
	// probe command the collector runs. Verbose — each snapshot logs the
	// full northbound table dumps — so enable only while diagnosing
	// collection problems. Defaults to false.
	// +kubebuilder:default=false
	IncludeProbeOutput bool `json:"includeProbeOutput,omitempty"`
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
// +kubebuilder:storageversion

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
