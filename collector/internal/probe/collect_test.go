package probe

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
)

type fakeRunner struct {
	outputs map[string]string
	errs    map[string]error
}

func (f *fakeRunner) Run(_ context.Context, command []string) (string, error) {
	key := strings.Join(command, " ")
	if err, ok := f.errs[key]; ok {
		return "", err
	}
	if out, ok := f.outputs[key]; ok {
		return out, nil
	}
	return "", errors.New("missing fixture for command: " + key)
}

// nbTransactOutput is what one ovsdb-client transact returns for the NB
// tables, in nbTables order: one result per select op, rows as objects.
// Single-element sets arrive as bare values, exactly as ovn-nbctl emits them.
const nbTransactOutput = `[` +
	`{"rows":[{"_uuid":["uuid","lr-1"],"_version":["uuid","v-lr-1"],"name":"cluster-router","ports":["uuid","lrp-1"],"nat":["uuid","nat-1"],"static_routes":["uuid","sr-1"],"enabled":["set",[]],"policies":["set",[["uuid","pol-1"],["uuid","pol-2"]]],"load_balancer":["uuid","lb-1"],"load_balancer_group":["set",[]],"copp":["uuid","copp-1"],"options":["map",[]],"external_ids":["map",[["k8s.ovn.org/topology","layer3"]]]}]},` +
	`{"rows":[{"_uuid":["uuid","lrp-1"],"_version":["uuid","v-lrp-1"],"name":"rtos-red","mac":"0a:58:0a:f4:00:01","networks":"10.244.0.1/24","peer":["set",[]],"enabled":["set",[]],"gateway_chassis":["uuid","gwc-1"],"status":["map",[["hosting-chassis","chassis-a"]]],"options":["map",[]],"external_ids":["map",[]]}]},` +
	`{"rows":[{"_uuid":["uuid","ls-1"],"_version":["uuid","v-ls-1"],"name":"red-net","ports":["set",[["uuid","lsp-r"],["uuid","lsp-pod"]]],"acls":["uuid","acl-1"],"load_balancer":["set",[]],"load_balancer_group":["uuid","lbg-1"],"qos_rules":["set",[]],"other_config":["map",[["subnet","10.244.0.0/24"]]],"external_ids":["map",[["k8s.ovn.org/network","red"]]]}]},` +
	`{"rows":[{"_uuid":["uuid","lsp-r"],"_version":["uuid","v-lsp-r"],"name":"red-router-port","type":"router","addresses":"router","port_security":["set",[]],"up":true,"enabled":["set",[]],"dynamic_addresses":["set",[]],"tag_request":["set",[]],"parent_name":["set",[]],"options":["map",[["router-port","rtos-red"]]],"external_ids":["map",[]]},{"_uuid":["uuid","lsp-pod"],"_version":["uuid","v-lsp-pod"],"name":"pod-a","type":"","addresses":"0a:58:0a:f4:00:05 10.244.0.5","port_security":"0a:58:0a:f4:00:05 10.244.0.5","up":false,"enabled":false,"dynamic_addresses":["set",[]],"tag_request":7,"parent_name":"pod-parent","options":["map",[["requested-chassis","chassis-a"]]],"external_ids":["map",[]]}]},` +
	`{"rows":[{"_uuid":["uuid","nat-1"],"_version":["uuid","v-nat-1"],"type":"snat","external_ip":"192.168.1.11","logical_ip":"10.244.0.0/24","logical_port":["set",[]],"external_mac":["set",[]],"gateway_port":["uuid","lrp-1"],"match":"ip4.dst == $a1","priority":10,"external_port_range":"32768-60999","options":["map",[]],"external_ids":["map",[]]}]},` +
	`{"rows":[{"_uuid":["uuid","sr-1"],"_version":["uuid","v-sr-1"],"ip_prefix":"0.0.0.0/0","nexthop":"100.64.0.1","policy":["set",[]],"output_port":["set",[]],"route_table":"","bfd":["set",[]],"selection_fields":["set",["ip_src","ip_dst"]],"options":["map",[]],"external_ids":["map",[]]}]},` +
	`{"rows":[{"_uuid":["uuid","gwc-1"],"_version":["uuid","v-gwc-1"],"name":"rtos-red-chassis-a","chassis_name":"chassis-a","priority":1,"options":["map",[]],"external_ids":["map",[]]}]},` +
	`{"rows":[{"_uuid":["uuid","nbg-1"],"_version":["uuid","v-nbg-1"],"name":"worker-a","nb_cfg":147,"nb_cfg_timestamp":1794168187186,"sb_cfg":147,"sb_cfg_timestamp":1794168187190,"hv_cfg":146,"hv_cfg_timestamp":1794168187191,"ipsec":false,"connections":["set",[]],"ssl":["set",[]],"options":["map",[["name","worker-a"],["northd_internal_version","26.03.4-57.el9fdp-21.8.0-82.14"]]],"external_ids":["map",[]]}]}` +
	`]`

