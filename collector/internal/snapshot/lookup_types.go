package snapshot

import (
	"net/netip"
	"time"
)

// The lookup contract: the response of GET /api/v1/lookup/{kind}/{value},
// which answers "where is this address or name?" across zone snapshots
// (ovn-recon-tpp.1). Mirrored by collector/api/lookup-response.schema.json
// and by the Lookup* types in src/types.ts; lookup_contract_test.go keeps
// the schema and these types in step.

// LookupKind selects what a lookup value is.
type LookupKind string

const (
	// LookupKindIP is one IPv4 or IPv6 address.
	LookupKindIP LookupKind = "ip"
	// LookupKindMAC is one 48-bit Ethernet address.
	LookupKindMAC LookupKind = "mac"
	// LookupKindCIDR is an address prefix, e.g. 10.1.2.0/24.
	LookupKindCIDR LookupKind = "cidr"
	// LookupKindName is a case-insensitive substring of a name.
	LookupKindName LookupKind = "name"
)

// LookupKinds lists the valid kinds in documentation order.
func LookupKinds() []LookupKind {
	return []LookupKind{LookupKindIP, LookupKindMAC, LookupKindCIDR, LookupKindName}
}

// LookupMatchType says how a stored value matched the query.
type LookupMatchType string

const (
	// LookupMatchExact: the stored address, prefix or name equals the query.
	LookupMatchExact LookupMatchType = "exact"
	// LookupMatchContainment: a stored CIDR contains the queried address or
	// CIDR. The row is about a range the query falls in, not about the query
	// itself.
	LookupMatchContainment LookupMatchType = "containment"
	// LookupMatchWithin: the stored address or CIDR lies inside the queried
	// CIDR (cidr lookups only).
	LookupMatchWithin LookupMatchType = "within"
	// LookupMatchSubstring: the stored name contains the queried text (name
	// lookups only).
	LookupMatchSubstring LookupMatchType = "substring"
)

// LookupMatchTypes lists the match types, best first: the order hits are
// returned in.
func LookupMatchTypes() []LookupMatchType {
	return []LookupMatchType{LookupMatchExact, LookupMatchContainment, LookupMatchWithin, LookupMatchSubstring}
}

// LookupTable names the NB table a hit's row belongs to, spelled as OVN
// spells it.
type LookupTable string

const (
	LookupTableLogicalSwitch     LookupTable = "Logical_Switch"
	LookupTableLogicalRouter     LookupTable = "Logical_Router"
	LookupTableLogicalSwitchPort LookupTable = "Logical_Switch_Port"
	LookupTableLogicalRouterPort LookupTable = "Logical_Router_Port"
	LookupTableNAT               LookupTable = "NAT"
	LookupTableStaticRoute       LookupTable = "Logical_Router_Static_Route"
	LookupTableLoadBalancer      LookupTable = "Load_Balancer"
)

// LookupTables lists the searched tables in the order hits of equal rank are
// returned in.
func LookupTables() []LookupTable {
	return []LookupTable{
		LookupTableLogicalSwitch,
		LookupTableLogicalRouter,
		LookupTableLogicalSwitchPort,
		LookupTableLogicalRouterPort,
		LookupTableNAT,
		LookupTableStaticRoute,
		LookupTableLoadBalancer,
	}
}

// LookupField names the stored field that matched, as the path of the value
// in the snapshot row (the JSON keys of LogicalDatabase's row types), so a
// client can find the value in the row it already renders.
type LookupField string

const (
	LookupFieldName             LookupField = "name"
	LookupFieldAddresses        LookupField = "addresses"
	LookupFieldDynamicAddresses LookupField = "dynamicAddresses"
	LookupFieldPortSecurity     LookupField = "portSecurity"
	LookupFieldNetworks         LookupField = "networks"
	LookupFieldMAC              LookupField = "mac"
	LookupFieldExternalIP       LookupField = "externalIp"
	LookupFieldLogicalIP        LookupField = "logicalIp"
	LookupFieldExternalMAC      LookupField = "externalMac"
	LookupFieldIPPrefix         LookupField = "ipPrefix"
	LookupFieldVIPs             LookupField = "vips"
	LookupFieldSubnet           LookupField = "otherConfig.subnet"
	LookupFieldIPv6Prefix       LookupField = "otherConfig.ipv6_prefix"
	LookupFieldNamespace        LookupField = "externalIds.namespace"
	LookupFieldNetwork          LookupField = "externalIds.k8s.ovn.org/network"
)

// LookupFields lists every field a hit can name.
func LookupFields() []LookupField {
	return []LookupField{
		LookupFieldName,
		LookupFieldAddresses,
		LookupFieldDynamicAddresses,
		LookupFieldPortSecurity,
		LookupFieldNetworks,
		LookupFieldMAC,
		LookupFieldExternalIP,
		LookupFieldLogicalIP,
		LookupFieldExternalMAC,
		LookupFieldIPPrefix,
		LookupFieldVIPs,
		LookupFieldSubnet,
		LookupFieldIPv6Prefix,
		LookupFieldNamespace,
		LookupFieldNetwork,
	}
}

