package snapshot

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// fixtureZones loads the node fixtures (every file but the empty fallback)
// the way the collector serves them in fixture mode.
func fixtureZones(t *testing.T) []LogicalTopologySnapshot {
	t.Helper()
	entries, err := os.ReadDir(fixtureDir)
	if err != nil {
		t.Fatalf("read fixture dir: %v", err)
	}
	zones := []LogicalTopologySnapshot{}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" || entry.Name() == "default.json" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(fixtureDir, entry.Name()))
		if err != nil {
			t.Fatalf("read fixture: %v", err)
		}
		var zone LogicalTopologySnapshot
		if err := json.Unmarshal(raw, &zone); err != nil {
			t.Fatalf("decode fixture %s: %v", entry.Name(), err)
		}
		if zone.Metadata.NodeName == "" {
			t.Fatalf("fixture %s has no nodeName", entry.Name())
		}
		zones = append(zones, zone)
	}
	if len(zones) < 3 {
		t.Fatalf("expected at least three node fixtures, found %d", len(zones))
	}
	return zones
}

func mustQuery(t *testing.T, kind, value string) LookupQuery {
	t.Helper()
	query, err := ParseLookupQuery(kind, value)
	if err != nil {
		t.Fatalf("ParseLookupQuery(%q, %q): %v", kind, value, err)
	}
	return query
}

func lookupFixtures(t *testing.T, kind, value string) LookupResponse {
	t.Helper()
	return Lookup(mustQuery(t, kind, value), fixtureZones(t), 0)
}

func hitsWhere(hits []LookupHit, keep func(LookupHit) bool) []LookupHit {
	kept := []LookupHit{}
	for _, hit := range hits {
		if keep(hit) {
			kept = append(kept, hit)
		}
	}
	return kept
}

// assertOrdered checks the documented order: match type first, and among
// containment matches the longest stored prefix first.
func assertOrdered(t *testing.T, hits []LookupHit) {
	t.Helper()
	for index := 1; index < len(hits); index++ {
		previous, current := hits[index-1], hits[index]
		if matchRank[previous.MatchType] > matchRank[current.MatchType] {
			t.Fatalf("hit %d (%s) is ordered after a worse match (%s)", index, current.MatchType, previous.MatchType)
		}
		if previous.MatchType == LookupMatchContainment && current.MatchType == LookupMatchContainment {
			before, _ := parseStoredAddress(previous.MatchedValue)
			after, _ := parseStoredAddress(current.MatchedValue)
			if before.Bits() < after.Bits() {
				t.Fatalf("containment hit %s is ordered before the more specific %s", previous.MatchedValue, current.MatchedValue)
			}
		}
	}
}

// A pod address resolves to the pod's switch port, with the switch, the
// network and the pod named, in the one zone that hosts it.
func TestLookupIPFindsThePodPortAndItsNAT(t *testing.T) {
	response := lookupFixtures(t, "ip", "10.131.0.70")
	if response.Query.Kind != LookupKindIP || response.Query.Value != "10.131.0.70" {
		t.Fatalf("unexpected query echo: %+v", response.Query)
	}
	if len(response.Zones) != len(fixtureZones(t)) {
		t.Fatalf("expected every fixture zone to be searched, got %+v", response.Zones)
	}
	assertOrdered(t, response.Hits)

	ports := hitsWhere(response.Hits, func(hit LookupHit) bool { return hit.Table == LookupTableLogicalSwitchPort })
	if len(ports) != 1 {
		t.Fatalf("expected one switch port hit, got %d: %+v", len(ports), ports)
	}
	port := ports[0]
	if port.Node != "cnv-1" || port.MatchType != LookupMatchExact || port.MatchedField != LookupFieldAddresses {
		t.Fatalf("unexpected port hit: %+v", port)
	}
	if port.MatchedValue != "0a:58:0a:83:00:46 10.131.0.70" {
		t.Fatalf("matchedValue should be the stored address entry, got %q", port.MatchedValue)
	}
	if port.Construct == nil || port.Construct.Kind != LookupConstructSwitch || port.Construct.Name != "cnv-1" || port.Construct.UUID == "" {
		t.Fatalf("expected the node switch as construct, got %+v", port.Construct)
	}
	if port.Network != DefaultNetwork {
		t.Fatalf("expected the default network, got %q", port.Network)
	}
	if port.Owner == nil || port.Owner.Kind != "Pod" || port.Owner.Namespace != "openshift-monitoring" ||
		!strings.HasPrefix(port.Owner.Name, "thanos-querier-") || port.RowName != port.Owner.Namespace+"_"+port.Owner.Name {
		t.Fatalf("expected the pod as owner, got %+v (row %q)", port.Owner, port.RowName)
	}
	if port.RowUUID == "" || port.SnapshotGeneratedAt.IsZero() {
		t.Fatalf("hit lacks row uuid or snapshot time: %+v", port)
	}
	if response.Hits[0].RowUUID != port.RowUUID {
		t.Fatalf("the exact port match should come first, got %+v", response.Hits[0])
	}

	// The pod's SNAT on the node's gateway router is an exact match too.
	nats := hitsWhere(response.Hits, func(hit LookupHit) bool { return hit.Table == LookupTableNAT })
	if len(nats) != 1 || nats[0].MatchType != LookupMatchExact || nats[0].MatchedField != LookupFieldLogicalIP {
		t.Fatalf("expected one exact NAT hit on logicalIp, got %+v", nats)
	}
	if nats[0].Construct == nil || nats[0].Construct.Kind != LookupConstructRouter || nats[0].Construct.Name != "GR_cnv-1" {
		t.Fatalf("expected the gateway router as the NAT's construct, got %+v", nats[0].Construct)
	}
	if nats[0].RowName != "" {
		t.Fatalf("a NAT row has no name, got %q", nats[0].RowName)
	}
}

