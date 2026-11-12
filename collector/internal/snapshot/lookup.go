package snapshot

import (
	"fmt"
	"net"
	"net/netip"
	"sort"
	"strings"
)

// DefaultNetwork is the identity of the cluster default network: what a row
// belongs to when neither it nor its construct names a network.
const DefaultNetwork = "default"

// The external_ids conventions the lookup reads. They are the ones the
// plugin classifies by (src/components/logicalClassification.ts and
// ovnOwner.ts); keep the two in step rather than adding a rule here.
const (
	externalIDNetwork         = "k8s.ovn.org/network"
	externalIDOwnerController = "k8s.ovn.org/owner-controller"
	externalIDOwnerType       = "k8s.ovn.org/owner-type"
	externalIDOwnerName       = "k8s.ovn.org/name"
	externalIDKind            = "k8s.ovn.org/kind"
	externalIDOwner           = "k8s.ovn.org/owner"
	externalIDNamespace       = "namespace"
	externalIDPod             = "pod"

	networkControllerSuffix = "-network-controller"
)

// ParseLookupQuery validates a lookup request. The error text is fit to
// return to the caller as a 400 body.
func ParseLookupQuery(kind, value string) (LookupQuery, error) {
	value = strings.TrimSpace(value)
	query := LookupQuery{Kind: LookupKind(strings.TrimSpace(kind))}

	switch query.Kind {
	case LookupKindIP, LookupKindMAC, LookupKindCIDR, LookupKindName:
	default:
		valid := make([]string, 0, len(LookupKinds()))
		for _, known := range LookupKinds() {
			valid = append(valid, string(known))
		}
		return LookupQuery{}, fmt.Errorf("unknown lookup kind %q; valid kinds: %s", kind, strings.Join(valid, ", "))
	}
	if value == "" {
		return LookupQuery{}, fmt.Errorf("lookup value is required")
	}

	switch query.Kind {
	case LookupKindIP:
		addr, err := netip.ParseAddr(value)
		if err != nil || addr.Zone() != "" {
			return LookupQuery{}, fmt.Errorf("%q is not an IP address", value)
		}
		query.addr = addr.Unmap()
		query.Value = query.addr.String()
	case LookupKindCIDR:
		prefix, err := netip.ParsePrefix(value)
		if err != nil {
			return LookupQuery{}, fmt.Errorf("%q is not a CIDR (expected address/length, e.g. 10.1.2.0/24)", value)
		}
		query.prefix = prefix.Masked()
		query.Value = query.prefix.String()
	case LookupKindMAC:
		mac, ok := parseMAC(value)
		if !ok {
			return LookupQuery{}, fmt.Errorf("%q is not a MAC address (expected six octets, e.g. 0a:58:0a:83:00:76)", value)
		}
		query.Value = mac
	case LookupKindName:
		query.Value = value
		query.text = strings.ToLower(value)
	}
	return query, nil
}

// parseMAC reads a 48-bit Ethernet address in any spelling net.ParseMAC
// accepts and returns it in lower-case colon form.
func parseMAC(value string) (string, bool) {
	hardware, err := net.ParseMAC(value)
	if err != nil || len(hardware) != 6 {
		return "", false
	}
	return hardware.String(), true
}

// parseStoredAddress reads one stored address token: a bare address or an
// address with a prefix length. The returned prefix keeps the address as
// written (not masked); a bare address is a full-length prefix.
func parseStoredAddress(token string) (netip.Prefix, bool) {
	token = strings.TrimSpace(token)
	if token == "" {
		return netip.Prefix{}, false
	}
	if strings.Contains(token, "/") {
		prefix, err := netip.ParsePrefix(token)
		if err != nil {
			return netip.Prefix{}, false
		}
		return netip.PrefixFrom(prefix.Addr().Unmap(), prefix.Bits()), true
	}
	addr, err := netip.ParseAddr(token)
	if err != nil {
		return netip.Prefix{}, false
	}
	addr = addr.Unmap()
	return netip.PrefixFrom(addr, addr.BitLen()), true
}

// matchRank orders match types: a lower rank is a better match.
var matchRank = func() map[LookupMatchType]int {
	ranks := map[LookupMatchType]int{}
	for rank, matchType := range LookupMatchTypes() {
		ranks[matchType] = rank
	}
	return ranks
}()

var tableRank = func() map[LookupTable]int {
	ranks := map[LookupTable]int{}
	for rank, table := range LookupTables() {
		ranks[table] = rank
	}
	return ranks
}()