// LookupConstructKind is the kind of the switch or router a row belongs to.
type LookupConstructKind string

const (
	LookupConstructSwitch LookupConstructKind = "switch"
	LookupConstructRouter LookupConstructKind = "router"
)

// LookupConstructKinds lists the construct kinds.
func LookupConstructKinds() []LookupConstructKind {
	return []LookupConstructKind{LookupConstructSwitch, LookupConstructRouter}
}

// DefaultLookupLimit caps the hits of one response. A search box shows a few
// dozen grouped results; 200 leaves room for an address that every zone of a
// large cluster knows (a transit address has one row per node per network)
// while keeping the response small enough to answer in one screen.
const DefaultLookupLimit = 200

// LookupQuery is a parsed lookup request. Build one with ParseLookupQuery;
// the zero value matches nothing.
type LookupQuery struct {
	Kind LookupKind `json:"kind"`
	// Value is the query in normalised form: an address as netip prints it,
	// a prefix masked to its network, a MAC in lower-case colon form, a name
	// trimmed of surrounding space.
	Value string `json:"value"`

	addr   netip.Addr
	prefix netip.Prefix
	text   string // Value lower-cased, for name lookups
}

// LookupConstruct identifies the logical switch or router a row belongs to:
// the switch that lists a port, the router that lists a port, NAT rule or
// static route, or the row itself when the row is a switch or router.
type LookupConstruct struct {
	Kind LookupConstructKind `json:"kind"`
	Name string              `json:"name"`
	UUID string              `json:"uuid"`
}

// LookupOwner is the Kubernetes object a row's external_ids name.
type LookupOwner struct {
	// Kind is "Pod" for a pod's switch port, the value of k8s.ovn.org/kind
	// on a load balancer ("Service"), or the row's k8s.ovn.org/owner-type.
	Kind string `json:"kind"`
	// Namespace is empty for a cluster-scoped owner and for an owner type
	// whose name format this collector does not split.
	Namespace string `json:"namespace,omitempty"`
	Name      string `json:"name"`
}

// LookupHit is one row that matched, in one zone. The same address or name
// in another zone, or in another network of the same zone, is another hit:
// user-defined network subnets may overlap, so hits are never merged.
type LookupHit struct {
	// Node is the zone: the node whose snapshot holds the row.
	Node  string      `json:"node"`
	Table LookupTable `json:"table"`
	// RowUUID is the row's uuid in that zone's northbound database.
	RowUUID string `json:"rowUuid"`
	// RowName is the row's name column; absent for the tables without one
	// (NAT, Logical_Router_Static_Route).
	RowName string `json:"rowName,omitempty"`
	// Construct is absent for a load balancer (attached to many switches and
	// routers) and for a row no switch or router in the zone references.
	Construct *LookupConstruct `json:"construct,omitempty"`
	// Network is the k8s.ovn.org/network identity ("default",
	// "cluster_udn_<name>", "<namespace>_<name>"), read from the row or, when
	// the row does not say, from its construct.
	Network string `json:"network"`
	// Owner is present only when the row's external_ids name one.
	Owner *LookupOwner `json:"owner,omitempty"`
	// MatchedField is the field that matched and MatchedValue its value as
	// stored (one address entry, one network, one VIP key, the name).
	MatchedField LookupField     `json:"matchedField"`
	MatchedValue string          `json:"matchedValue"`
	MatchType    LookupMatchType `json:"matchType"`
	// SnapshotGeneratedAt is when the zone's snapshot was collected: how old
	// this answer is.
	SnapshotGeneratedAt time.Time `json:"snapshotGeneratedAt"`
}

// LookupZone is one zone snapshot that was searched.
type LookupZone struct {
	Node                string    `json:"node"`
	SnapshotGeneratedAt time.Time `json:"snapshotGeneratedAt"`
	SourceHealth        string    `json:"sourceHealth"`
}

// LookupResponse is the payload of GET /api/v1/lookup/{kind}/{value}.
type LookupResponse struct {
	Query LookupQuery `json:"query"`
	// Hits are ordered best match first (see LookupMatchTypes), then by node,
	// table and row name, and cut to Limit.
	Hits []LookupHit `json:"hits"`
	// Total counts every matching row, including the ones cut by Limit.
	Total int `json:"total"`
	Limit int `json:"limit"`
	// Truncated is true when Total exceeds Limit.
	Truncated bool `json:"truncated"`
	// Zones lists the zone snapshots that were searched, by node name. A node
	// that is missing here was not searched, and Warnings says why.
	Zones    []LookupZone `json:"zones"`
	Warnings []Warning    `json:"warnings"`
}