const chassisOutput = `{"headings":["other_config"],"data":[[["map",[["ovn-bridge-mappings","physnet-vmdata:br-vmdata,physnet:br-ex"],["ct-no-masked-label","true"]]]]]}`

func healthyOutputs() map[string]string {
	return map[string]string{
		strings.Join(nbTransactCommand(nbTables), " "): nbTransactOutput,
		strings.Join(chassisCommand, " "):              chassisOutput,
	}
}

// legacyNBOutputs is the same database as nbTransactOutput read through the
// per-table ovn-nbctl list fallback.
func legacyNBOutputs() map[string]string {
	return map[string]string{
		strings.Join(nbListCommand("Logical_Router"), " "):              `{"headings":["_uuid","name","ports","nat","static_routes","options","external_ids"],"data":[[["uuid","lr-1"],"cluster-router",["set",[["uuid","lrp-1"]]],["set",[["uuid","nat-1"]]],["set",[["uuid","sr-1"]]],["map",[]],["map",[["k8s.ovn.org/topology","layer3"]]]]]}`,
		strings.Join(nbListCommand("Logical_Router_Port"), " "):         `{"headings":["_uuid","name","mac","networks","peer","gateway_chassis","options","external_ids"],"data":[[["uuid","lrp-1"],"rtos-red","0a:58:0a:f4:00:01",["set",["10.244.0.1/24"]],["set",[]],["set",[]],["map",[]],["map",[]]]]}`,
		strings.Join(nbListCommand("Logical_Switch"), " "):              `{"headings":["_uuid","name","ports","other_config","external_ids"],"data":[[["uuid","ls-1"],"red-net",["set",[["uuid","lsp-r"],["uuid","lsp-pod"]]],["map",[["subnet","10.244.0.0/24"]]],["map",[["k8s.ovn.org/network","red"]]]]]}`,
		strings.Join(nbListCommand("Logical_Switch_Port"), " "):         `{"headings":["_uuid","name","type","addresses","port_security","up","enabled","dynamic_addresses","tag_request","parent_name","options","external_ids"],"data":[[["uuid","lsp-r"],"red-router-port","router",["set",["router"]],["set",[]],true,["set",[]],["set",[]],["set",[]],["set",[]],["map",[["router-port","rtos-red"]]],["map",[]]],[["uuid","lsp-pod"],"pod-a","",["set",["0a:58:0a:f4:00:05 10.244.0.5"]],["set",["0a:58:0a:f4:00:05 10.244.0.5"]],false,false,["set",[]],7,"pod-parent",["map",[["requested-chassis","chassis-a"]]],["map",[]]]]}`,
		strings.Join(nbListCommand("NAT"), " "):                         `{"headings":["_uuid","type","external_ip","logical_ip","logical_port","external_mac","options","external_ids"],"data":[[["uuid","nat-1"],"snat","192.168.1.11","10.244.0.0/24",["set",[]],["set",[]],["map",[]],["map",[]]]]}`,
		strings.Join(nbListCommand("Logical_Router_Static_Route"), " "): `{"headings":["_uuid","ip_prefix","nexthop","policy","output_port","options","external_ids"],"data":[[["uuid","sr-1"],"0.0.0.0/0","100.64.0.1",["set",[]],["set",[]],["map",[]],["map",[]]]]}`,
		strings.Join(nbListCommand("Gateway_Chassis"), " "):             `{"headings":["_uuid","name","chassis_name","priority","options","external_ids"],"data":[[["uuid","gwc-1"],"rtos-red-chassis-a","chassis-a",1,["map",[]],["map",[]]]]}`,
		strings.Join(nbListCommand("NB_Global"), " "):                   `{"headings":["_uuid","name","nb_cfg","sb_cfg","hv_cfg","options","external_ids"],"data":[[["uuid","nbg-1"],"worker-a",147,147,146,["map",[["northd_internal_version","26.03.4"]]],["map",[]]]]}`,
	}
}