// An address that no row holds is still placed by the ranges that contain
// it: the hit says which field and that it matched by containment.
func TestLookupIPReportsContainingRanges(t *testing.T) {
	response := lookupFixtures(t, "ip", "10.131.0.70")
	containing := hitsWhere(response.Hits, func(hit LookupHit) bool { return hit.MatchType == LookupMatchContainment })
	if len(containing) == 0 {
		t.Fatal("expected containment hits")
	}

	fields := map[LookupField]map[string]bool{}
	for _, hit := range containing {
		if fields[hit.MatchedField] == nil {
			fields[hit.MatchedField] = map[string]bool{}
		}
		fields[hit.MatchedField][hit.MatchedValue] = true
		if hit.MatchedValue == "0.0.0.0/0" {
			t.Fatalf("a default route contains every address and must not be a hit: %+v", hit)
		}
	}
	if !fields[LookupFieldSubnet]["10.131.0.0/23"] {
		t.Errorf("expected the node switch subnet 10.131.0.0/23, got %v", fields[LookupFieldSubnet])
	}
	if !fields[LookupFieldIPPrefix]["10.131.0.0/23"] || !fields[LookupFieldIPPrefix]["10.128.0.0/14"] {
		t.Errorf("expected the routes for 10.131.0.0/23 and 10.128.0.0/14, got %v", fields[LookupFieldIPPrefix])
	}
	// The other zones know the address only through their route to it.
	for _, node := range []string{"cnv-2", "ctrl-1"} {
		routes := hitsWhere(containing, func(hit LookupHit) bool {
			return hit.Node == node && hit.Table == LookupTableStaticRoute && hit.MatchedValue == "10.131.0.0/23"
		})
		if len(routes) != 1 || routes[0].Construct == nil || routes[0].Construct.Name != "ovn_cluster_router" {
			t.Errorf("expected %s to route 10.131.0.0/23 on ovn_cluster_router, got %+v", node, routes)
		}
	}

	// A NAT rule written for a whole subnet contains the addresses in it.
	inSubnet := lookupFixtures(t, "ip", "10.1.2.77")
	nats := hitsWhere(inSubnet.Hits, func(hit LookupHit) bool { return hit.Table == LookupTableNAT })
	if len(nats) == 0 {
		t.Fatal("expected the subnet SNAT rules to contain 10.1.2.77")
	}
	for _, hit := range nats {
		if hit.MatchType != LookupMatchContainment || hit.MatchedField != LookupFieldLogicalIP || hit.MatchedValue != "10.1.2.0/24" {
			t.Fatalf("unexpected NAT containment hit: %+v", hit)
		}
		if hit.Network != "cluster_udn_example-p-cudn" {
			t.Fatalf("expected the NAT's own network, got %q", hit.Network)
		}
	}
	exact := hitsWhere(inSubnet.Hits, func(hit LookupHit) bool { return hit.MatchType == LookupMatchExact })
	if len(exact) != 0 {
		t.Fatalf("no row holds 10.1.2.77 itself, got %+v", exact)
	}
}

// User-defined network subnets may overlap, and the transit subnet is the
// same in every network: one address, several networks. Every hit is
// returned; none is chosen over another.
func TestLookupIPPresentInTwoNetworksReturnsBoth(t *testing.T) {
	response := lookupFixtures(t, "ip", "100.88.0.5")
	if response.Truncated {
		t.Fatal("did not expect truncation")
	}

	onNode := hitsWhere(response.Hits, func(hit LookupHit) bool {
		return hit.Node == "cnv-1" && hit.Table == LookupTableLogicalRouterPort
	})
	networks := map[string]LookupHit{}
	for _, hit := range onNode {
		if hit.MatchType != LookupMatchExact || hit.MatchedField != LookupFieldNetworks || hit.MatchedValue != "100.88.0.5/16" {
			t.Fatalf("unexpected router port hit: %+v", hit)
		}
		if _, seen := networks[hit.Network]; seen {
			t.Fatalf("two hits for network %q in one zone: %+v", hit.Network, onNode)
		}
		networks[hit.Network] = hit
	}
	if len(networks) != 2 {
		t.Fatalf("expected the address in two networks of zone cnv-1, got %+v", onNode)
	}
	if hit := networks[DefaultNetwork]; hit.RowName != "rtots-cnv-1" || hit.Construct.Name != "ovn_cluster_router" {
		t.Fatalf("unexpected default-network hit: %+v", hit)
	}
	// The user-defined network's port names no network itself: it inherits
	// the identity of the router that lists it.
	udn := networks["demo-mirror_example-l3-udn"]
	if udn.RowName != "demo.mirror_example.l3.udn_rtots-cnv-1" || udn.Construct.Name != "demo.mirror_example.l3.udn_ovn_cluster_router" {
		t.Fatalf("unexpected user-defined network hit: %+v", udn)
	}

	// The other zones see the same address as a remote port on each
	// network's transit switch: again one hit per network.
	for _, node := range []string{"cnv-2", "ctrl-1"} {
		remote := hitsWhere(response.Hits, func(hit LookupHit) bool {
			return hit.Node == node && hit.Table == LookupTableLogicalSwitchPort
		})
		seen := map[string]bool{}
		for _, hit := range remote {
			seen[hit.Network] = true
		}
		if len(remote) != 2 || !seen[DefaultNetwork] || !seen["demo-mirror_example-l3-udn"] {
			t.Fatalf("expected %s to hold the address in both networks, got %+v", node, remote)
		}
	}
}