// rowMatch keeps the best match found in one row. A row yields one hit
// however many of its fields match (a pod port holds its address in both
// addresses and port_security): the best match type wins, and between equal
// types the field offered first.
type rowMatch struct {
	found bool
	field LookupField
	value string
	// values is every value of the winning field that matched at the winning
	// type, the first included: a load balancer row holding two VIPs on one
	// address reports both.
	values    []string
	matchType LookupMatchType
	// bits is the stored prefix length, used to put the most specific
	// containing range first.
	bits int
}

func (m *rowMatch) offer(field LookupField, value string, matchType LookupMatchType, bits int) {
	if m.found && matchRank[matchType] == matchRank[m.matchType] && field == m.field && matchType == m.matchType && bits == m.bits {
		for _, seen := range m.values {
			if seen == value {
				return
			}
		}
		m.values = append(m.values, value)
		return
	}
	if m.found && matchRank[matchType] >= matchRank[m.matchType] {
		return
	}
	*m = rowMatch{found: true, field: field, value: value, values: []string{value}, matchType: matchType, bits: bits}
}

// host offers a stored host address: an address a port holds, written bare
// or with the prefix length of its subnet ("100.88.0.4/16"). The length is
// ignored; a port's address never matches by the mask written beside it.
// entry is the whole stored value the token was found in.
func (q LookupQuery) host(m *rowMatch, field LookupField, entry, token string) {
	stored, ok := parseStoredAddress(token)
	if !ok {
		return
	}
	addr := stored.Addr()
	switch q.Kind {
	case LookupKindIP:
		if addr == q.addr {
			m.offer(field, entry, LookupMatchExact, addr.BitLen())
		}
	case LookupKindCIDR:
		if !q.prefix.Contains(addr) {
			return
		}
		if q.prefix.IsSingleIP() {
			m.offer(field, entry, LookupMatchExact, addr.BitLen())
		} else {
			m.offer(field, entry, LookupMatchWithin, addr.BitLen())
		}
	}
}

// addressEntry offers one Logical_Switch_Port style entry: a MAC followed by
// its addresses ("0a:58:0a:83:00:46 10.131.0.70"), or a keyword such as
// "router", "unknown" or "dynamic", which matches nothing.
func (q LookupQuery) addressEntry(m *rowMatch, field LookupField, entry string) {
	switch q.Kind {
	case LookupKindMAC:
		for _, token := range strings.Fields(entry) {
			if mac, ok := parseMAC(token); ok && mac == q.Value {
				m.offer(field, entry, LookupMatchExact, 0)
				return
			}
		}
	case LookupKindIP, LookupKindCIDR:
		for _, token := range strings.Fields(entry) {
			q.host(m, field, entry, token)
		}
	}
}

// addressRange offers a stored value that may be a range: a NAT address, a
// route prefix, a switch subnet. Written bare it is a single address.
//
// A zero-length prefix (a default route) never matches by containment: it
// contains every address and says nothing about where one is.
func (q LookupQuery) addressRange(m *rowMatch, field LookupField, stored string) {
	if q.Kind != LookupKindIP && q.Kind != LookupKindCIDR {
		return
	}
	parsed, ok := parseStoredAddress(stored)
	if !ok {
		return
	}
	parsed = parsed.Masked()

	if q.Kind == LookupKindIP {
		switch {
		case parsed.IsSingleIP():
			if parsed.Addr() == q.addr {
				m.offer(field, stored, LookupMatchExact, parsed.Bits())
			}
		case parsed.Bits() > 0 && parsed.Contains(q.addr):
			m.offer(field, stored, LookupMatchContainment, parsed.Bits())
		}
		return
	}

	switch {
	case parsed == q.prefix:
		m.offer(field, stored, LookupMatchExact, parsed.Bits())
	case parsed.Addr().BitLen() != q.prefix.Addr().BitLen():
		// Another address family.
	case parsed.Bits() < q.prefix.Bits():
		if parsed.Bits() > 0 && parsed.Contains(q.prefix.Addr()) {
			m.offer(field, stored, LookupMatchContainment, parsed.Bits())
		}
	case q.prefix.Contains(parsed.Addr()):
		m.offer(field, stored, LookupMatchWithin, parsed.Bits())
	}
}

// hardware offers a stored MAC address.
func (q LookupQuery) hardware(m *rowMatch, field LookupField, stored string) {
	if q.Kind != LookupKindMAC || stored == "" {
		return
	}
	if mac, ok := parseMAC(strings.TrimSpace(stored)); ok && mac == q.Value {
		m.offer(field, stored, LookupMatchExact, 0)
	}
}