// fallbackOutputs makes the transact exec fail so collection takes the
// per-table path.
func fallbackOutputs() (map[string]string, map[string]error) {
	outputs := legacyNBOutputs()
	outputs[strings.Join(chassisCommand, " ")] = chassisOutput
	errs := map[string]error{
		strings.Join(nbTransactCommand(nbTables), " "): errors.New(`exec failed: "ovsdb-client": executable file not found`),
	}
	return outputs, errs
}

func TestNBTransactCommandSelectsEveryTableInOrder(t *testing.T) {
	command := nbTransactCommand([]string{"Logical_Router", "NAT"})
	if command[0] != "ovsdb-client" || command[3] != "transact" || command[4] != nbSocket {
		t.Fatalf("unexpected command shape: %#v", command)
	}
	want := `["OVN_Northbound",{"op":"select","table":"Logical_Router","where":[]},{"op":"select","table":"NAT","where":[]}]`
	if command[5] != want {
		t.Fatalf("unexpected transact body:\n got %s\nwant %s", command[5], want)
	}
}

func TestDecodeNBTransactDecodesRowsAndReportsPerOpErrors(t *testing.T) {
	raw := `[{"rows":[{"_uuid":["uuid","ls-1"],"_version":["uuid","v1"],"name":"red-net","ports":["set",[["uuid","a"],["uuid","b"]]],"other_config":["map",[["subnet","10.0.0.0/24"]]]}]},` +
		`{"details":"No table named Bogus.","error":"syntax error"},` +
		`null]`
	rows, errs, err := decodeNBTransact(raw, []string{"Logical_Switch", "Bogus", "NAT"})
	if err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	switches := logicalSwitchesFromRows(rows["Logical_Switch"])
	if len(switches) != 1 || switches[0].UUID != "ls-1" || switches[0].Name != "red-net" {
		t.Fatalf("unexpected switch rows: %#v", switches)
	}
	if got := switches[0].PortUUIDs; len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("set of uuids not decoded: %#v", got)
	}
	if switches[0].OtherConfig["subnet"] != "10.0.0.0/24" {
		t.Fatalf("map not decoded: %#v", switches[0].OtherConfig)
	}
	if errs["Bogus"] == nil || !strings.Contains(errs["Bogus"].Error(), "No table named Bogus") {
		t.Fatalf("expected per-op error for Bogus, got %v", errs["Bogus"])
	}
	if errs["NAT"] == nil || !strings.Contains(errs["NAT"].Error(), "aborted") {
		t.Fatalf("expected aborted error for NAT (null result), got %v", errs["NAT"])
	}
	if _, present := rows["NAT"]; present {
		t.Fatalf("aborted table should have no rows entry")
	}
}

func TestDecodeNBTransactRejectsResultCountMismatch(t *testing.T) {
	if _, _, err := decodeNBTransact(`[{"rows":[]}]`, []string{"A", "B"}); err == nil {
		t.Fatalf("expected error when result count differs from table count")
	}
	if _, _, err := decodeNBTransact(`not json`, []string{"A"}); err == nil {
		t.Fatalf("expected error for undecodable output")
	}
}

func TestParseChassisBridgeMappings(t *testing.T) {
	raw := `{"headings":["other_config"],"data":[[["map",[["ovn-bridge-mappings","physnet-vmdata:br-vmdata,physnet:br-ex"],["is-interconn","true"]]]]]}`

	mappings, normalized, err := ParseChassisBridgeMappings(raw)
	if err != nil {
		t.Fatalf("parse chassis mappings failed: %v", err)
	}
	if normalized {
		t.Fatalf("unexpected normalization")
	}
	if len(mappings) != 2 {
		t.Fatalf("expected two mappings, got %#v", mappings)
	}
	if mappings[0].Localnet != "physnet" || mappings[0].Bridge != "br-ex" {
		t.Fatalf("unexpected first mapping (sorted by localnet): %#v", mappings[0])
	}
	if mappings[1].Localnet != "physnet-vmdata" || mappings[1].Bridge != "br-vmdata" {
		t.Fatalf("unexpected second mapping: %#v", mappings[1])
	}
}