func TestLookupMACIsNormalisedAndFindsThePort(t *testing.T) {
	response := lookupFixtures(t, "mac", "0A-58-0A-83-00-46")
	if response.Query.Value != "0a:58:0a:83:00:46" {
		t.Fatalf("expected the MAC in lower-case colon form, got %q", response.Query.Value)
	}
	if response.Total != 1 || len(response.Hits) != 1 {
		t.Fatalf("expected one hit, got %d: %+v", response.Total, response.Hits)
	}
	hit := response.Hits[0]
	if hit.Table != LookupTableLogicalSwitchPort || hit.MatchType != LookupMatchExact || hit.MatchedField != LookupFieldAddresses {
		t.Fatalf("unexpected hit: %+v", hit)
	}
	if hit.Owner == nil || hit.Owner.Kind != "Pod" || hit.Construct == nil || hit.Construct.Name != "cnv-1" {
		t.Fatalf("expected the pod and its switch, got owner %+v construct %+v", hit.Owner, hit.Construct)
	}

	// A router port's MAC, shared by the port of each network on the node
	// and by the remote ports that stand for it in the other zones.
	routerMAC := lookupFixtures(t, "mac", "0a:58:64:58:00:05")
	ports := hitsWhere(routerMAC.Hits, func(hit LookupHit) bool { return hit.Table == LookupTableLogicalRouterPort })
	if len(ports) < 2 {
		t.Fatalf("expected the MAC on a router port in two networks, got %+v", ports)
	}
	for _, port := range ports {
		if port.MatchedField != LookupFieldMAC || port.MatchedValue != "0a:58:64:58:00:05" || port.MatchType != LookupMatchExact {
			t.Fatalf("unexpected router port hit: %+v", port)
		}
	}
	if balancers := hitsWhere(routerMAC.Hits, func(hit LookupHit) bool { return hit.Table == LookupTableLoadBalancer }); len(balancers) != 0 {
		t.Fatalf("a MAC lookup must not match load balancers: %+v", balancers)
	}
}

func TestLookupCIDRMatchesTheSubnetItsCoverAndItsMembers(t *testing.T) {
	// Host bits are masked away: the query is the network.
	response := lookupFixtures(t, "cidr", "10.1.2.9/24")
	if response.Query.Value != "10.1.2.0/24" {
		t.Fatalf("expected the masked prefix, got %q", response.Query.Value)
	}
	assertOrdered(t, response.Hits)

	exactFields := map[LookupField]bool{}
	for _, hit := range hitsWhere(response.Hits, func(hit LookupHit) bool { return hit.MatchType == LookupMatchExact }) {
		exactFields[hit.MatchedField] = true
		if hit.MatchedValue != "10.1.2.0/24" || hit.Network != "cluster_udn_example-p-cudn" {
			t.Fatalf("unexpected exact hit: %+v", hit)
		}
	}
	for _, field := range []LookupField{LookupFieldSubnet, LookupFieldLogicalIP, LookupFieldIPPrefix} {
		if !exactFields[field] {
			t.Errorf("expected an exact %s match for the subnet, got %v", field, exactFields)
		}
	}

	// Addresses inside the queried prefix: the subnet's router port and the
	// management ports.
	within := hitsWhere(response.Hits, func(hit LookupHit) bool { return hit.MatchType == LookupMatchWithin })
	gateway := hitsWhere(within, func(hit LookupHit) bool {
		return hit.Table == LookupTableLogicalRouterPort && hit.MatchedValue == "10.1.2.1/24"
	})
	if len(gateway) != len(response.Zones) {
		t.Fatalf("expected the subnet's router port in every zone, got %+v", gateway)
	}
	if len(hitsWhere(response.Hits, func(hit LookupHit) bool { return hit.MatchType == LookupMatchContainment })) != 0 {
		t.Fatalf("nothing in the corpus covers 10.1.2.0/24 with a shorter prefix")
	}

	// A narrower query is covered by the node switch subnet and holds the
	// pods addressed inside it.
	narrow := lookupFixtures(t, "cidr", "10.131.0.0/24")
	assertOrdered(t, narrow.Hits)
	cover := hitsWhere(narrow.Hits, func(hit LookupHit) bool { return hit.MatchType == LookupMatchContainment })
	if len(cover) == 0 || cover[0].MatchedValue != "10.131.0.0/23" {
		t.Fatalf("expected 10.131.0.0/23 as the most specific covering range, got %+v", cover)
	}
	pods := hitsWhere(narrow.Hits, func(hit LookupHit) bool {
		return hit.MatchType == LookupMatchWithin && hit.Owner != nil && hit.Owner.Kind == "Pod"
	})
	if len(pods) == 0 {
		t.Fatal("expected pod ports inside 10.131.0.0/24")
	}
	for _, pod := range pods {
		if pod.Node != "cnv-1" || !strings.Contains(pod.MatchedValue, " 10.131.0.") {
			t.Fatalf("pod hit outside the queried prefix: %+v", pod)
		}
	}
}