// name offers a stored name.
func (q LookupQuery) name(m *rowMatch, field LookupField, stored string) {
	if q.Kind != LookupKindName || stored == "" || q.text == "" {
		return
	}
	lower := strings.ToLower(stored)
	switch {
	case lower == q.text:
		m.offer(field, stored, LookupMatchExact, 0)
	case strings.Contains(lower, q.text):
		m.offer(field, stored, LookupMatchSubstring, 0)
	}
}

// networkOfController is the network a controller serves: "default" for
// default-network-controller, "cluster_udn_<name>" or "<namespace>_<name>"
// for a user-defined network's controller, empty for anything that is not a
// network controller. The same rule as the plugin's networkOfController.
func networkOfController(controller string) string {
	if !strings.HasSuffix(controller, networkControllerSuffix) {
		return ""
	}
	return strings.TrimSuffix(controller, networkControllerSuffix)
}

// networkOfExternalIDs is the network a row announces, or empty.
func networkOfExternalIDs(externalIDs map[string]string) string {
	if network := externalIDs[externalIDNetwork]; network != "" {
		return network
	}
	return networkOfController(externalIDs[externalIDOwnerController])
}

// owning is the switch or router a row belongs to, with the external_ids a
// row without a network of its own inherits from.
type owning struct {
	construct   LookupConstruct
	externalIDs map[string]string
}

// ownerOfSwitchPort names the pod behind a pod port. ovn-kubernetes flags
// the port with external_ids pod=true and stamps the namespace; the pod's
// name is the last underscore-separated segment of the port name, whatever
// network prefix precedes it (Kubernetes names hold no underscore). The
// plugin's classifySwitchPort reads the port the same way.
func ownerOfSwitchPort(port LogicalSwitchPortRow) *LookupOwner {
	namespace := port.ExternalIDs[externalIDNamespace]
	if port.ExternalIDs[externalIDPod] != "true" || namespace == "" {
		return ownerOfExternalIDs(port.ExternalIDs)
	}
	separator := strings.LastIndex(port.Name, "_")
	if separator < 0 || separator == len(port.Name)-1 {
		return nil
	}
	return &LookupOwner{Kind: "Pod", Namespace: namespace, Name: port.Name[separator+1:]}
}

// ownerOfExternalIDs reads the two generic ownership conventions: the
// k8s.ovn.org/kind + k8s.ovn.org/owner pair ("Service", "namespace/name")
// that load balancers carry, and the k8s.ovn.org/owner-type +
// k8s.ovn.org/name pair of the rows ovn-kubernetes keys by object id, whose
// name format differs per type and is passed through as written.
func ownerOfExternalIDs(externalIDs map[string]string) *LookupOwner {
	if kind, owner := externalIDs[externalIDKind], externalIDs[externalIDOwner]; kind != "" && owner != "" {
		if namespace, name, found := strings.Cut(owner, "/"); found && namespace != "" && name != "" {
			return &LookupOwner{Kind: kind, Namespace: namespace, Name: name}
		}
		return &LookupOwner{Kind: kind, Name: owner}
	}
	if ownerType, name := externalIDs[externalIDOwnerType], externalIDs[externalIDOwnerName]; ownerType != "" && name != "" {
		return &LookupOwner{Kind: ownerType, Name: name}
	}
	return nil
}

// rankedHit carries the ordering keys beside a hit.
type rankedHit struct {
	hit  LookupHit
	bits int
}

// LookupSearch accumulates the hits of one query over zone snapshots added
// one at a time, so a caller reading snapshots from disk never has to hold
// more than the one being searched. It is not safe for concurrent use.
type LookupSearch struct {
	query LookupQuery
	hits  []rankedHit
	zones []LookupZone
}

// NewLookupSearch starts a search for a query built by ParseLookupQuery.
func NewLookupSearch(query LookupQuery) *LookupSearch {
	return &LookupSearch{query: query}
}

