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

func healthyOutputs() map[string]string {
	return map[string]string{
		strings.Join(logicalRouterCommand, " "):     `{"headings":["_uuid","name","ports","nat","static_routes","options","external_ids"],"data":[[["uuid","lr-1"],"cluster-router",["set",[["uuid","lrp-1"]]],["set",[["uuid","nat-1"]]],["set",[["uuid","sr-1"]]],["map",[]],["map",[["k8s.ovn.org/topology","layer3"]]]]]}`,
		strings.Join(logicalRouterPortCommand, " "): `{"headings":["_uuid","name","mac","networks","peer","gateway_chassis","options","external_ids"],"data":[[["uuid","lrp-1"],"rtos-red","0a:58:0a:f4:00:01",["set",["10.244.0.1/24"]],["set",[]],["set",[]],["map",[]],["map",[]]]]}`,
		strings.Join(logicalSwitchCommand, " "):     `{"headings":["_uuid","name","ports","other_config","external_ids"],"data":[[["uuid","ls-1"],"red-net",["set",[["uuid","lsp-r"],["uuid","lsp-pod"]]],["map",[["subnet","10.244.0.0/24"]]],["map",[["k8s.ovn.org/network","red"]]]]]}`,
		strings.Join(logicalSwitchPortCommand, " "): `{"headings":["_uuid","name","type","addresses","options","external_ids"],"data":[[["uuid","lsp-r"],"red-router-port","router",["set",["router"]],["map",[["router-port","rtos-red"]]],["map",[]]],[["uuid","lsp-pod"],"pod-a","",["set",["0a:58:0a:f4:00:05 10.244.0.5"]],["map",[]],["map",[]]]]}`,
		strings.Join(natCommand, " "):               `{"headings":["_uuid","type","external_ip","logical_ip","logical_port","external_mac","options","external_ids"],"data":[[["uuid","nat-1"],"snat","192.168.1.11","10.244.0.0/24",["set",[]],["set",[]],["map",[]],["map",[]]]]}`,
		strings.Join(staticRouteCommand, " "):       `{"headings":["_uuid","ip_prefix","nexthop","policy","output_port","options","external_ids"],"data":[[["uuid","sr-1"],"0.0.0.0/0","100.64.0.1",["set",[]],["set",[]],["map",[]],["map",[]]]]}`,
		strings.Join(chassisCommand, " "):           `{"headings":["other_config"],"data":[[["map",[["ovn-bridge-mappings","physnet-vmdata:br-vmdata,physnet:br-ex"],["ct-no-masked-label","true"]]]]]}`,
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
	if len(db.NATs) != 1 || db.NATs[0].Type != "snat" {
		t.Fatalf("unexpected NATs: %#v", db.NATs)
	}
	if len(db.StaticRoutes) != 1 || db.StaticRoutes[0].IPPrefix != "0.0.0.0/0" {
		t.Fatalf("unexpected static routes: %#v", db.StaticRoutes)
	}
	if len(db.BridgeMappings) != 2 || db.BridgeMappings[0].Localnet != "physnet" || db.BridgeMappings[0].Bridge != "br-ex" {
		t.Fatalf("unexpected bridge mappings: %#v", db.BridgeMappings)
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

func TestCollectSnapshotDegradesOnCommandFailure(t *testing.T) {
	outputs := healthyOutputs()
	delete(outputs, strings.Join(logicalRouterCommand, " "))
	runner := &fakeRunner{
		outputs: outputs,
		errs: map[string]error{
			strings.Join(logicalRouterCommand, " "): errors.New("exec denied"),
		},
	}

	snap, err := CollectSnapshot(context.Background(), runner, "worker-a", time.Now())
	if err != nil {
		t.Fatalf("collect snapshot failed unexpectedly: %v", err)
	}

	if snap.Metadata.SourceHealth != "degraded" {
		t.Fatalf("expected degraded source health, got %q", snap.Metadata.SourceHealth)
	}
	if len(snap.Warnings) == 0 {
		t.Fatalf("expected warnings for command failure")
	}
	if snap.Database == nil || len(snap.Database.LogicalSwitches) != 1 {
		t.Fatalf("expected remaining tables to survive a single command failure: %#v", snap.Database)
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