func TestLookupNameMatchesPortsSwitchesAndRouters(t *testing.T) {
	// A pod, by part of its name: found through its switch port.
	pod := lookupFixtures(t, "name", "Thanos-Querier")
	if pod.Total != 1 {
		t.Fatalf("expected one hit, got %d: %+v", pod.Total, pod.Hits)
	}
	hit := pod.Hits[0]
	if hit.Table != LookupTableLogicalSwitchPort || hit.MatchType != LookupMatchSubstring || hit.MatchedField != LookupFieldName {
		t.Fatalf("unexpected pod hit: %+v", hit)
	}
	if hit.Owner == nil || hit.Owner.Kind != "Pod" || hit.Owner.Namespace != "openshift-monitoring" {
		t.Fatalf("expected the pod as owner, got %+v", hit.Owner)
	}

	// A namespace: every pod port in it, in every zone.
	namespace := lookupFixtures(t, "name", "openshift-monitoring")
	if namespace.Total < 2 {
		t.Fatalf("expected several ports in the namespace, got %d", namespace.Total)
	}
	for _, port := range namespace.Hits {
		if port.Table != LookupTableLogicalSwitchPort || port.Owner == nil || port.Owner.Namespace != "openshift-monitoring" {
			t.Fatalf("unexpected namespace hit: %+v", port)
		}
	}

	// A router by name: the exact name first, then the names that hold it.
	routers := lookupFixtures(t, "name", "OVN_cluster_router")
	assertOrdered(t, routers.Hits)
	exact := hitsWhere(routers.Hits, func(hit LookupHit) bool { return hit.MatchType == LookupMatchExact })
	if len(exact) != len(routers.Zones) {
		t.Fatalf("expected ovn_cluster_router once per zone, got %+v", exact)
	}
	for _, router := range exact {
		if router.Table != LookupTableLogicalRouter || router.RowName != "ovn_cluster_router" ||
			router.Construct == nil || router.Construct.UUID != router.RowUUID || router.Construct.Kind != LookupConstructRouter {
			t.Fatalf("a router is its own construct, got %+v", router)
		}
	}
	if len(hitsWhere(routers.Hits, func(hit LookupHit) bool {
		return hit.MatchType == LookupMatchSubstring && hit.RowName == "demo.mirror_example.l3.udn_ovn_cluster_router"
	})) == 0 {
		t.Fatalf("expected the user-defined network's cluster router as a substring match")
	}

	// A network by its real name. OVN object names replace dashes with dots
	// (example-p-cudn is spelled example.p.cudn in them), so only the
	// network identity in external_ids can match.
	network := lookupFixtures(t, "name", "example-p-cudn")
	if network.Total == 0 {
		t.Fatal("expected the network's switches and routers")
	}
	tables := map[LookupTable]bool{}
	for _, row := range network.Hits {
		tables[row.Table] = true
		if row.MatchedField != LookupFieldNetwork || row.Network != "cluster_udn_example-p-cudn" || row.Construct == nil {
			t.Fatalf("unexpected network hit: %+v", row)
		}
	}
	if !tables[LookupTableLogicalSwitch] || !tables[LookupTableLogicalRouter] {
		t.Fatalf("expected switches and routers of the network, got %v", tables)
	}
	if len(hitsWhere(network.Hits, func(hit LookupHit) bool {
		return hit.RowName == "cluster_udn_example.p.cudn_ovn_layer2_switch" && hit.Construct.Kind == LookupConstructSwitch
	})) != len(network.Zones) {
		t.Fatalf("expected the layer 2 switch in every zone")
	}
}

func TestLookupLoadBalancerVIPNeedsTheServicesSection(t *testing.T) {
	zones := fixtureZones(t)
	query := mustQuery(t, "ip", "172.30.0.10")

	withServices := Lookup(query, zones, 0)
	balancers := hitsWhere(withServices.Hits, func(hit LookupHit) bool { return hit.Table == LookupTableLoadBalancer })
	if len(balancers) == 0 {
		t.Fatal("expected load balancer hits for the cluster DNS VIP")
	}
	nodes := map[string]bool{}
	for _, hit := range balancers {
		nodes[hit.Node] = true
		if hit.MatchType != LookupMatchExact || hit.MatchedField != LookupFieldVIPs || !strings.HasPrefix(hit.MatchedValue, "172.30.0.10:") {
			t.Fatalf("unexpected VIP hit: %+v", hit)
		}
		if hit.Owner == nil || hit.Owner.Kind != "Service" || hit.Owner.Namespace != "openshift-dns" || hit.Owner.Name != "dns-default" {
			t.Fatalf("expected the Service as owner, got %+v", hit.Owner)
		}
		if hit.Construct != nil {
			t.Fatalf("a load balancer belongs to no single switch or router, got %+v", hit.Construct)
		}
		if hit.RowName == "" || hit.Network != DefaultNetwork {
			t.Fatalf("unexpected load balancer identity: %+v", hit)
		}
	}
	if len(nodes) != len(zones) {
		t.Fatalf("expected the VIP in every zone, got %v", nodes)
	}
	// The VIP is not a prefix of a longer one: 172.30.0.1 must not match
	// 172.30.0.10.
	for _, hit := range Lookup(mustQuery(t, "ip", "172.30.0.1"), zones, 0).Hits {
		if hit.Table == LookupTableLoadBalancer && !strings.HasPrefix(hit.MatchedValue, "172.30.0.1:") {
			t.Fatalf("172.30.0.1 matched another VIP: %+v", hit)
		}
	}

	// The same snapshots as a ladder-only cache entry would hold them.
	ladderOnly := make([]LogicalTopologySnapshot, len(zones))
	for index, zone := range zones {
		ladderOnly[index] = Project(zone, nil)
	}
	withoutServices := Lookup(query, ladderOnly, 0)
	if left := hitsWhere(withoutServices.Hits, func(hit LookupHit) bool { return hit.Table == LookupTableLoadBalancer }); len(left) != 0 {
		t.Fatalf("no services section, no load balancer hits; got %+v", left)
	}
	if withoutServices.Total != withServices.Total-len(balancers) {
		t.Fatalf("dropping the services section should drop only the load balancer hits: %d vs %d-%d",
			withoutServices.Total, withServices.Total, len(balancers))
	}
}

