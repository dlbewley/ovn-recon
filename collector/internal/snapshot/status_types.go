package snapshot

import "time"

// StatusSchemaVersion is metadata.schemaVersion on GET /api/v1/status
// (collector/api/collector-status.schema.json). The status is its own
// contract, versioned apart from the snapshot payloads.
const StatusSchemaVersion = "1"

// CollectorStatus is the aggregate's envelope without its databases
// (ovn-recon-1zx): what the plugin's collector status line shows (freshness,
// zone count, source health, warnings, warm-up) for a few hundred bytes
// instead of every node's full database. It is collected exactly as the
// aggregate is, so the two agree on every number.
type CollectorStatus struct {
	Metadata ClusterMetadata `json:"metadata"`
	// Zones has one entry per zone the aggregate would carry, in the same order.
	Zones []ZoneStatus `json:"zones"`
	// Warnings are the aggregate's own (ZONE_COLLECTION_FAILED), not the zones'.
	Warnings []Warning `json:"warnings"`
	// WarmUp is present only while the start-up cache sweep runs.
	WarmUp *WarmUp `json:"warmUp,omitempty"`
}

// ZoneStatus is one zone snapshot's metadata and warnings.
type ZoneStatus struct {
	NodeName     string    `json:"nodeName"`
	GeneratedAt  time.Time `json:"generatedAt"`
	SourceHealth string    `json:"sourceHealth"`
	// OVNVersion is NB_Global options:northd_internal_version, when known.
	OVNVersion string    `json:"ovnVersion,omitempty"`
	Warnings   []Warning `json:"warnings"`
}

// WarmUp is the start-up cache sweep's progress: Nodes is how many zones it
// set out to collect (those missing, stale or written by another build), Done
// how many of those it has finished, whether or not the collection worked.
// Nodes is 0 until the sweep has listed the nodes.
type WarmUp struct {
	Nodes int `json:"nodes"`
	Done  int `json:"done"`
}

// ZoneStatusOf reduces a zone snapshot to its status entry.
func ZoneStatusOf(payload LogicalTopologySnapshot) ZoneStatus {
	status := ZoneStatus{
		NodeName:     payload.Metadata.NodeName,
		GeneratedAt:  payload.Metadata.GeneratedAt,
		SourceHealth: payload.Metadata.SourceHealth,
		Warnings:     payload.Warnings,
	}
	if status.Warnings == nil {
		status.Warnings = []Warning{}
	}
	if payload.Database != nil && payload.Database.NBGlobal != nil {
		status.OVNVersion = payload.Database.NBGlobal.Options["northd_internal_version"]
	}
	return status
}
