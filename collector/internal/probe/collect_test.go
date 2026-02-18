package probe

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"
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

func TestCollectSnapshotBuildsExpectedTopology(t *testing.T) {
	now := time.Date(2026, 2, 14, 12, 0, 0, 0, time.UTC)
	runner := &fakeRunner{
		outputs: map[string]string{
			strings.Join(logicalRouterCommand, " "):     `{"headings":["_uuid","name","ports"],"data":[[["uuid","lr-1"],"cluster-router",["set",[["uuid","lrp-1"]]]]]}`,
			strings.Join(logicalRouterPortCommand, " "): `{"headings":["_uuid","name"],"data":[[["uuid","lrp-1"],"rtos-red"]]}`,
			strings.Join(logicalSwitchCommand, " "):     `{"headings":["_uuid","name","ports"],"data":[[["uuid","ls-1"],"red-net",["set",[["uuid","lsp-r"],["uuid","lsp-pod"]]]]]}`,
			strings.Join(logicalSwitchPortCommand, " "): `{"headings":["_uuid","name","type","options"],"data":[[["uuid","lsp-r"],"red-router-port","router",["map",[["router-port","rtos-red"]]]],[["uuid","lsp-pod"],"pod-a","",["map",[]]]]}`,
		},
	}

	snapshot, err := CollectSnapshot(context.Background(), runner, "worker-a", now)
	if err != nil {
		t.Fatalf("collect snapshot failed: %v", err)
	}

	if snapshot.Metadata.NodeName != "worker-a" {
		t.Fatalf("unexpected node name: %q", snapshot.Metadata.NodeName)
	}
	if snapshot.Metadata.SourceHealth != "healthy" {
		t.Fatalf("expected healthy source, got %q", snapshot.Metadata.SourceHealth)
	}
	if len(snapshot.Warnings) != 0 {
		t.Fatalf("expected no warnings, got %#v", snapshot.Warnings)
	}

	nodeKinds := map[string]string{}
	for _, node := range snapshot.Nodes {
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
	for _, edge := range snapshot.Edges {
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
	runner := &fakeRunner{
		outputs: map[string]string{
			strings.Join(logicalRouterPortCommand, " "): `{"headings":["_uuid","name"],"data":[]}`,
			strings.Join(logicalSwitchCommand, " "):     `{"headings":["_uuid","name","ports"],"data":[]}`,
			strings.Join(logicalSwitchPortCommand, " "): `{"headings":["_uuid","name","type","options"],"data":[]}`,
		},
		errs: map[string]error{
			strings.Join(logicalRouterCommand, " "): errors.New("exec denied"),
		},
	}

	snapshot, err := CollectSnapshot(context.Background(), runner, "worker-a", time.Now())
	if err != nil {
		t.Fatalf("collect snapshot failed unexpectedly: %v", err)
	}

	if snapshot.Metadata.SourceHealth != "degraded" {
		t.Fatalf("expected degraded source health, got %q", snapshot.Metadata.SourceHealth)
	}
	if len(snapshot.Warnings) == 0 {
		t.Fatalf("expected warnings for command failure")
	}
}

func TestCollectSnapshotWithOptionsLogsProbeOutputWhenEnabled(t *testing.T) {
	now := time.Date(2026, 2, 14, 12, 0, 0, 0, time.UTC)
	runner := &fakeRunner{
		outputs: map[string]string{
			strings.Join(logicalRouterCommand, " "):     `{"headings":["_uuid","name","ports"],"data":[[["uuid","lr-1"],"cluster-router",["set",[["uuid","lrp-1"]]]]]}`,
			strings.Join(logicalRouterPortCommand, " "): `{"headings":["_uuid","name"],"data":[[["uuid","lrp-1"],"rtos-red"]]}`,
			strings.Join(logicalSwitchCommand, " "):     `{"headings":["_uuid","name","ports"],"data":[[["uuid","ls-1"],"red-net",["set",[["uuid","lsp-r"],["uuid","lsp-pod"]]]]]}`,
			strings.Join(logicalSwitchPortCommand, " "): `{"headings":["_uuid","name","type","options"],"data":[[["uuid","lsp-r"],"red-router-port","router",["map",[["router-port","rtos-red"]]]],[["uuid","lsp-pod"],"pod-a","",["map",[]]]]}`,
		},
	}

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
	runner := &fakeRunner{
		outputs: map[string]string{
			strings.Join(logicalRouterCommand, " "):     `{"headings":["_uuid","name","ports"],"data":[[["uuid","lr-1"],"cluster-router",["set",[["uuid","lrp-1"]]]]]}`,
			strings.Join(logicalRouterPortCommand, " "): `{"headings":["_uuid","name"],"data":[[["uuid","lrp-1"],"rtos-red"]]}`,
			strings.Join(logicalSwitchCommand, " "):     `{"headings":["_uuid","name","ports"],"data":[[["uuid","ls-1"],"red-net",["set",[["uuid","lsp-r"],["uuid","lsp-pod"]]]]]}`,
			strings.Join(logicalSwitchPortCommand, " "): `{"headings":["_uuid","name","type","options"],"data":[[["uuid","lsp-r"],"red-router-port","router",["map",[["router-port","rtos-red"]]]],[["uuid","lsp-pod"],"pod-a","",["map",[]]]]}`,
		},
	}

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
