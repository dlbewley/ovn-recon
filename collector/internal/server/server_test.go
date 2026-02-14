package server

import (
	"encoding/json"
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
