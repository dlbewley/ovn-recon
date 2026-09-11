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
//
// Every field is optional and an empty spec is a complete, working install.
// Defaults are applied by the operator at reconcile time, not by the CRD
// schema, so an omitted field stays omitted in the stored object and follows
// the operator's current default across upgrades. The values the operator
// actually resolved are published in status.effective.
type OvnReconSpec struct {
	// TargetNamespace is where the OVN Recon workload and Service are created.
	// Defaults to "ovn-recon" when omitted.
	// +kubebuilder:validation:MinLength=1
	TargetNamespace string `json:"targetNamespace,omitempty"`

	// Operator configuration.
	Operator OperatorSpec `json:"operator,omitempty"`

	// ConsolePlugin configuration
	ConsolePlugin ConsolePluginSpec `json:"consolePlugin,omitempty"`

	// Collector configuration.
	Collector CollectorSpec `json:"collector,omitempty"`
}

type ImageSpec struct {
	// Repository is the plugin container image, without a tag. Leave it
	// unset to run the image the operator release declares (RELATED_IMAGE_PLUGIN,
	// which mirrored installs rewrite); the built-in fallback is
	// quay.io/dbewley/ovn-recon.
	Repository string `json:"repository,omitempty"`
	// Tag overrides the image tag. Defaults to the operator's own release
	// version, so the plugin upgrades in lockstep with the operator.
	Tag string `json:"tag,omitempty"`
	// PullPolicy for the plugin container. Defaults to IfNotPresent.
	PullPolicy string `json:"pullPolicy,omitempty"`
}

type CollectorImageSpec struct {
	// Repository is the collector container image, without a tag. Leave it
	// unset to run the image the operator release declares
	// (RELATED_IMAGE_COLLECTOR, which mirrored installs rewrite); the built-in
	// fallback is quay.io/dbewley/ovn-collector.
	Repository string `json:"repository,omitempty"`
	// Tag overrides the image tag. Defaults to the console plugin's tag, so
	// the collector upgrades in lockstep with the plugin.
	Tag string `json:"tag,omitempty"`
	// PullPolicy for the collector container. Defaults to the console
	// plugin's pull policy.
	PullPolicy string `json:"pullPolicy,omitempty"`
}

type OperatorSpec struct {
	// Logging controls for the operator controller.
	Logging OperatorLoggingSpec `json:"logging,omitempty"`
}

type OperatorLoggingSpec struct {
	// Level sets the operator controller's log verbosity. Defaults to info.
	// +kubebuilder:validation:Enum=error;warn;info;debug;trace
	Level string `json:"level,omitempty"`

	// Events controls Kubernetes Event behavior from the operator.
	Events OperatorEventsSpec `json:"events,omitempty"`
}

type OperatorEventsSpec struct {
	// MinType is the least severe Kubernetes Event type the operator emits:
	// Normal records routine reconcile progress, Warning restricts events to
	// problems. Defaults to Normal.
	// +kubebuilder:validation:Enum=Normal;Warning
	MinType string `json:"minType,omitempty"`

	// DedupeWindow suppresses repeat events with the same reason within this
	// duration (Go duration syntax, e.g. "5m"). Defaults to 5m.
	DedupeWindow string `json:"dedupeWindow,omitempty"`
}

type ConsolePluginSpec struct {
	// DisplayName is shown for the plugin in the console UI. Defaults to
	// "OVN Recon".
	DisplayName string `json:"displayName,omitempty"`

	// Enabled auto-registers the plugin in the Console operator configuration.
	// Defaults to true — the plugin appears in the console without further
	// action. Set false to deploy the plugin resources without registering.
	Enabled *bool `json:"enabled,omitempty"`

	// Image configuration for the plugin container.
	Image ImageSpec `json:"image,omitempty"`

	// Logging controls for the console plugin backend.
	Logging ConsolePluginLoggingSpec `json:"logging,omitempty"`
}

type ConsolePluginLoggingSpec struct {
	// Level sets the plugin backend's log verbosity. Defaults to info.
	// +kubebuilder:validation:Enum=error;warn;info;debug
	Level string `json:"level,omitempty"`

	// AccessLog controls per-request access logging in the plugin backend.
	AccessLog AccessLogSpec `json:"accessLog,omitempty"`
}

type AccessLogSpec struct {
	// Enabled logs every HTTP request served by the plugin backend.
	// Defaults to false.
	Enabled bool `json:"enabled,omitempty"`
}

