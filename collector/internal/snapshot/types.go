package snapshot

import "time"

// SchemaVersionV2 marks table-oriented snapshots carrying a Database payload.
// v1 ("v1alpha1") snapshots carried only the deprecated graph fields.
const SchemaVersionV2 = "2"

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

// LogicalRouterRow transcribes one NB Logical_Router row.
type LogicalRouterRow struct {
	UUID             string            `json:"uuid"`
	Name             string            `json:"name"`
	PortUUIDs        []string          `json:"ports"`
	NATUUIDs         []string          `json:"nat,omitempty"`
	StaticRouteUUIDs []string          `json:"staticRoutes,omitempty"`
	Options          map[string]string `json:"options,omitempty"`
	ExternalIDs      map[string]string `json:"externalIds,omitempty"`
}

// LogicalRouterPortRow transcribes one NB Logical_Router_Port row.
type LogicalRouterPortRow struct {
	UUID                string            `json:"uuid"`
	Name                string            `json:"name"`
	MAC                 string            `json:"mac,omitempty"`
	Networks            []string          `json:"networks,omitempty"`
	Peer                string            `json:"peer,omitempty"`
	GatewayChassisUUIDs []string          `json:"gatewayChassis,omitempty"`
	Options             map[string]string `json:"options,omitempty"`
	ExternalIDs         map[string]string `json:"externalIds,omitempty"`
}

// LogicalSwitchRow transcribes one NB Logical_Switch row.
// Subnets live in OtherConfig ("subnet", "ipv6_prefix") as OVN-Kubernetes writes them.
type LogicalSwitchRow struct {
	UUID        string            `json:"uuid"`
	Name        string            `json:"name"`
	PortUUIDs   []string          `json:"ports"`
	OtherConfig map[string]string `json:"otherConfig,omitempty"`
	ExternalIDs map[string]string `json:"externalIds,omitempty"`
}

// LogicalSwitchPortRow transcribes one NB Logical_Switch_Port row.
type LogicalSwitchPortRow struct {
	UUID        string            `json:"uuid"`
	Name        string            `json:"name"`
	Type        string            `json:"type,omitempty"`
	Addresses   []string          `json:"addresses,omitempty"`
	Options     map[string]string `json:"options,omitempty"`
	ExternalIDs map[string]string `json:"externalIds,omitempty"`
}

// NATRow transcribes one NB NAT row.
type NATRow struct {
	UUID        string            `json:"uuid"`
	Type        string            `json:"type"`
	ExternalIP  string            `json:"externalIp,omitempty"`
	LogicalIP   string            `json:"logicalIp,omitempty"`
	LogicalPort string            `json:"logicalPort,omitempty"`
	ExternalMAC string            `json:"externalMac,omitempty"`
	Options     map[string]string `json:"options,omitempty"`
	ExternalIDs map[string]string `json:"externalIds,omitempty"`
}

// StaticRouteRow transcribes one NB Logical_Router_Static_Route row.
type StaticRouteRow struct {
	UUID        string            `json:"uuid"`
	IPPrefix    string            `json:"ipPrefix"`
	Nexthop     string            `json:"nexthop,omitempty"`
	Policy      string            `json:"policy,omitempty"`
	OutputPort  string            `json:"outputPort,omitempty"`
	Options     map[string]string `json:"options,omitempty"`
	ExternalIDs map[string]string `json:"externalIds,omitempty"`
}

// LogicalDatabase is the v2 table-oriented payload: a faithful transcription
// of the NB tables the logical view consumes. Semantic classification
// (network/role/node) is the frontend's job, not the collector's.
type LogicalDatabase struct {
	LogicalRouters     []LogicalRouterRow     `json:"logicalRouters"`
	LogicalRouterPorts []LogicalRouterPortRow `json:"logicalRouterPorts"`
	LogicalSwitches    []LogicalSwitchRow     `json:"logicalSwitches"`
	LogicalSwitchPorts []LogicalSwitchPortRow `json:"logicalSwitchPorts"`
	NATs               []NATRow               `json:"nats"`
	StaticRoutes       []StaticRouteRow       `json:"staticRoutes"`
}

// LogicalTopologySnapshot is the canonical payload for the logical OVN view.
//
// Database is the v2 payload (metadata.schemaVersion == SchemaVersionV2).
// Nodes/Edges/Groups are the deprecated v1 graph payload, retained only until
// the placeholder renderer is replaced (ovn-recon-kck.7); new consumers must
// read Database.
type LogicalTopologySnapshot struct {
	Metadata Metadata         `json:"metadata"`
	Database *LogicalDatabase `json:"database,omitempty"`
	Nodes    []Node           `json:"nodes"`
	Edges    []Edge           `json:"edges"`
	Groups   []Group          `json:"groups"`
	Warnings []Warning        `json:"warnings"`
}
