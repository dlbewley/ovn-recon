package server

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
)

const snapshotsPrefix = "/api/v1/snapshots/"

// Server wraps HTTP handlers for the OVN collector.
type Server struct{}

// New creates a collector HTTP server.
func New() *Server {
	return &Server{}
}

// Handler returns the collector HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/readyz", s.handleReady)
	mux.HandleFunc(snapshotsPrefix, s.handleSnapshotByNode)
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func (s *Server) handleReady(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func (s *Server) handleSnapshotByNode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	nodeName := strings.TrimPrefix(r.URL.Path, snapshotsPrefix)
	nodeName = strings.TrimSpace(nodeName)
	if nodeName == "" || strings.Contains(nodeName, "/") {
		http.Error(w, "missing or invalid node name", http.StatusBadRequest)
		return
	}

	payload := snapshot.LogicalTopologySnapshot{
		Metadata: snapshot.Metadata{
			SchemaVersion: "v1alpha1",
			GeneratedAt:   time.Now().UTC(),
			SourceHealth:  "degraded",
			NodeName:      nodeName,
		},
		Warnings: []snapshot.Warning{
			{
				Code:    "COLLECTOR_STUB",
				Message: "collector skeleton endpoint is active; OVN probing not implemented yet",
			},
		},
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("failed to encode snapshot payload for node %q: %v", nodeName, err)
		http.Error(w, fmt.Sprintf("failed to encode payload: %v", err), http.StatusInternalServerError)
		return
	}
}
