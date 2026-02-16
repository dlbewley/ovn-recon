package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
)

const snapshotsPrefix = "/api/v1/snapshots/"
const (
	headerSnapshotGeneratedAt  = "X-OVN-Recon-Snapshot-Generated-At"
	headerSnapshotSourceHealth = "X-OVN-Recon-Snapshot-Source-Health"
	headerSnapshotNodeName     = "X-OVN-Recon-Snapshot-Node-Name"
)

// LiveCollector builds node-scoped snapshots by interrogating OVN at request time.
type LiveCollector interface {
	Collect(ctx context.Context, nodeName string) (snapshot.LogicalTopologySnapshot, error)
}

// Server wraps HTTP handlers for the OVN collector.
type Server struct {
	store         snapshot.Store
	liveCollector LiveCollector
	logger        *slog.Logger
}

// New creates a collector HTTP server.
func New(store snapshot.Store) *Server {
	return &Server{
		store:  store,
		logger: slog.Default(),
	}
}

// NewWithLiveCollector creates a collector HTTP server with live probing enabled.
func NewWithLiveCollector(store snapshot.Store, collector LiveCollector) *Server {
	s := New(store)
	s.liveCollector = collector
	return s
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

	logger := s.logger.With("node", nodeName)

	if s.liveCollector != nil {
		logger.Info("logical topology snapshot requested")
		payload, probeErr := s.liveCollector.Collect(r.Context(), nodeName)
		if probeErr == nil {
			s.writeSnapshot(w, payload, nodeName)
			return
		}

		logger.Warn("live OVN probe failed; falling back to file snapshot", "error", probeErr)
		payload, err := s.store.GetByNode(r.Context(), nodeName)
		if err != nil {
			s.writeStoreError(w, nodeName, err)
			return
		}
		payload = appendFallbackWarning(payload, nodeName, probeErr)
		if payload.Metadata.SourceHealth == "" || payload.Metadata.SourceHealth == "healthy" {
			payload.Metadata.SourceHealth = "degraded"
		}
		s.writeSnapshot(w, payload, nodeName)
		return
	}

	payload, err := s.store.GetByNode(r.Context(), nodeName)
	if err != nil {
		s.writeStoreError(w, nodeName, err)
		return
	}

	s.writeSnapshot(w, payload, nodeName)
}

func appendFallbackWarning(payload snapshot.LogicalTopologySnapshot, nodeName string, probeErr error) snapshot.LogicalTopologySnapshot {
	message := fmt.Sprintf("Live probe collection failed for node %s: %v", nodeName, probeErr)
	warning := snapshot.Warning{
		Code:    "LIVE_PROBE_FAILED",
		Message: message,
	}
	for _, existing := range payload.Warnings {
		if existing.Code == warning.Code && existing.Message == warning.Message {
			return payload
		}
	}
	payload.Warnings = append(payload.Warnings, warning)
	return payload
}

func (s *Server) writeStoreError(w http.ResponseWriter, nodeName string, err error) {
	if errors.Is(err, snapshot.ErrNotFound) {
		http.Error(w, "snapshot not found", http.StatusNotFound)
		return
	}
	slog.Error("failed to read snapshot", "node", nodeName, "error", err)
	http.Error(w, fmt.Sprintf("failed to load snapshot: %v", err), http.StatusInternalServerError)
}

func (s *Server) writeSnapshot(w http.ResponseWriter, payload snapshot.LogicalTopologySnapshot, nodeName string) {
	if payload.Metadata.NodeName == "" {
		payload.Metadata.NodeName = nodeName
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if !payload.Metadata.GeneratedAt.IsZero() {
		w.Header().Set(headerSnapshotGeneratedAt, payload.Metadata.GeneratedAt.UTC().Format("2006-01-02T15:04:05Z07:00"))
	}
	if payload.Metadata.SourceHealth != "" {
		w.Header().Set(headerSnapshotSourceHealth, payload.Metadata.SourceHealth)
	}
	if payload.Metadata.NodeName != "" {
		w.Header().Set(headerSnapshotNodeName, payload.Metadata.NodeName)
	}
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		slog.Error("failed to encode snapshot payload", "node", nodeName, "error", err)
		http.Error(w, fmt.Sprintf("failed to encode payload: %v", err), http.StatusInternalServerError)
		return
	}
}
