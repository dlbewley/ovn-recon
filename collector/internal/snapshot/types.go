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
	UUID             string   `json:"uuid"`
	Name             string   `json:"name"`
	PortUUIDs        []string `json:"ports"`
	NATUUIDs         []string `json:"nat,omitempty"`
	StaticRouteUUIDs []string `json:"staticRoutes,omitempty"`
	// Enabled is the administrative state; nil when the optional column is
	// unset, which OVN treats as enabled.
	Enabled *bool `json:"enabled,omitempty"`
	// PolicyUUIDs reference Logical_Router_Policy rows (not yet collected).
	PolicyUUIDs []string `json:"policies,omitempty"`
	// LoadBalancerUUIDs and LoadBalancerGroupUUIDs reference Load_Balancer
	// and Load_Balancer_Group rows (not yet collected).
	LoadBalancerUUIDs      []string `json:"loadBalancer,omitempty"`
	LoadBalancerGroupUUIDs []string `json:"loadBalancerGroup,omitempty"`
	// Copp references the Copp (control-plane policing) row, when attached.
	Copp        string            `json:"copp,omitempty"`
	Options     map[string]string `json:"options,omitempty"`
	ExternalIDs map[string]string `json:"externalIds,omitempty"`
}

// LogicalRouterPortRow transcribes one NB Logical_Router_Port row.
type LogicalRouterPortRow struct {
	UUID     string   `json:"uuid"`
	Name     string   `json:"name"`
	MAC      string   `json:"mac,omitempty"`
	Networks []string `json:"networks,omitempty"`
	Peer     string   `json:"peer,omitempty"`
	// Enabled is the administrative state; nil when unset (enabled).
	Enabled *bool `json:"enabled,omitempty"`
	// GatewayChassisUUIDs reference the Gateway_Chassis rows (see
	// LogicalDatabase.GatewayChassis) that may host a distributed gateway port.
	GatewayChassisUUIDs []string `json:"gatewayChassis,omitempty"`
	// Status is written by northd; "hosting-chassis" names the chassis
	// currently hosting a distributed gateway port.
	Status      map[string]string `json:"status,omitempty"`
	Options     map[string]string `json:"options,omitempty"`
	ExternalIDs map[string]string `json:"externalIds,omitempty"`
}

// LogicalSwitchRow transcribes one NB Logical_Switch row.
// Subnets live in OtherConfig ("subnet", "ipv6_prefix") as OVN-Kubernetes writes them.
type LogicalSwitchRow struct {
	UUID      string   `json:"uuid"`
	Name      string   `json:"name"`
	PortUUIDs []string `json:"ports"`
	// ACLUUIDs, LoadBalancerUUIDs, LoadBalancerGroupUUIDs and QoSRuleUUIDs
	// reference ACL, Load_Balancer, Load_Balancer_Group and QoS rows (not
	// yet collected); they carry counts and refs for the policy and service
	// planes.
	ACLUUIDs               []string          `json:"acls,omitempty"`
	LoadBalancerUUIDs      []string          `json:"loadBalancer,omitempty"`
	LoadBalancerGroupUUIDs []string          `json:"loadBalancerGroup,omitempty"`
	QoSRuleUUIDs           []string          `json:"qosRules,omitempty"`
	OtherConfig            map[string]string `json:"otherConfig,omitempty"`
	ExternalIDs            map[string]string `json:"externalIds,omitempty"`
}

// LogicalSwitchPortRow transcribes one NB Logical_Switch_Port row.
type LogicalSwitchPortRow struct {
	UUID      string   `json:"uuid"`
	Name      string   `json:"name"`
	Type      string   `json:"type,omitempty"`
	Addresses []string `json:"addresses,omitempty"`
	// Tag is the VLAN tag on localnet/l2gateway ports, when set.
	Tag         string            `json:"tag,omitempty"`
	Options     map[string]string `json:"options,omitempty"`
	ExternalIDs map[string]string `json:"externalIds,omitempty"`
}

// BridgeMappingRow transcribes one localnet-to-OVS-bridge mapping from the
// local chassis's other_config:ovn-bridge-mappings (Southbound). The localnet
// is the logical provider-network name that localnet ports reference via
// options:network_name; the bridge is the physical OVS bridge on the node.
type BridgeMappingRow struct {
	Localnet string `json:"localnet"`
	Bridge   string `json:"bridge"`
}