func TestLookupCapsHitsAndSaysSo(t *testing.T) {
	zones := fixtureZones(t)

	// The cluster network holds every pod port and NAT rule of the corpus:
	// far more rows than one response carries.
	wide := Lookup(mustQuery(t, "cidr", "10.128.0.0/14"), zones, 0)
	if wide.Limit != DefaultLookupLimit {
		t.Fatalf("expected the default limit, got %d", wide.Limit)
	}
	if wide.Total <= DefaultLookupLimit || !wide.Truncated || len(wide.Hits) != DefaultLookupLimit {
		t.Fatalf("expected truncation at %d, got total=%d truncated=%v hits=%d",
			DefaultLookupLimit, wide.Total, wide.Truncated, len(wide.Hits))
	}
	assertOrdered(t, wide.Hits)
	// What is cut is the tail of the order: the exact matches survive.
	if wide.Hits[0].MatchType != LookupMatchExact {
		t.Fatalf("expected the exact matches to lead a truncated response, got %+v", wide.Hits[0])
	}

	all := Lookup(mustQuery(t, "cidr", "10.128.0.0/14"), zones, wide.Total)
	if all.Truncated || len(all.Hits) != wide.Total {
		t.Fatalf("a limit equal to the total must not truncate: truncated=%v hits=%d", all.Truncated, len(all.Hits))
	}
	if !reflect.DeepEqual(wide.Hits, all.Hits[:DefaultLookupLimit]) {
		t.Fatal("a truncated response must be the head of the full one")
	}

	small := Lookup(mustQuery(t, "ip", "100.88.0.5"), zones, 2)
	if small.Limit != 2 || len(small.Hits) != 2 || !small.Truncated || small.Total <= 2 {
		t.Fatalf("unexpected small-limit response: limit=%d hits=%d truncated=%v total=%d",
			small.Limit, len(small.Hits), small.Truncated, small.Total)
	}

	none := Lookup(mustQuery(t, "ip", "203.0.113.9"), zones, 0)
	if none.Total != 0 || none.Truncated || none.Hits == nil || none.Warnings == nil || len(none.Zones) != len(zones) {
		t.Fatalf("a miss is an empty, untruncated answer over every zone: %+v", none)
	}
}

func TestParseLookupQueryRejectsWhatItCannotRead(t *testing.T) {
	rejected := []struct{ kind, value, wantInError string }{
		{"ip", "10.1.2", "not an IP address"},
		{"ip", "10.1.2.0/24", "not an IP address"},
		{"ip", "fe80::1%eth0", "not an IP address"},
		{"ip", "thanos", "not an IP address"},
		{"cidr", "10.1.2.5", "not a CIDR"},
		{"cidr", "10.1.2.0/33", "not a CIDR"},
		{"cidr", "10.1.2.0/", "not a CIDR"},
		{"mac", "0a:58:0a:83:00", "not a MAC address"},
		{"mac", "0a:58:0a:83:00:zz", "not a MAC address"},
		{"mac", "00:00:00:00:fe:80:00:00", "not a MAC address"},
		{"name", "   ", "value is required"},
		{"ip", "", "value is required"},
		{"pod", "thanos", "valid kinds: ip, mac, cidr, name"},
		{"", "thanos", "valid kinds: ip, mac, cidr, name"},
	}
	for _, tc := range rejected {
		if _, err := ParseLookupQuery(tc.kind, tc.value); err == nil || !strings.Contains(err.Error(), tc.wantInError) {
			t.Errorf("ParseLookupQuery(%q, %q) = %v, want an error naming %q", tc.kind, tc.value, err, tc.wantInError)
		}
	}

	accepted := []struct{ kind, value, want string }{
		{"ip", " 10.131.0.70 ", "10.131.0.70"},
		{"ip", "::ffff:10.131.0.70", "10.131.0.70"},
		{"ip", "FD69::5", "fd69::5"},
		{"cidr", "10.131.1.9/23", "10.131.0.0/23"},
		{"cidr", "fd69::5/112", "fd69::/112"},
		{"mac", "0A58.0A83.0046", "0a:58:0a:83:00:46"},
		{"name", " Thanos ", "Thanos"},
		{"name", "openshift-dns/dns-default", "openshift-dns/dns-default"},
	}
	for _, tc := range accepted {
		query, err := ParseLookupQuery(tc.kind, tc.value)
		if err != nil || query.Value != tc.want || string(query.Kind) != tc.kind {
			t.Errorf("ParseLookupQuery(%q, %q) = %+v, %v; want value %q", tc.kind, tc.value, query, err, tc.want)
		}
	}
}