func TestParseChassisBridgeMappingsEmptyConfig(t *testing.T) {
	raw := `{"headings":["other_config"],"data":[[["map",[["is-interconn","true"]]]]]}`
	mappings, _, err := ParseChassisBridgeMappings(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(mappings) != 0 {
		t.Fatalf("expected no mappings, got %#v", mappings)
	}
}

func TestParseLogicalSwitchesNormalizesSingleQuotePayload(t *testing.T) {
	raw := `{'headings':['name','_uuid','ports'],'data':[['red-net',['uuid','ls-red'],['set', [['uuid','lsp-r']]]]]}`

	switches, normalized, err := ParseLogicalSwitches(raw)
	if err != nil {
		t.Fatalf("parse should succeed after normalization: %v", err)
	}
	if !normalized {
		t.Fatalf("expected parser to report normalization")
	}
	if len(switches) != 1 {
		t.Fatalf("expected one switch, got %d", len(switches))
	}
	if switches[0].UUID != "ls-red" {
		t.Fatalf("unexpected switch uuid: %q", switches[0].UUID)
	}
	if len(switches[0].PortUUIDs) != 1 || switches[0].PortUUIDs[0] != "lsp-r" {
		t.Fatalf("unexpected switch port uuids: %#v", switches[0].PortUUIDs)
	}
}

func TestParseNATs(t *testing.T) {
	raw := `{"headings":["_uuid","type","external_ip","logical_ip","logical_port","external_mac","options","external_ids"],"data":[[["uuid","nat-1"],"dnat_and_snat","192.168.1.50","10.244.1.5",["set",["red_pod-a"]],["set",[]],["map",[["stateless","false"]]],["map",[]]]]}`

	nats, normalized, err := ParseNATs(raw)
	if err != nil {
		t.Fatalf("parse NATs failed: %v", err)
	}
	if normalized {
		t.Fatalf("unexpected normalization")
	}
	if len(nats) != 1 {
		t.Fatalf("expected one NAT, got %d", len(nats))
	}
	nat := nats[0]
	if nat.UUID != "nat-1" || nat.Type != "dnat_and_snat" {
		t.Fatalf("unexpected NAT identity: %#v", nat)
	}
	if nat.ExternalIP != "192.168.1.50" || nat.LogicalIP != "10.244.1.5" {
		t.Fatalf("unexpected NAT addresses: %#v", nat)
	}
	if nat.LogicalPort != "red_pod-a" {
		t.Fatalf("optional logical_port not unwrapped from set: %#v", nat)
	}
	if nat.ExternalMAC != "" {
		t.Fatalf("empty optional external_mac should be empty string: %#v", nat)
	}
	if nat.Options["stateless"] != "false" {
		t.Fatalf("unexpected NAT options: %#v", nat.Options)
	}
}

func TestParseStaticRoutes(t *testing.T) {
	raw := `{"headings":["_uuid","ip_prefix","nexthop","policy","output_port","options","external_ids"],"data":[[["uuid","sr-1"],"192.0.2.0/24","100.88.0.2",["set",["src-ip"]],["set",["rtos-blue"]],["map",[]],["map",[["ic-learned-route","true"]]]]]}`

	routes, normalized, err := ParseStaticRoutes(raw)
	if err != nil {
		t.Fatalf("parse static routes failed: %v", err)
	}
	if normalized {
		t.Fatalf("unexpected normalization")
	}
	if len(routes) != 1 {
		t.Fatalf("expected one route, got %d", len(routes))
	}
	route := routes[0]
	if route.IPPrefix != "192.0.2.0/24" || route.Nexthop != "100.88.0.2" {
		t.Fatalf("unexpected route: %#v", route)
	}
	if route.Policy != "src-ip" || route.OutputPort != "rtos-blue" {
		t.Fatalf("optional scalars not unwrapped: %#v", route)
	}
	if route.ExternalIDs["ic-learned-route"] != "true" {
		t.Fatalf("unexpected external_ids: %#v", route.ExternalIDs)
	}
}

func TestParseLogicalRouterPortsCarriesNetworks(t *testing.T) {
	raw := `{"headings":["_uuid","name","mac","networks","peer","gateway_chassis","options","external_ids"],"data":[[["uuid","lrp-1"],"rtoj-GR_worker-a","0a:58:64:40:00:05",["set",["100.64.0.5/16"]],["set",["jtor-GR_worker-a"]],["set",[["uuid","gwc-1"]]],["map",[]],["map",[]]]]}`

	ports, _, err := ParseLogicalRouterPorts(raw)
	if err != nil {
		t.Fatalf("parse router ports failed: %v", err)
	}
	if len(ports) != 1 {
		t.Fatalf("expected one port, got %d", len(ports))
	}
	port := ports[0]
	if port.MAC != "0a:58:64:40:00:05" {
		t.Fatalf("unexpected mac: %q", port.MAC)
	}
	if len(port.Networks) != 1 || port.Networks[0] != "100.64.0.5/16" {
		t.Fatalf("unexpected networks: %#v", port.Networks)
	}
	if port.Peer != "jtor-GR_worker-a" {
		t.Fatalf("optional peer not unwrapped: %q", port.Peer)
	}
	if len(port.GatewayChassisUUIDs) != 1 || port.GatewayChassisUUIDs[0] != "gwc-1" {
		t.Fatalf("unexpected gateway chassis: %#v", port.GatewayChassisUUIDs)
	}
}

func TestOptionalBoolAndIntFields(t *testing.T) {
	row := map[string]any{
		"unset":    []any{},
		"on":       true,
		"off":      false,
		"count":    float64(42),
		"optCount": []any{float64(7)},
		"text":     "9",
	}
	if optionalBoolField(row, "unset") != nil || optionalBoolField(row, "missing") != nil {
		t.Fatal("empty set and missing column should read as nil")
	}
	if value := optionalBoolField(row, "on"); value == nil || !*value {
		t.Fatalf("expected true, got %v", value)
	}
	if value := optionalBoolField(row, "off"); value == nil || *value {
		t.Fatalf("expected false, got %v", value)
	}
	if intField(row, "count") != 42 || intField(row, "optCount") != 7 || intField(row, "text") != 9 {
		t.Fatalf("unexpected integer decoding: %v %v %v", intField(row, "count"), intField(row, "optCount"), intField(row, "text"))
	}
	if intField(row, "unset") != 0 || intField(row, "missing") != 0 {
		t.Fatal("empty set and missing column should read as zero")
	}
}

func TestCollectSnapshotBuildsExpectedTopology(t *testing.T) {
	now := time.Date(2026, 2, 14, 12, 0, 0, 0, time.UTC)
	runner := &fakeRunner{outputs: healthyOutputs()}

	snap, err := CollectSnapshot(context.Background(), runner, "worker-a", now)
	if err != nil {
		t.Fatalf("collect snapshot failed: %v", err)
	}

	if snap.Metadata.NodeName != "worker-a" {
		t.Fatalf("unexpected node name: %q", snap.Metadata.NodeName)
	}
	if snap.Metadata.SchemaVersion != snapshot.SchemaVersionV2 {
		t.Fatalf("expected schema version %q, got %q", snapshot.SchemaVersionV2, snap.Metadata.SchemaVersion)
	}
	if snap.Metadata.SourceHealth != "healthy" {
		t.Fatalf("expected healthy source, got %q", snap.Metadata.SourceHealth)
	}
	if len(snap.Warnings) != 0 {
		t.Fatalf("expected no warnings, got %#v", snap.Warnings)
	}

	db := snap.Database
	if db == nil {
		t.Fatal("expected database payload")
	}
	if len(db.LogicalRouters) != 1 || db.LogicalRouters[0].ExternalIDs["k8s.ovn.org/topology"] != "layer3" {
		t.Fatalf("unexpected routers: %#v", db.LogicalRouters)
	}
	if got := db.LogicalRouters[0].NATUUIDs; len(got) != 1 || got[0] != "nat-1" {
		t.Fatalf("unexpected router NAT refs: %#v", got)
	}
	if got := db.LogicalRouters[0].StaticRouteUUIDs; len(got) != 1 || got[0] != "sr-1" {
		t.Fatalf("unexpected router static route refs: %#v", got)
	}
	if len(db.LogicalSwitches) != 1 || db.LogicalSwitches[0].OtherConfig["subnet"] != "10.244.0.0/24" {
		t.Fatalf("unexpected switches: %#v", db.LogicalSwitches)
	}
	if len(db.LogicalSwitchPorts) != 2 {
		t.Fatalf("unexpected switch ports: %#v", db.LogicalSwitchPorts)
	}
	// LSP columns (ovn-recon-e2b.4): a bound router port with the optional
	// columns unset, and a pod port with port_security, up=false, an explicit
	// enabled=false and a requested-chassis option.
	routerLSP, podLSP := db.LogicalSwitchPorts[0], db.LogicalSwitchPorts[1]
	if routerLSP.Name != "red-router-port" || podLSP.Name != "pod-a" {
		t.Fatalf("unexpected switch port order: %q, %q", routerLSP.Name, podLSP.Name)
	}
	if routerLSP.Up == nil || !*routerLSP.Up || routerLSP.Enabled != nil || len(routerLSP.PortSecurity) != 0 ||
		routerLSP.DynamicAddresses != "" || routerLSP.TagRequest != "" || routerLSP.ParentName != "" {
		t.Fatalf("unexpected router LSP columns: %#v", routerLSP)
	}
	if len(podLSP.PortSecurity) != 1 || podLSP.PortSecurity[0] != "0a:58:0a:f4:00:05 10.244.0.5" {
		t.Fatalf("unexpected pod LSP port_security: %#v", podLSP.PortSecurity)
	}
	if podLSP.Up == nil || *podLSP.Up || podLSP.Enabled == nil || *podLSP.Enabled {
		t.Fatalf("pod LSP up/enabled should decode as explicit false: %#v", podLSP)
	}
	if podLSP.TagRequest != "7" || podLSP.ParentName != "pod-parent" || podLSP.DynamicAddresses != "" {
		t.Fatalf("unexpected pod LSP scalar columns: %#v", podLSP)
	}
	if podLSP.Options["requested-chassis"] != "chassis-a" {
		t.Fatalf("unexpected pod LSP options: %#v", podLSP.Options)
	}
	if len(db.NATs) != 1 || db.NATs[0].Type != "snat" {
		t.Fatalf("unexpected NATs: %#v", db.NATs)
	}
	if len(db.StaticRoutes) != 1 || db.StaticRoutes[0].IPPrefix != "0.0.0.0/0" {
		t.Fatalf("unexpected static routes: %#v", db.StaticRoutes)
	}
	if len(db.BridgeMappings) != 2 || db.BridgeMappings[0].Localnet != "physnet" || db.BridgeMappings[0].Bridge != "br-ex" {
		t.Fatalf("unexpected bridge mappings: %#v", db.BridgeMappings)
	}

	// Tier-1 columns (ovn-recon-e2b.3).
	router := db.LogicalRouters[0]
	if router.Enabled != nil {
		t.Fatalf("unset enabled should decode as nil, got %v", *router.Enabled)
	}
	if len(router.PolicyUUIDs) != 2 || router.PolicyUUIDs[1] != "pol-2" {
		t.Fatalf("unexpected router policies: %#v", router.PolicyUUIDs)
	}
	if len(router.LoadBalancerUUIDs) != 1 || router.LoadBalancerUUIDs[0] != "lb-1" || len(router.LoadBalancerGroupUUIDs) != 0 {
		t.Fatalf("unexpected router load balancer refs: %#v %#v", router.LoadBalancerUUIDs, router.LoadBalancerGroupUUIDs)
	}
	if router.Copp != "copp-1" {
		t.Fatalf("optional copp ref not unwrapped: %q", router.Copp)
	}
	routerPort := db.LogicalRouterPorts[0]
	if routerPort.Status["hosting-chassis"] != "chassis-a" {
		t.Fatalf("unexpected router port status: %#v", routerPort.Status)
	}
	if len(routerPort.GatewayChassisUUIDs) != 1 || routerPort.GatewayChassisUUIDs[0] != "gwc-1" {
		t.Fatalf("unexpected gateway chassis refs: %#v", routerPort.GatewayChassisUUIDs)
	}
	logicalSwitch := db.LogicalSwitches[0]
	if len(logicalSwitch.ACLUUIDs) != 1 || logicalSwitch.ACLUUIDs[0] != "acl-1" {
		t.Fatalf("unexpected switch acls: %#v", logicalSwitch.ACLUUIDs)
	}
	if len(logicalSwitch.LoadBalancerGroupUUIDs) != 1 || logicalSwitch.LoadBalancerGroupUUIDs[0] != "lbg-1" || len(logicalSwitch.QoSRuleUUIDs) != 0 {
		t.Fatalf("unexpected switch lb group / qos refs: %#v %#v", logicalSwitch.LoadBalancerGroupUUIDs, logicalSwitch.QoSRuleUUIDs)
	}
	nat := db.NATs[0]
	if nat.GatewayPort != "lrp-1" || nat.Match != "ip4.dst == $a1" || nat.Priority != 10 || nat.ExternalPortRange != "32768-60999" {
		t.Fatalf("unexpected NAT extras: %#v", nat)
	}
	route := db.StaticRoutes[0]
	if route.RouteTable != "" || route.BFD != "" || len(route.SelectionFields) != 2 || route.SelectionFields[0] != "ip_src" {
		t.Fatalf("unexpected static route extras: %#v", route)
	}
	if len(db.GatewayChassis) != 1 || db.GatewayChassis[0].UUID != "gwc-1" || db.GatewayChassis[0].ChassisName != "chassis-a" || db.GatewayChassis[0].Priority != 1 {
		t.Fatalf("unexpected gateway chassis rows: %#v", db.GatewayChassis)
	}
	if db.NBGlobal == nil || db.NBGlobal.Name != "worker-a" || db.NBGlobal.NBCfg != 147 || db.NBGlobal.HVCfg != 146 ||
		db.NBGlobal.Options["northd_internal_version"] != "26.03.4-57.el9fdp-21.8.0-82.14" {
		t.Fatalf("unexpected NB_Global row: %#v", db.NBGlobal)
	}

	nodeKinds := map[string]string{}
	for _, node := range snap.Nodes {
		nodeKinds[node.ID] = node.Kind
	}

	expectedKinds := map[string]string{
		"lr-1":    "logical_router",
		"ls-1":    "logical_switch",
		"lsp-r":   "logical_switch_port",
		"lsp-pod": "logical_switch_port",
	}
	for id, expectedKind := range expectedKinds {
		if gotKind := nodeKinds[id]; gotKind != expectedKind {
			t.Fatalf("unexpected kind for %s: got=%q want=%q", id, gotKind, expectedKind)
		}
	}

	edgeKinds := map[string]string{}
	for _, edge := range snap.Edges {
		edgeKinds[edge.ID] = edge.Kind
	}

	if edgeKinds["router_to_switch:lr-1:ls-1"] != "router_to_switch" {
		t.Fatalf("expected router_to_switch edge, got %#v", edgeKinds)
	}
	if edgeKinds["switch_to_port:ls-1:lsp-pod"] != "switch_to_port" {
		t.Fatalf("expected switch_to_port edge for pod port, got %#v", edgeKinds)
	}
}

func TestCollectSnapshotFallsBackToPerTableListWhenTransactFails(t *testing.T) {
	outputs, errs := fallbackOutputs()
	runner := &fakeRunner{outputs: outputs, errs: errs}

	snap, err := CollectSnapshot(context.Background(), runner, "worker-a", time.Now())
	if err != nil {
		t.Fatalf("collect snapshot failed unexpectedly: %v", err)
	}

	if snap.Metadata.SourceHealth != "degraded" {
		t.Fatalf("fallback should flag the snapshot as degraded, got %q", snap.Metadata.SourceHealth)
	}
	if len(snap.Warnings) != 1 || snap.Warnings[0].Code != "NB_TRANSACT_FAILED" {
		t.Fatalf("expected a single NB_TRANSACT_FAILED warning, got %#v", snap.Warnings)
	}

	db := snap.Database
	if len(db.LogicalRouters) != 1 || len(db.LogicalRouterPorts) != 1 || len(db.LogicalSwitches) != 1 ||
		len(db.LogicalSwitchPorts) != 2 || len(db.NATs) != 1 || len(db.StaticRoutes) != 1 || len(db.BridgeMappings) != 2 {
		t.Fatalf("fallback should read every table: %#v", db)
	}
	if db.LogicalRouters[0].PortUUIDs[0] != "lrp-1" || db.LogicalRouterPorts[0].Networks[0] != "10.244.0.1/24" {
		t.Fatalf("fallback rows should map identically to the transact rows: %#v %#v", db.LogicalRouters, db.LogicalRouterPorts)
	}
	if podLSP := db.LogicalSwitchPorts[1]; podLSP.Up == nil || *podLSP.Up || len(podLSP.PortSecurity) != 1 ||
		podLSP.TagRequest != "7" || podLSP.ParentName != "pod-parent" || podLSP.Options["requested-chassis"] != "chassis-a" {
		t.Fatalf("fallback should read the LSP columns: %#v", podLSP)
	}
	if len(db.GatewayChassis) != 1 || db.GatewayChassis[0].ChassisName != "chassis-a" || db.GatewayChassis[0].Priority != 1 {
		t.Fatalf("fallback should read Gateway_Chassis: %#v", db.GatewayChassis)
	}
	if db.NBGlobal == nil || db.NBGlobal.NBCfg != 147 || db.NBGlobal.HVCfg != 146 || db.NBGlobal.Options["northd_internal_version"] != "26.03.4" {
		t.Fatalf("fallback should read NB_Global: %#v", db.NBGlobal)
	}
}

func TestCollectSnapshotDegradesOnCommandFailure(t *testing.T) {
	outputs, errs := fallbackOutputs()
	delete(outputs, strings.Join(nbListCommand("Logical_Router"), " "))
	errs[strings.Join(nbListCommand("Logical_Router"), " ")] = errors.New("exec denied")
	runner := &fakeRunner{outputs: outputs, errs: errs}

	snap, err := CollectSnapshot(context.Background(), runner, "worker-a", time.Now())
	if err != nil {
		t.Fatalf("collect snapshot failed unexpectedly: %v", err)
	}

	if snap.Metadata.SourceHealth != "degraded" {
		t.Fatalf("expected degraded source health, got %q", snap.Metadata.SourceHealth)
	}
	codes := map[string]bool{}
	for _, warning := range snap.Warnings {
		codes[warning.Code] = true
	}
	if !codes["NB_TRANSACT_FAILED"] || !codes["COMMAND_FAILED"] {
		t.Fatalf("expected transact and command warnings, got %#v", snap.Warnings)
	}
	if snap.Database == nil || len(snap.Database.LogicalRouters) != 0 || len(snap.Database.LogicalSwitches) != 1 {
		t.Fatalf("expected remaining tables to survive a single command failure: %#v", snap.Database)
	}
}

func TestCollectSnapshotDegradesOnTransactOperationError(t *testing.T) {
	// The NAT select fails in-band; ovsdb-server aborts the following op.
	raw := `[` +
		`{"rows":[{"_uuid":["uuid","lr-1"],"name":"cluster-router","ports":["set",[]],"nat":["set",[]],"static_routes":["set",[]],"options":["map",[]],"external_ids":["map",[]]}]},` +
		`{"rows":[]},` +
		`{"rows":[{"_uuid":["uuid","ls-1"],"name":"red-net","ports":["set",[]],"other_config":["map",[]],"external_ids":["map",[]]}]},` +
		`{"rows":[]},` +
		`{"details":"boom","error":"syntax error"},` +
		`null,null,null]`
	outputs := healthyOutputs()
	outputs[strings.Join(nbTransactCommand(nbTables), " ")] = raw
	runner := &fakeRunner{outputs: outputs}

	snap, err := CollectSnapshot(context.Background(), runner, "worker-a", time.Now())
	if err != nil {
		t.Fatalf("collect snapshot failed unexpectedly: %v", err)
	}
	if snap.Metadata.SourceHealth != "degraded" {
		t.Fatalf("expected degraded source health, got %q", snap.Metadata.SourceHealth)
	}
	if len(snap.Warnings) != 4 {
		t.Fatalf("expected one warning per failed table, got %#v", snap.Warnings)
	}
	for _, warning := range snap.Warnings {
		if warning.Code != "COMMAND_FAILED" {
			t.Fatalf("expected COMMAND_FAILED warnings, got %#v", snap.Warnings)
		}
	}
	if len(snap.Database.LogicalRouters) != 1 || len(snap.Database.LogicalSwitches) != 1 {
		t.Fatalf("tables before the failed op should survive: %#v", snap.Database)
	}
	if len(snap.Database.NATs) != 0 || len(snap.Database.StaticRoutes) != 0 || len(snap.Database.GatewayChassis) != 0 || snap.Database.NBGlobal != nil {
		t.Fatalf("failed and aborted tables should be empty: %#v", snap.Database)
	}
}

func TestCollectSnapshotWithOptionsLogsProbeOutputWhenEnabled(t *testing.T) {
	now := time.Date(2026, 2, 14, 12, 0, 0, 0, time.UTC)
	runner := &fakeRunner{outputs: healthyOutputs()}

	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	_, err := CollectSnapshotWithOptions(context.Background(), runner, "worker-a", now, CollectOptions{
		Logger:             logger,
		IncludeProbeOutput: true,
	})
	if err != nil {
		t.Fatalf("collect snapshot failed: %v", err)
	}

	logOutput := buf.String()
	if !strings.Contains(logOutput, `"output"`) {
		t.Fatalf("expected output field in logs when includeProbeOutput=true, got: %s", logOutput)
	}
	if !strings.Contains(logOutput, "cluster-router") {
		t.Fatalf("expected raw probe output content in logs when includeProbeOutput=true, got: %s", logOutput)
	}
}

func TestCollectSnapshotWithOptionsOmitsProbeOutputByDefault(t *testing.T) {
	now := time.Date(2026, 2, 14, 12, 0, 0, 0, time.UTC)
	runner := &fakeRunner{outputs: healthyOutputs()}

	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	_, err := CollectSnapshotWithOptions(context.Background(), runner, "worker-a", now, CollectOptions{
		Logger:             logger,
		IncludeProbeOutput: false,
	})
	if err != nil {
		t.Fatalf("collect snapshot failed: %v", err)
	}

	logOutput := buf.String()
	if strings.Contains(logOutput, `"output":"`) {
		t.Fatalf("expected no raw output field in logs when includeProbeOutput=false, got: %s", logOutput)
	}
	if !strings.Contains(logOutput, `"outputBytes"`) {
		t.Fatalf("expected outputBytes field in logs when includeProbeOutput=false, got: %s", logOutput)
	}
}