// AddZone searches one zone snapshot. The zone is named by
// metadata.nodeName. Only what the snapshot holds is searched: load balancer
// VIPs are matched when it carries the services section and skipped when it
// does not. The snapshot is not retained.
func (s *LookupSearch) AddZone(zone LogicalTopologySnapshot) {
	node := zone.Metadata.NodeName
	s.zones = append(s.zones, LookupZone{
		Node:                node,
		SnapshotGeneratedAt: zone.Metadata.GeneratedAt,
		SourceHealth:        zone.Metadata.SourceHealth,
	})
	db := zone.Database
	if db == nil {
		return
	}
	q := s.query

	emit := func(table LookupTable, uuid, name string, externalIDs map[string]string, owner *owning, lookupOwner *LookupOwner, m rowMatch) {
		if !m.found {
			return
		}
		hit := LookupHit{
			Node:                node,
			Table:               table,
			RowUUID:             uuid,
			RowName:             name,
			Owner:               lookupOwner,
			MatchedField:        m.field,
			MatchedValue:        m.value,
			MatchType:           m.matchType,
			SnapshotGeneratedAt: zone.Metadata.GeneratedAt,
		}
		if len(m.values) > 1 {
			hit.MatchedValues = m.values
		}
		hit.Network = networkOfExternalIDs(externalIDs)
		if owner != nil {
			construct := owner.construct
			hit.Construct = &construct
			if hit.Network == "" {
				hit.Network = networkOfExternalIDs(owner.externalIDs)
			}
		}
		if hit.Network == "" {
			hit.Network = DefaultNetwork
		}
		s.hits = append(s.hits, rankedHit{hit: hit, bits: m.bits})
	}

	// Which switch lists each port, which router lists each port, NAT rule
	// and static route. A row referenced by nothing has no construct.
	switchOfPort := map[string]*owning{}
	for _, row := range db.LogicalSwitches {
		self := &owning{
			construct:   LookupConstruct{Kind: LookupConstructSwitch, Name: row.Name, UUID: row.UUID},
			externalIDs: row.ExternalIDs,
		}
		for _, uuid := range row.PortUUIDs {
			switchOfPort[uuid] = self
		}

		var m rowMatch
		q.name(&m, LookupFieldName, row.Name)
		q.name(&m, LookupFieldNetwork, row.ExternalIDs[externalIDNetwork])
		q.addressRange(&m, LookupFieldSubnet, row.OtherConfig["subnet"])
		q.addressRange(&m, LookupFieldIPv6Prefix, ipv6PrefixOf(row.OtherConfig["ipv6_prefix"]))
		if m.field == LookupFieldIPv6Prefix {
			m.value = row.OtherConfig["ipv6_prefix"]
		}
		emit(LookupTableLogicalSwitch, row.UUID, row.Name, row.ExternalIDs, self, ownerOfExternalIDs(row.ExternalIDs), m)
	}

	routerOfPort := map[string]*owning{}
	routerOfNAT := map[string]*owning{}
	routerOfRoute := map[string]*owning{}
	for _, row := range db.LogicalRouters {
		self := &owning{
			construct:   LookupConstruct{Kind: LookupConstructRouter, Name: row.Name, UUID: row.UUID},
			externalIDs: row.ExternalIDs,
		}
		for _, uuid := range row.PortUUIDs {
			routerOfPort[uuid] = self
		}
		for _, uuid := range row.NATUUIDs {
			routerOfNAT[uuid] = self
		}
		for _, uuid := range row.StaticRouteUUIDs {
			routerOfRoute[uuid] = self
		}

		var m rowMatch
		q.name(&m, LookupFieldName, row.Name)
		q.name(&m, LookupFieldNetwork, row.ExternalIDs[externalIDNetwork])
		emit(LookupTableLogicalRouter, row.UUID, row.Name, row.ExternalIDs, self, ownerOfExternalIDs(row.ExternalIDs), m)
	}

	for _, row := range db.LogicalSwitchPorts {
		var m rowMatch
		for _, entry := range row.Addresses {
			q.addressEntry(&m, LookupFieldAddresses, entry)
		}
		q.addressEntry(&m, LookupFieldDynamicAddresses, row.DynamicAddresses)
		for _, entry := range row.PortSecurity {
			q.addressEntry(&m, LookupFieldPortSecurity, entry)
		}
		q.name(&m, LookupFieldName, row.Name)
		q.name(&m, LookupFieldNamespace, row.ExternalIDs[externalIDNamespace])
		if !m.found {
			continue
		}
		emit(LookupTableLogicalSwitchPort, row.UUID, row.Name, row.ExternalIDs, switchOfPort[row.UUID], ownerOfSwitchPort(row), m)
	}

	if q.Kind == LookupKindName {
		// Names are matched on switches, routers and switch ports only.
		return
	}

	for _, row := range db.LogicalRouterPorts {
		var m rowMatch
		for _, network := range row.Networks {
			q.host(&m, LookupFieldNetworks, network, network)
		}
		q.hardware(&m, LookupFieldMAC, row.MAC)
		emit(LookupTableLogicalRouterPort, row.UUID, row.Name, row.ExternalIDs, routerOfPort[row.UUID], ownerOfExternalIDs(row.ExternalIDs), m)
	}

	for _, row := range db.NATs {
		var m rowMatch
		q.addressRange(&m, LookupFieldExternalIP, row.ExternalIP)
		q.addressRange(&m, LookupFieldLogicalIP, row.LogicalIP)
		q.hardware(&m, LookupFieldExternalMAC, row.ExternalMAC)
		emit(LookupTableNAT, row.UUID, "", row.ExternalIDs, routerOfNAT[row.UUID], ownerOfExternalIDs(row.ExternalIDs), m)
	}

	for _, row := range db.StaticRoutes {
		var m rowMatch
		q.addressRange(&m, LookupFieldIPPrefix, row.IPPrefix)
		emit(LookupTableStaticRoute, row.UUID, "", row.ExternalIDs, routerOfRoute[row.UUID], ownerOfExternalIDs(row.ExternalIDs), m)
	}

	if q.Kind == LookupKindMAC {
		return
	}
	// db.LoadBalancers is nil when the snapshot does not carry the services
	// section; the loop then has nothing to read.
	for _, row := range db.LoadBalancers {
		var m rowMatch
		for _, vip := range sortedKeys(row.VIPs) {
			q.host(&m, LookupFieldVIPs, vip, vipAddress(vip))
		}
		emit(LookupTableLoadBalancer, row.UUID, row.Name, row.ExternalIDs, nil, ownerOfExternalIDs(row.ExternalIDs), m)
	}
}