// NATRow transcribes one NB NAT row.
type NATRow struct {
	UUID        string `json:"uuid"`
	Type        string `json:"type"`
	ExternalIP  string `json:"externalIp,omitempty"`
	LogicalIP   string `json:"logicalIp,omitempty"`
	LogicalPort string `json:"logicalPort,omitempty"`
	ExternalMAC string `json:"externalMac,omitempty"`
	// GatewayPort references the Logical_Router_Port (uuid) the rule applies
	// on, for routers with more than one distributed gateway port.
	GatewayPort string `json:"gatewayPort,omitempty"`
	// Match narrows the rule to matching packets; Priority orders rules
	// sharing a match. Both are empty/zero on classic NAT rows.
	Match    string `json:"match,omitempty"`
	Priority int    `json:"priority,omitempty"`
	// ExternalPortRange is the L4 source port range for SNAT.
	ExternalPortRange string            `json:"externalPortRange,omitempty"`
	Options           map[string]string `json:"options,omitempty"`
	ExternalIDs       map[string]string `json:"externalIds,omitempty"`
}

// StaticRouteRow transcribes one NB Logical_Router_Static_Route row.
type StaticRouteRow struct {
	UUID       string `json:"uuid"`
	IPPrefix   string `json:"ipPrefix"`
	Nexthop    string `json:"nexthop,omitempty"`
	Policy     string `json:"policy,omitempty"`
	OutputPort string `json:"outputPort,omitempty"`
	// RouteTable scopes the route to a named table (empty: the main table).
	RouteTable string `json:"routeTable,omitempty"`
	// BFD references the BFD session (uuid) guarding the nexthop.
	BFD string `json:"bfd,omitempty"`
	// SelectionFields are the ECMP hash fields when set.
	SelectionFields []string          `json:"selectionFields,omitempty"`
	Options         map[string]string `json:"options,omitempty"`
	ExternalIDs     map[string]string `json:"externalIds,omitempty"`
}

// GatewayChassisRow transcribes one NB Gateway_Chassis row: a chassis that
// may host a distributed gateway port, with its priority.
type GatewayChassisRow struct {
	UUID string `json:"uuid"`
	Name string `json:"name"`
	// ChassisName is the SB Chassis name (a UUID string), equal to the Node's
	// k8s.ovn.org/node-chassis-id annotation.
	ChassisName string            `json:"chassisName"`
	Priority    int               `json:"priority"`
	Options     map[string]string `json:"options,omitempty"`
	ExternalIDs map[string]string `json:"externalIds,omitempty"`
}

// NBGlobalRow transcribes the single NB NB_Global row: zone identity and
// the northd/hypervisor configuration sequence numbers.
type NBGlobalRow struct {
	UUID string `json:"uuid"`
	// Name is the zone name under interconnect (also options:name).
	Name string `json:"name,omitempty"`
	// NBCfg is bumped by the CMS; SBCfg and HVCfg follow as northd and the
	// chassis catch up. Equal values mean every chassis has applied the
	// current configuration.
	NBCfg int64 `json:"nbCfg"`
	SBCfg int64 `json:"sbCfg"`
	HVCfg int64 `json:"hvCfg"`
	// Options carries northd_internal_version among others.
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
	// BridgeMappings is per-node (chassis) state; absent on snapshots from
	// collectors older than the field.
	BridgeMappings []BridgeMappingRow `json:"bridgeMappings,omitempty"`
	// GatewayChassis resolves LogicalRouterPortRow.GatewayChassisUUIDs;
	// absent on snapshots from collectors older than the field.
	GatewayChassis []GatewayChassisRow `json:"gatewayChassis,omitempty"`
	// NBGlobal is the zone's NB_Global row; absent on snapshots from
	// collectors older than the field.
	NBGlobal *NBGlobalRow `json:"nbGlobal,omitempty"`
}

// ClusterMetadata describes an aggregate collection across zones.
type ClusterMetadata struct {
	SchemaVersion string    `json:"schemaVersion"`
	GeneratedAt   time.Time `json:"generatedAt"`
	SourceHealth  string    `json:"sourceHealth"`
}

// ClusterLogicalTopology is the aggregate payload: every reachable node's
// zone snapshot in one response. The collector does not merge zones — dedup
// rules are semantic (name-based identity of transit switches and
// per-network routers) and live in the frontend classification layer.
type ClusterLogicalTopology struct {
	Metadata  ClusterMetadata           `json:"metadata"`
	Snapshots []LogicalTopologySnapshot `json:"snapshots"`
	Warnings  []Warning                 `json:"warnings"`
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
