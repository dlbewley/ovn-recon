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
	// LoadBalancerUUIDs and LoadBalancerGroupUUIDs reference the
	// Load_Balancer and Load_Balancer_Group rows of the services section
	// (LogicalDatabase.LoadBalancers, LoadBalancerGroups).
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
	// ACLUUIDs and QoSRuleUUIDs reference ACL and QoS rows (not yet
	// collected). LoadBalancerUUIDs and LoadBalancerGroupUUIDs reference the
	// Load_Balancer and Load_Balancer_Group rows of the services section
	// (LogicalDatabase.LoadBalancers, LoadBalancerGroups).
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
	Tag string `json:"tag,omitempty"`
	// PortSecurity is the set of MAC (and optional IP) addresses the port may
	// use as a source; ovn-kubernetes sets it on every pod port.
	PortSecurity []string `json:"portSecurity,omitempty"`
	// Up is written by ovn-northd: true when the port is bound to a chassis
	// and its interface is claimed. Nil when the optional column is unset.
	Up *bool `json:"up,omitempty"`
	// Enabled is the administrative state; nil (unset) means enabled.
	Enabled *bool `json:"enabled,omitempty"`
	// DynamicAddresses is the address northd allocated when addresses holds
	// "dynamic"; empty for statically addressed ports.
	DynamicAddresses string `json:"dynamicAddresses,omitempty"`
	// TagRequest is the requested VLAN tag (0 asks for allocation); the
	// allocated tag lands in Tag.
	TagRequest string `json:"tagRequest,omitempty"`
	// ParentName names the parent port of a nested (container) port.
	ParentName  string            `json:"parentName,omitempty"`
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

// LoadBalancerRow transcribes one NB Load_Balancer row. ovn-kubernetes
// writes one per Service, protocol and scope, and names the owning Service
// in ExternalIDs ("k8s.ovn.org/kind", "k8s.ovn.org/owner" = namespace/name).
type LoadBalancerRow struct {
	UUID string `json:"uuid"`
	Name string `json:"name"`
	// Protocol is tcp, udp or sctp; empty when the optional column is unset,
	// which OVN treats as tcp.
	Protocol string `json:"protocol,omitempty"`
	// VIPs maps "vip:port" (IPv6 as "[addr]:port") to the comma-separated
	// "backend:port" list, exactly as stored. An empty value is a VIP with
	// no endpoints. Splitting the list is the consumer's job.
	VIPs    map[string]string `json:"vips"`
	Options map[string]string `json:"options,omitempty"`
	// SelectionFields are the hash fields for backend selection when set.
	SelectionFields []string `json:"selectionFields,omitempty"`
	// HealthCheckUUIDs reference Load_Balancer_Health_Check rows (not
	// collected).
	HealthCheckUUIDs []string `json:"healthCheck,omitempty"`
	// IPPortMappings maps a backend IP to "port_name:source_ip" for health
	// checks.
	IPPortMappings map[string]string `json:"ipPortMappings,omitempty"`
	ExternalIDs    map[string]string `json:"externalIds,omitempty"`
}

// LoadBalancerGroupRow transcribes one NB Load_Balancer_Group row: a named
// set of load balancers that switches and routers attach as a unit. The
// table has no external_ids column.
type LoadBalancerGroupRow struct {
	UUID string `json:"uuid"`
	Name string `json:"name"`
	// LoadBalancerUUIDs reference LoadBalancerRow.UUID; empty for a group
	// with no members.
	LoadBalancerUUIDs []string `json:"loadBalancers"`
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

	// The optional sections (see Section). A response carries them only when
	// the request names the section in ?include=. Nil means absent: not
	// requested, or not collected. Non-nil with zero rows means collected and
	// empty, and encodes as [] (LogicalDatabase.MarshalJSON; the omitempty
	// here only documents that the keys are optional).
	//
	// Policy section.
	ACLs        []SectionRow `json:"acls,omitempty"`
	PortGroups  []SectionRow `json:"portGroups,omitempty"`
	AddressSets []SectionRow `json:"addressSets,omitempty"`
	// Services section.
	LoadBalancers      []LoadBalancerRow      `json:"loadBalancers,omitempty"`
	LoadBalancerGroups []LoadBalancerGroupRow `json:"loadBalancerGroups,omitempty"`
}

// SectionRow is the placeholder row type of the policy section. The section
// keys and their delivery are part of the contract; the row shapes are not
// yet: ovn-recon-e2b.5 replaces it with typed rows when it starts collecting
// the tables. Until then the collector never populates the policy section.
// The services section is typed (LoadBalancerRow, LoadBalancerGroupRow).
type SectionRow map[string]any

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