// syntheticZone covers what the fixture corpus does not: IPv6, dynamic
// addresses, the ownership conventions the corpus has no row for, and rows
// nothing references.
func syntheticZone() LogicalTopologySnapshot {
	return LogicalTopologySnapshot{
		Metadata: Metadata{
			SchemaVersion: SchemaVersionV2,
			GeneratedAt:   time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC),
			SourceHealth:  "healthy",
			NodeName:      "node-a",
		},
		Database: &LogicalDatabase{
			LogicalSwitches: []LogicalSwitchRow{
				{
					UUID:        "ls-blue",
					Name:        "team.a_blue_ovn_layer2_switch",
					PortUUIDs:   []string{"lsp-pod", "lsp-dynamic", "lsp-secure"},
					OtherConfig: map[string]string{"subnet": "10.20.0.0/24", "ipv6_prefix": "fd00:20::"},
					ExternalIDs: map[string]string{"k8s.ovn.org/network": "team-a_blue", "k8s.ovn.org/role": "primary"},
				},
				{
					UUID:        "ls-owned",
					Name:        "owned",
					PortUUIDs:   []string{},
					ExternalIDs: map[string]string{"k8s.ovn.org/owner-controller": "team-a_green-network-controller"},
				},
			},
			LogicalRouters: []LogicalRouterRow{
				{
					UUID:             "lr-default",
					Name:             "GR_node-a",
					PortUUIDs:        []string{"lrp-v6"},
					NATUUIDs:         []string{"nat-eip", "nat-mac"},
					StaticRouteUUIDs: []string{"route-default", "route-host", "route-v6"},
				},
			},
			LogicalSwitchPorts: []LogicalSwitchPortRow{
				{
					UUID:         "lsp-pod",
					Name:         "team.a.blue_team-a_web-0",
					Addresses:    []string{"0a:58:0a:14:00:05 10.20.0.5 fd00:20::5"},
					PortSecurity: []string{"0a:58:0a:14:00:05 10.20.0.5 fd00:20::5"},
					ExternalIDs:  map[string]string{"namespace": "team-a", "pod": "true"},
				},
				{
					UUID:             "lsp-dynamic",
					Name:             "dynamic-port",
					Addresses:        []string{"dynamic"},
					DynamicAddresses: "0a:00:00:00:00:07 10.20.0.7",
				},
				{
					UUID:         "lsp-secure",
					Name:         "secure-port",
					Addresses:    []string{"unknown"},
					PortSecurity: []string{"0a:00:00:00:00:08 10.20.0.8/24"},
				},
				{
					UUID:      "lsp-orphan",
					Name:      "orphan-port",
					Addresses: []string{"0a:00:00:00:00:09 10.20.0.9"},
				},
			},
			LogicalRouterPorts: []LogicalRouterPortRow{
				{UUID: "lrp-v6", Name: "rtoe-GR_node-a", MAC: "0A:00:00:00:00:01", Networks: []string{"192.0.2.10/24", "2001:db8::10/64"}},
			},
			NATs: []NATRow{
				{
					UUID:        "nat-eip",
					Type:        "snat",
					ExternalIP:  "192.0.2.50",
					LogicalIP:   "10.20.0.5",
					ExternalIDs: map[string]string{"k8s.ovn.org/owner-type": "EgressIP", "k8s.ovn.org/name": "egress-blue_team-a/web-0", "k8s.ovn.org/owner-controller": "team-a_blue-network-controller"},
				},
				{UUID: "nat-mac", Type: "dnat_and_snat", ExternalIP: "192.0.2.51", LogicalIP: "10.20.0.7", ExternalMAC: "0a:00:00:00:00:51"},
				{UUID: "nat-orphan", Type: "snat", ExternalIP: "192.0.2.52", LogicalIP: "10.20.0.0/24"},
			},
			StaticRoutes: []StaticRouteRow{
				{UUID: "route-default", IPPrefix: "0.0.0.0/0", Nexthop: "192.0.2.1"},
				{UUID: "route-host", IPPrefix: "10.20.0.9/32", Nexthop: "100.64.0.9"},
				{UUID: "route-v6", IPPrefix: "::/0", Nexthop: "2001:db8::1"},
			},
			LoadBalancers: []LoadBalancerRow{
				{
					UUID:        "lb-v6",
					Name:        "Service_team-a/web_TCP_cluster",
					VIPs:        map[string]string{"[fd00:30::10]:443": "[fd00:20::5]:8443", "10.30.0.10:443": "10.20.0.5:8443", "10.30.0.10:80": ""},
					ExternalIDs: map[string]string{"k8s.ovn.org/kind": "Service", "k8s.ovn.org/owner": "team-a/web", "k8s.ovn.org/network": "team-a_blue"},
				},
			},
			LoadBalancerGroups: []LoadBalancerGroupRow{},
		},
	}
}

func lookupSynthetic(t *testing.T, kind, value string) LookupResponse {
	t.Helper()
	return Lookup(mustQuery(t, kind, value), []LogicalTopologySnapshot{syntheticZone()}, 0)
}

func onlyHit(t *testing.T, response LookupResponse, table LookupTable) LookupHit {
	t.Helper()
	hits := hitsWhere(response.Hits, func(hit LookupHit) bool { return hit.Table == table })
	if len(hits) != 1 {
		t.Fatalf("expected one %s hit, got %d: %+v", table, len(hits), response.Hits)
	}
	return hits[0]
}

func TestLookupRowYieldsOneHitWhateverFieldsMatch(t *testing.T) {
	// The pod port holds its address in addresses and in port_security.
	response := lookupSynthetic(t, "ip", "10.20.0.5")
	port := onlyHit(t, response, LookupTableLogicalSwitchPort)
	if port.MatchedField != LookupFieldAddresses {
		t.Fatalf("expected the first matching field, got %q", port.MatchedField)
	}
	if port.Owner == nil || port.Owner.Kind != "Pod" || port.Owner.Namespace != "team-a" || port.Owner.Name != "web-0" {
		t.Fatalf("a network-prefixed port name still names the pod by its last segment, got %+v", port.Owner)
	}
	if port.Network != "team-a_blue" || port.Construct == nil || port.Construct.UUID != "ls-blue" {
		t.Fatalf("expected the port to inherit its switch's network, got %+v", port)
	}

	// A NAT row that matches exactly on one field and by containment on
	// another reports the exact match.
	nat := lookupSynthetic(t, "ip", "192.0.2.52")
	if hit := onlyHit(t, nat, LookupTableNAT); hit.MatchType != LookupMatchExact || hit.MatchedField != LookupFieldExternalIP {
		t.Fatalf("unexpected NAT hit: %+v", hit)
	}
}

