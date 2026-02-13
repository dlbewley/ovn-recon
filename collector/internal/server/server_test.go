package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
)

func TestSnapshotEndpointReturnsNodeScopedPayload(t *testing.T) {
	s := New()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/snapshots/worker-a", nil)
	rr := httptest.NewRecorder()

	s.Handler().ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}

	var payload snapshot.LogicalTopologySnapshot
	if err := json.Unmarshal(rr.Body.Bytes(), &payload); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}

	if payload.Metadata.NodeName != "worker-a" {
		t.Fatalf("expected nodeName worker-a, got %q", payload.Metadata.NodeName)
	}
}

func TestSnapshotEndpointRejectsMissingNode(t *testing.T) {
	s := New()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/snapshots/", nil)
	rr := httptest.NewRecorder()

	s.Handler().ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rr.Code)
	}
}
