package snapshot

import "time"

// Metadata captures collection metadata returned with each snapshot.
type Metadata struct {
	SchemaVersion string    `json:"schemaVersion"`
	GeneratedAt   time.Time `json:"generatedAt"`
	SourceHealth  string    `json:"sourceHealth"`
	NodeName      string    `json:"nodeName"`
}

// Warning provides structured warnings for degraded collection states.
type Warning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Node is a graph node in a logical topology snapshot.
type Node struct {
	ID    string                 `json:"id"`
	Kind  string                 `json:"kind"`
	Label string                 `json:"label"`
	Data  map[string]interface{} `json:"data,omitempty"`
}

// Edge is a graph edge in a logical topology snapshot.
type Edge struct {
	ID     string                 `json:"id"`
	Source string                 `json:"source"`
	Target string                 `json:"target"`
	Kind   string                 `json:"kind"`
	Data   map[string]interface{} `json:"data,omitempty"`
}

// Group captures optional grouping metadata for graph rendering.
type Group struct {
	ID      string   `json:"id"`
	Label   string   `json:"label"`
	NodeIDs []string `json:"nodeIds"`
}

// LogicalTopologySnapshot is the canonical payload for Phase 2 logical view.
type LogicalTopologySnapshot struct {
	Metadata Metadata  `json:"metadata"`
	Nodes    []Node    `json:"nodes"`
	Edges    []Edge    `json:"edges"`
	Groups   []Group   `json:"groups"`
	Warnings []Warning `json:"warnings"`
}