func TestLookupReadsEveryAddressFieldOfASwitchPort(t *testing.T) {
	dynamic := onlyHit(t, lookupSynthetic(t, "ip", "10.20.0.7"), LookupTableLogicalSwitchPort)
	if dynamic.RowName != "dynamic-port" || dynamic.MatchedField != LookupFieldDynamicAddresses {
		t.Fatalf("expected the dynamic address, got %+v", dynamic)
	}
	if dynamic.Owner != nil {
		t.Fatalf("a port with no ownership external_ids has no owner, got %+v", dynamic.Owner)
	}

	// port_security may carry a mask; the address still matches exactly.
	secure := onlyHit(t, lookupSynthetic(t, "ip", "10.20.0.8"), LookupTableLogicalSwitchPort)
	if secure.RowName != "secure-port" || secure.MatchedField != LookupFieldPortSecurity || secure.MatchType != LookupMatchExact {
		t.Fatalf("expected the port_security address, got %+v", secure)
	}
	if byMAC := onlyHit(t, lookupSynthetic(t, "mac", "0a:00:00:00:00:07"), LookupTableLogicalSwitchPort); byMAC.MatchedField != LookupFieldDynamicAddresses {
		t.Fatalf("expected the dynamic address MAC, got %+v", byMAC)
	}

	// The mask beside a port's address is its subnet, not a range the port
	// answers for: a neighbour in the subnet is not a hit on the port.
	neighbour := lookupSynthetic(t, "ip", "10.20.0.200")
	if ports := hitsWhere(neighbour.Hits, func(hit LookupHit) bool {
		return hit.Table == LookupTableLogicalSwitchPort || hit.Table == LookupTableLogicalRouterPort
	}); len(ports) != 0 {
		t.Fatalf("a port matched by the mask of its address: %+v", ports)
	}
}

func TestLookupHandlesIPv6(t *testing.T) {
	port := onlyHit(t, lookupSynthetic(t, "ip", "FD00:20:0:0::5"), LookupTableLogicalSwitchPort)
	if port.RowName != "team.a.blue_team-a_web-0" || port.MatchType != LookupMatchExact {
		t.Fatalf("unexpected IPv6 port hit: %+v", port)
	}

	routerPort := onlyHit(t, lookupSynthetic(t, "ip", "2001:db8::10"), LookupTableLogicalRouterPort)
	if routerPort.MatchedValue != "2001:db8::10/64" || routerPort.Construct == nil || routerPort.Construct.Name != "GR_node-a" {
		t.Fatalf("unexpected IPv6 router port hit: %+v", routerPort)
	}

	vip := onlyHit(t, lookupSynthetic(t, "ip", "fd00:30::10"), LookupTableLoadBalancer)
	if vip.MatchedValue != "[fd00:30::10]:443" || vip.Network != "team-a_blue" {
		t.Fatalf("unexpected IPv6 VIP hit: %+v", vip)
	}

	// other_config:ipv6_prefix is the bare /64 network.
	subnet := onlyHit(t, lookupSynthetic(t, "ip", "fd00:20::99"), LookupTableLogicalSwitch)
	if subnet.MatchedField != LookupFieldIPv6Prefix || subnet.MatchedValue != "fd00:20::" || subnet.MatchType != LookupMatchContainment {
		t.Fatalf("unexpected ipv6_prefix hit: %+v", subnet)
	}
	if exact := onlyHit(t, lookupSynthetic(t, "cidr", "fd00:20::/64"), LookupTableLogicalSwitch); exact.MatchType != LookupMatchExact {
		t.Fatalf("expected the /64 itself to match exactly, got %+v", exact)
	}

	// Neither default route contains anything, in either family, and an
	// IPv4 query never matches an IPv6 range.
	for _, address := range []string{"198.51.100.7", "2001:db8:ffff::1"} {
		if response := lookupSynthetic(t, "ip", address); response.Total != 0 {
			t.Fatalf("%s should match nothing, got %+v", address, response.Hits)
		}
	}
	// Asked for itself, a default route is the one exact match, ahead of
	// everything the zero-length prefix holds; the other family's default
	// route is not among them.
	everything := lookupSynthetic(t, "cidr", "0.0.0.0/0")
	if first := everything.Hits[0]; first.MatchType != LookupMatchExact || first.RowUUID != "route-default" {
		t.Fatalf("unexpected first hit: %+v", first)
	}
	for _, hit := range everything.Hits[1:] {
		if hit.MatchType != LookupMatchWithin || hit.RowUUID == "route-v6" {
			t.Fatalf("unexpected hit for 0.0.0.0/0: %+v", hit)
		}
	}
}