type CollectorSpec struct {
	// Enabled toggles logical topology features backed by the collector service.
	// Defaults to true; set false to disable the collector and the logical views.
	Enabled *bool `json:"enabled,omitempty"`

	// Image configuration for the OVN collector container image.
	Image CollectorImageSpec `json:"image,omitempty"`

	// ProbeNamespaces defines namespaces where collector is allowed to probe OVN pods.
	// Defaults to openshift-ovn-kubernetes and openshift-frr-k8s.
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
	Enabled *bool `json:"enabled,omitempty"`

	// TTLSeconds is how long a cached zone snapshot stays fresh. Defaults to 120.
	// +kubebuilder:validation:Minimum=30
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
	Managed *bool `json:"managed,omitempty"`

	// Size of the managed claim. Defaults to 1Gi: deliberately generous, the
	// cache needs only a few MiB, but some provisioners enforce minimum sizes.
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
	Level string `json:"level,omitempty"`

	// IncludeProbeOutput logs the raw output of every ovn-nbctl/ovn-sbctl
	// probe command the collector runs. Verbose — each snapshot logs the
	// full northbound table dumps — so enable only while diagnosing
	// collection problems. Defaults to false.
	IncludeProbeOutput bool `json:"includeProbeOutput,omitempty"`
}

// OvnReconStatus defines the observed state of OvnRecon.
type OvnReconStatus struct {
	// Conditions represent the latest available observations of an object's state
	Conditions []metav1.Condition `json:"conditions,omitempty"`

	// Effective is the configuration the operator resolved and is acting on:
	// spec values where set, otherwise the operator's defaults and the images
	// the operator release declares. It is what an explicit spec would have to
	// say to reproduce the current behaviour, and the place to look when the
	// spec is sparse.
	// +optional
	Effective *EffectiveConfig `json:"effective,omitempty"`
}

// EffectiveConfig is the resolved configuration for one generation of the spec.
type EffectiveConfig struct {
	// ObservedGeneration is the spec generation these values were resolved from.
	ObservedGeneration int64 `json:"observedGeneration"`
	// TargetNamespace is where the workload runs.
	TargetNamespace string `json:"targetNamespace"`
	// Operator is the resolved operator policy. Log and event policy follow
	// the primary OvnRecon, so these can differ from this object's spec.
	Operator EffectiveOperator `json:"operator"`
	// ConsolePlugin is the resolved console plugin configuration.
	ConsolePlugin EffectiveConsolePlugin `json:"consolePlugin"`
	// Collector is the resolved collector configuration.
	Collector EffectiveCollector `json:"collector"`
}

type EffectiveOperator struct {
	// LogLevel the operator controller runs at.
	LogLevel string `json:"logLevel"`
	// EventMinType is the least severe Kubernetes Event type emitted.
	EventMinType string `json:"eventMinType"`
	// EventDedupeWindow suppresses repeat events with the same reason.
	EventDedupeWindow string `json:"eventDedupeWindow"`
}

type EffectiveConsolePlugin struct {
	// Enabled reports whether the plugin is registered with the console.
	Enabled bool `json:"enabled"`
	// DisplayName shown in the console.
	DisplayName string `json:"displayName"`
	// Image is the full plugin image reference the Deployment runs.
	Image string `json:"image"`
	// PullPolicy of the plugin container.
	PullPolicy string `json:"pullPolicy"`
	// LogLevel of the plugin backend.
	LogLevel string `json:"logLevel"`
	// AccessLog reports whether per-request access logging is on.
	AccessLog bool `json:"accessLog"`
}

type EffectiveCollector struct {
	// Enabled reports whether the collector and logical topology views run.
	Enabled bool `json:"enabled"`
	// Image is the full collector image reference the Deployment runs.
	Image string `json:"image"`
	// PullPolicy of the collector container.
	PullPolicy string `json:"pullPolicy"`
	// ProbeNamespaces the collector may exec into.
	ProbeNamespaces []string `json:"probeNamespaces"`
	// LogLevel of the collector.
	LogLevel string `json:"logLevel"`
	// IncludeProbeOutput reports whether raw probe output is logged.
	IncludeProbeOutput bool `json:"includeProbeOutput"`
	// Cache is the resolved snapshot cache configuration.
	Cache EffectiveCollectorCache `json:"cache"`
}

type EffectiveCollectorCache struct {
	// Enabled reports whether snapshot caching is on.
	Enabled bool `json:"enabled"`
	// TTLSeconds is the freshness window after the floor was applied.
	TTLSeconds int32 `json:"ttlSeconds"`
	// Mode is the requested backing: auto, EmptyDir or PVC.
	Mode string `json:"mode"`
	// Backing is what the collector Deployment actually mounts, PVC or
	// EmptyDir, after any auto-mode fallback. Empty while the collector is
	// disabled.
	// +optional
	Backing string `json:"backing,omitempty"`
	// FallbackReason explains an auto-mode fallback to EmptyDir.
	// +optional
	FallbackReason string `json:"fallbackReason,omitempty"`
	// ClaimName is the PersistentVolumeClaim used or created for the cache.
	// +optional
	ClaimName string `json:"claimName,omitempty"`
	// Managed reports whether the operator creates and owns the claim.
	Managed bool `json:"managed"`
	// Size of the managed claim.
	// +optional
	Size string `json:"size,omitempty"`
	// StorageClassName of the managed claim; empty means the cluster default.
	// +optional
	StorageClassName string `json:"storageClassName,omitempty"`
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
