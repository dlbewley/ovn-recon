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

func TestSnapshotEndpointReturnsNodeScopedPayload(t *testing.T) {
	tmpDir := t.TempDir()
	writeFixture(t, filepath.Join(tmpDir, "worker-a.json"), snapshot.LogicalTopologySnapshot{
		Metadata: snapshot.Metadata{
			SchemaVersion: "v1alpha1",
			NodeName:      "worker-a",
			SourceHealth:  "healthy",
			GeneratedAt:   time.Date(2026, 2, 14, 12, 0, 0, 0, time.UTC),
		},
	})

	s := New(snapshot.NewFileStore(tmpDir, "default.json"))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/snapshots/worker-a", nil)
	rr := httptest.NewRecorder()

	s.Handler().ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	if got := rr.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("expected Cache-Control=no-store, got %q", got)
	}
	if got := rr.Header().Get(headerSnapshotSourceHealth); got != "healthy" {
		t.Fatalf("expected %s=healthy, got %q", headerSnapshotSourceHealth, got)
	}
	if got := rr.Header().Get(headerSnapshotNodeName); got != "worker-a" {
		t.Fatalf("expected %s=worker-a, got %q", headerSnapshotNodeName, got)
	}
	if got := rr.Header().Get(headerSnapshotGeneratedAt); got != "2026-02-14T12:00:00Z" {
		t.Fatalf("expected %s=2026-02-14T12:00:00Z, got %q", headerSnapshotGeneratedAt, got)
	}

	var payload snapshot.LogicalTopologySnapshot
	if err := json.Unmarshal(rr.Body.Bytes(), &payload); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}

	if payload.Metadata.NodeName != "worker-a" {
		t.Fatalf("expected nodeName worker-a, got %q", payload.Metadata.NodeName)
	}
}

func TestSnapshotEndpointUsesLiveCollectorPayload(t *testing.T) {
	tmpDir := t.TempDir()
	writeFixture(t, filepath.Join(tmpDir, "worker-a.json"), snapshot.LogicalTopologySnapshot{
		Metadata: snapshot.Metadata{
			SchemaVersion: "v1alpha1",
			NodeName:      "worker-a",
			SourceHealth:  "degraded",
		},
		Warnings: []snapshot.Warning{{Code: "FALLBACK", Message: "fixture fallback"}},
	})

	collector := &fakeLiveCollector{
		payload: snapshot.LogicalTopologySnapshot{
			Metadata: snapshot.Metadata{
				SchemaVersion: "v1alpha1",
				NodeName:      "worker-a",
				SourceHealth:  "healthy",
				GeneratedAt:   time.Date(2026, 2, 16, 8, 12, 0, 0, time.UTC),
			},
			Nodes: []snapshot.Node{{ID: "router-a", Kind: "logical_router", Label: "router-a"}},
		},
	}

	s := NewWithLiveCollector(snapshot.NewFileStore(tmpDir, "default.json"), collector)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/snapshots/worker-a", nil)
	rr := httptest.NewRecorder()

	s.Handler().ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	if got := rr.Header().Get(headerSnapshotSourceHealth); got != "healthy" {
		t.Fatalf("expected %s=healthy, got %q", headerSnapshotSourceHealth, got)
	}

	var payload snapshot.LogicalTopologySnapshot
	if err := json.Unmarshal(rr.Body.Bytes(), &payload); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}
	if len(payload.Nodes) != 1 || payload.Nodes[0].ID != "router-a" {
		t.Fatalf("expected live collector payload, got %#v", payload.Nodes)
	}
	if collector.calls != 1 {
		t.Fatalf("expected live collector to be called once, got %d", collector.calls)
	}
}

func TestSnapshotEndpointFallsBackWhenLiveCollectorFails(t *testing.T) {
	tmpDir := t.TempDir()
	writeFixture(t, filepath.Join(tmpDir, "default.json"), snapshot.LogicalTopologySnapshot{
		Metadata: snapshot.Metadata{
			SchemaVersion: "v1alpha1",
			SourceHealth:  "healthy",
		},
	})

	collector := &fakeLiveCollector{
		err: errors.New("exec to OVN pod failed"),
	}

	s := NewWithLiveCollector(snapshot.NewFileStore(tmpDir, "default.json"), collector)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/snapshots/worker-missing", nil)
	rr := httptest.NewRecorder()

	s.Handler().ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	if got := rr.Header().Get(headerSnapshotSourceHealth); got != "degraded" {
		t.Fatalf("expected %s=degraded, got %q", headerSnapshotSourceHealth, got)
	}

	var payload snapshot.LogicalTopologySnapshot
	if err := json.Unmarshal(rr.Body.Bytes(), &payload); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}
	if payload.Metadata.SourceHealth != "degraded" {
		t.Fatalf("expected degraded source health, got %q", payload.Metadata.SourceHealth)
	}
	foundWarning := false
	for _, warning := range payload.Warnings {
		if warning.Code == "LIVE_PROBE_FAILED" {
			foundWarning = true
			if warning.Message == "" {
				t.Fatalf("expected warning message to include probe failure details")
			}
		}
	}
	if !foundWarning {
		t.Fatalf("expected LIVE_PROBE_FAILED warning, got %#v", payload.Warnings)
	}
	if collector.calls != 1 {
		t.Fatalf("expected live collector to be called once, got %d", collector.calls)
	}
}

func TestSnapshotEndpointFallsBackToDefault(t *testing.T) {
	tmpDir := t.TempDir()
	writeFixture(t, filepath.Join(tmpDir, "default.json"), snapshot.LogicalTopologySnapshot{
		Metadata: snapshot.Metadata{SchemaVersion: "v1alpha1", SourceHealth: "degraded"},
		Warnings: []snapshot.Warning{{Code: "FALLBACK", Message: "default snapshot"}},
	})

	s := New(snapshot.NewFileStore(tmpDir, "default.json"))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/snapshots/worker-missing", nil)
	rr := httptest.NewRecorder()

	s.Handler().ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	if got := rr.Header().Get(headerSnapshotSourceHealth); got != "degraded" {
		t.Fatalf("expected %s=degraded, got %q", headerSnapshotSourceHealth, got)
	}
	if got := rr.Header().Get(headerSnapshotNodeName); got != "worker-missing" {
		t.Fatalf("expected %s=worker-missing, got %q", headerSnapshotNodeName, got)
	}
}

func TestSnapshotEndpointRejectsMissingNode(t *testing.T) {
	s := New(snapshot.NewFileStore(t.TempDir(), "default.json"))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/snapshots/", nil)
	rr := httptest.NewRecorder()

	s.Handler().ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rr.Code)
	}
}

func TestSnapshotEndpointReturnsNotFound(t *testing.T) {
	s := New(snapshot.NewFileStore(t.TempDir(), "default.json"))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/snapshots/worker-missing", nil)
	rr := httptest.NewRecorder()

	s.Handler().ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rr.Code)
	}
}

func writeFixture(t *testing.T, path string, payload snapshot.LogicalTopologySnapshot) {
	t.Helper()
	bytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	if err := os.WriteFile(path, bytes, 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
}

type fakeLiveCollector struct {
	payload snapshot.LogicalTopologySnapshot
	err     error
	calls   int
}

func (f *fakeLiveCollector) Collect(_ context.Context, _ string) (snapshot.LogicalTopologySnapshot, error) {
	f.calls++
	if f.err != nil {
		return snapshot.LogicalTopologySnapshot{}, f.err
	}
	return f.payload, nil
}