func TestLookupOwnershipAndNetworkConventions(t *testing.T) {
	// k8s.ovn.org/owner-type and k8s.ovn.org/name pass through as written;
	// the network comes from the row's own controller.
	eip := onlyHit(t, lookupSynthetic(t, "ip", "192.0.2.50"), LookupTableNAT)
	if eip.Owner == nil || eip.Owner.Kind != "EgressIP" || eip.Owner.Name != "egress-blue_team-a/web-0" || eip.Owner.Namespace != "" {
		t.Fatalf("unexpected owner: %+v", eip.Owner)
	}
	if eip.Network != "team-a_blue" {
		t.Fatalf("expected the network of the row's owner-controller, got %q", eip.Network)
	}
	if eip.Construct == nil || eip.Construct.Name != "GR_node-a" {
		t.Fatalf("unexpected construct: %+v", eip.Construct)
	}

	// The load balancer convention: kind plus namespace/name.
	vip := onlyHit(t, lookupSynthetic(t, "ip", "10.30.0.10"), LookupTableLoadBalancer)
	if vip.Owner == nil || vip.Owner.Kind != "Service" || vip.Owner.Namespace != "team-a" || vip.Owner.Name != "web" {
		t.Fatalf("unexpected owner: %+v", vip.Owner)
	}
	// Two keys hold the address; the hit reports the first in key order,
	// whatever order the map yields them in.
	if vip.MatchedValue != "10.30.0.10:443" {
		t.Fatalf("expected a stable VIP key, got %q", vip.MatchedValue)
	}

	// A NAT MAC, and a rule no router lists: no construct, default network.
	if byMAC := onlyHit(t, lookupSynthetic(t, "mac", "0a:00:00:00:00:51"), LookupTableNAT); byMAC.MatchedField != LookupFieldExternalMAC {
		t.Fatalf("unexpected NAT MAC hit: %+v", byMAC)
	}
	if routerPort := onlyHit(t, lookupSynthetic(t, "mac", "0a:00:00:00:00:01"), LookupTableLogicalRouterPort); routerPort.MatchedValue != "0A:00:00:00:00:01" {
		t.Fatalf("matchedValue should be the MAC as stored, got %+v", routerPort)
	}
	orphanNAT := onlyHit(t, lookupSynthetic(t, "ip", "192.0.2.52"), LookupTableNAT)
	if orphanNAT.Construct != nil || orphanNAT.Network != DefaultNetwork {
		t.Fatalf("an unreferenced row has no construct and no network of its own: %+v", orphanNAT)
	}
	orphanPort := hitsWhere(lookupSynthetic(t, "ip", "10.20.0.9").Hits, func(hit LookupHit) bool { return hit.RowUUID == "lsp-orphan" })
	if len(orphanPort) != 1 || orphanPort[0].Construct != nil {
		t.Fatalf("expected the unreferenced port without a construct, got %+v", orphanPort)
	}

	// A network named only by its controller, and a namespace that the port
	// name does not spell the way the query does.
	byNetwork := lookupSynthetic(t, "name", "owned")
	if hit := onlyHit(t, byNetwork, LookupTableLogicalSwitch); hit.Network != "team-a_green" || hit.MatchType != LookupMatchExact {
		t.Fatalf("unexpected hit: %+v", hit)
	}
	renamed := syntheticZone()
	renamed.Database.LogicalSwitchPorts[0].Name = "port-with-no-namespace-in-it"
	byNamespace := Lookup(mustQuery(t, "name", "TEAM-A"), []LogicalTopologySnapshot{renamed}, 0)
	if hit := onlyHit(t, byNamespace, LookupTableLogicalSwitchPort); hit.MatchedField != LookupFieldNamespace || hit.MatchedValue != "team-a" {
		t.Fatalf("expected the namespace external_id to match, got %+v", hit)
	}
}

func TestLookupSearchReportsEachZoneAndSurvivesAnEmptyOne(t *testing.T) {
	empty := LogicalTopologySnapshot{Metadata: Metadata{NodeName: "node-b", SourceHealth: "degraded"}}
	search := NewLookupSearch(mustQuery(t, "ip", "10.20.0.5"))
	search.AddZone(empty)
	search.AddZone(syntheticZone())
	response := search.Response(0)

	if len(response.Zones) != 2 || response.Zones[0].Node != "node-a" || response.Zones[1].Node != "node-b" {
		t.Fatalf("expected both zones, sorted by node, got %+v", response.Zones)
	}
	if response.Zones[1].SourceHealth != "degraded" || response.Zones[0].SnapshotGeneratedAt.IsZero() {
		t.Fatalf("zones should carry snapshot health and time: %+v", response.Zones)
	}
	for _, hit := range response.Hits {
		if hit.Node != "node-a" || !hit.SnapshotGeneratedAt.Equal(response.Zones[0].SnapshotGeneratedAt) {
			t.Fatalf("hit does not carry its zone's identity and snapshot time: %+v", hit)
		}
	}
	if response.Total == 0 {
		t.Fatal("expected hits from the populated zone")
	}
}

func TestLookupLoadBalancerRowReportsEveryVIPOnTheAddress(t *testing.T) {
	// The row holds 10.30.0.10:80 and :443 beside an IPv6 VIP.
	vip := onlyHit(t, lookupSynthetic(t, "ip", "10.30.0.10"), LookupTableLoadBalancer)
	want := []string{"10.30.0.10:443", "10.30.0.10:80"}
	if !reflect.DeepEqual(vip.MatchedValues, want) || vip.MatchedValue != want[0] {
		t.Fatalf("expected both VIPs of the row, got %q / %v", vip.MatchedValue, vip.MatchedValues)
	}
	// One matching VIP leaves the field out.
	single := onlyHit(t, lookupSynthetic(t, "ip", "fd00:30::10"), LookupTableLoadBalancer)
	if single.MatchedValues != nil {
		t.Fatalf("a single match should not carry matchedValues, got %v", single.MatchedValues)
	}
}