// ipv6PrefixOf reads other_config:ipv6_prefix, which OVN stores as the /64
// network either bare ("fd01:0:0:5::") or with its length.
func ipv6PrefixOf(stored string) string {
	stored = strings.TrimSpace(stored)
	if stored == "" || strings.Contains(stored, "/") {
		return stored
	}
	return stored + "/64"
}

// vipAddress is the address of a Load_Balancer vips key: "ip:port",
// "[ipv6]:port", or an address without a port.
func vipAddress(vip string) string {
	if addrPort, err := netip.ParseAddrPort(vip); err == nil {
		return addrPort.Addr().String()
	}
	return strings.Trim(vip, "[]")
}

func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// Response orders the hits found so far and cuts them to limit (a limit
// below one means DefaultLookupLimit). Order: match type as LookupMatchTypes
// lists them; among containment matches the longest stored prefix first;
// then node, table (as LookupTables lists them), row name and row uuid.
func (s *LookupSearch) Response(limit int) LookupResponse {
	if limit < 1 {
		limit = DefaultLookupLimit
	}

	ranked := append([]rankedHit(nil), s.hits...)
	sort.SliceStable(ranked, func(i, j int) bool {
		a, b := ranked[i], ranked[j]
		if a.hit.MatchType != b.hit.MatchType {
			return matchRank[a.hit.MatchType] < matchRank[b.hit.MatchType]
		}
		if a.hit.MatchType == LookupMatchContainment && a.bits != b.bits {
			return a.bits > b.bits
		}
		if a.hit.Node != b.hit.Node {
			return a.hit.Node < b.hit.Node
		}
		if a.hit.Table != b.hit.Table {
			return tableRank[a.hit.Table] < tableRank[b.hit.Table]
		}
		if a.hit.RowName != b.hit.RowName {
			return a.hit.RowName < b.hit.RowName
		}
		return a.hit.RowUUID < b.hit.RowUUID
	})

	response := LookupResponse{
		Query:     s.query,
		Hits:      make([]LookupHit, 0, min(len(ranked), limit)),
		Total:     len(ranked),
		Limit:     limit,
		Truncated: len(ranked) > limit,
		Zones:     append([]LookupZone{}, s.zones...),
		Warnings:  []Warning{},
	}
	for _, entry := range ranked[:min(len(ranked), limit)] {
		response.Hits = append(response.Hits, entry.hit)
	}
	sort.SliceStable(response.Zones, func(i, j int) bool { return response.Zones[i].Node < response.Zones[j].Node })
	return response
}

// Lookup searches the given zone snapshots for one query: the whole lookup
// as one call, for callers that already hold the snapshots.
func Lookup(query LookupQuery, zones []LogicalTopologySnapshot, limit int) LookupResponse {
	search := NewLookupSearch(query)
	for _, zone := range zones {
		search.AddZone(zone)
	}
	return search.Response(limit)
}
