package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
)

func writeAggregateFixture(t *testing.T, path string, payload snapshot.LogicalTopologySnapshot) {
	t.Helper()
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
}

func zoneSnapshot(nodeName string) snapshot.LogicalTopologySnapshot {
	return snapshot.LogicalTopologySnapshot{
		Metadata: snapshot.Metadata{
			SchemaVersion: snapshot.SchemaVersionV2,
			GeneratedAt:   time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC),
			SourceHealth:  "healthy",
			NodeName:      nodeName,
		},
		Database: &snapshot.LogicalDatabase{
			LogicalRouters:     []snapshot.LogicalRouterRow{},
			LogicalRouterPorts: []snapshot.LogicalRouterPortRow{},
			LogicalSwitches:    []snapshot.LogicalSwitchRow{},
			LogicalSwitchPorts: []snapshot.LogicalSwitchPortRow{},
			NATs:               []snapshot.NATRow{},
			StaticRoutes:       []snapshot.StaticRouteRow{},
		},
		Warnings: []snapshot.Warning{},
	}
}

func TestAggregateReturnsEveryZoneFromStore(t *testing.T) {
	tmpDir := t.TempDir()
	writeAggregateFixture(t, filepath.Join(tmpDir, "worker-a.json"), zoneSnapshot("worker-a"))
	writeAggregateFixture(t, filepath.Join(tmpDir, "worker-b.json"), zoneSnapshot("worker-b"))
	writeAggregateFixture(t, filepath.Join(tmpDir, "default.json"), zoneSnapshot(""))

	store := snapshot.NewFileStore(tmpDir, "default.json")
	srv := New(store).WithNodeLister(store)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/snapshots", nil)
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	var payload snapshot.ClusterLogicalTopology
	if err := json.Unmarshal(rr.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode aggregate payload: %v", err)
	}

	if payload.Metadata.SchemaVersion != snapshot.SchemaVersionV2 {
		t.Fatalf("unexpected schema version %q", payload.Metadata.SchemaVersion)
	}
	if payload.Metadata.SourceHealth != "healthy" {
		t.Fatalf("expected healthy aggregate, got %q", payload.Metadata.SourceHealth)
	}
	if len(payload.Snapshots) != 2 {
		t.Fatalf("expected two zones (default excluded), got %d", len(payload.Snapshots))
	}
	nodeNames := []string{payload.Snapshots[0].Metadata.NodeName, payload.Snapshots[1].Metadata.NodeName}
	if nodeNames[0] != "worker-a" || nodeNames[1] != "worker-b" {
		t.Fatalf("unexpected zone order: %v", nodeNames)
	}
}

type fakeLister struct {
	nodes []string
	err   error
}

func (f fakeLister) ListNodes(context.Context) ([]string, error) {
	return f.nodes, f.err
}

type fakeAggregateCollector struct {
	failNode string
}

func (f fakeAggregateCollector) Collect(_ context.Context, nodeName string) (snapshot.LogicalTopologySnapshot, error) {
	if nodeName == f.failNode {
		return snapshot.LogicalTopologySnapshot{}, errors.New("probe exploded")
	}
	return zoneSnapshot(nodeName), nil
}

func TestAggregateDegradesWhenOneZoneFails(t *testing.T) {
	tmpDir := t.TempDir()
	store := snapshot.NewFileStore(tmpDir, "")
	srv := NewWithLiveCollector(store, fakeAggregateCollector{failNode: "worker-b"}).
		WithNodeLister(fakeLister{nodes: []string{"worker-a", "worker-b"}})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/snapshots", nil)
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	var payload snapshot.ClusterLogicalTopology
	if err := json.Unmarshal(rr.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode aggregate payload: %v", err)
	}

	if payload.Metadata.SourceHealth != "degraded" {
		t.Fatalf("expected degraded aggregate, got %q", payload.Metadata.SourceHealth)
	}
	if len(payload.Snapshots) != 1 || payload.Snapshots[0].Metadata.NodeName != "worker-a" {
		t.Fatalf("expected only the surviving zone, got %#v", payload.Snapshots)
	}
	if len(payload.Warnings) != 1 || payload.Warnings[0].Code != "ZONE_COLLECTION_FAILED" {
		t.Fatalf("expected ZONE_COLLECTION_FAILED warning, got %#v", payload.Warnings)
	}
}

func TestAggregateWithoutListerReturnsNotFound(t *testing.T) {
	store := snapshot.NewFileStore(t.TempDir(), "")
	srv := New(store)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/snapshots", nil)
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404 when lister missing, got %d", rr.Code)
	}
}

func TestFileStoreListNodesExcludesFallback(t *testing.T) {
	tmpDir := t.TempDir()
	writeAggregateFixture(t, filepath.Join(tmpDir, "b-node.json"), zoneSnapshot("b-node"))
	writeAggregateFixture(t, filepath.Join(tmpDir, "a-node.json"), zoneSnapshot("a-node"))
	writeAggregateFixture(t, filepath.Join(tmpDir, "default.json"), zoneSnapshot(""))

	store := snapshot.NewFileStore(tmpDir, "default.json")
	nodes, err := store.ListNodes(context.Background())
	if err != nil {
		t.Fatalf("list nodes failed: %v", err)
	}
	if len(nodes) != 2 || nodes[0] != "a-node" || nodes[1] != "b-node" {
		t.Fatalf("unexpected nodes: %v", nodes)
	}
}
