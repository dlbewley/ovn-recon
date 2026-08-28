package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
)

const snapshotsPrefix = "/api/v1/snapshots/"
const snapshotsAggregatePath = "/api/v1/snapshots"

// aggregateConcurrency bounds parallel zone collection so an aggregate
// request cannot fan out unbounded pod execs.
const aggregateConcurrency = 4
const (
	headerSnapshotGeneratedAt  = "X-OVN-Recon-Snapshot-Generated-At"
	headerSnapshotSourceHealth = "X-OVN-Recon-Snapshot-Source-Health"
	headerSnapshotNodeName     = "X-OVN-Recon-Snapshot-Node-Name"
)

// LiveCollector builds node-scoped snapshots by interrogating OVN at request time.
type LiveCollector interface {
	Collect(ctx context.Context, nodeName string) (snapshot.LogicalTopologySnapshot, error)
}

// NodeLister names the nodes the aggregate endpoint should collect zones for.
type NodeLister interface {
	ListNodes(ctx context.Context) ([]string, error)
}

// SnapshotCache stores zone snapshots between requests.
type SnapshotCache interface {
	Get(nodeName string) (snapshot.LogicalTopologySnapshot, bool)
	Put(nodeName string, payload snapshot.LogicalTopologySnapshot) error
}

// Server wraps HTTP handlers for the OVN collector.
type Server struct {
	store         snapshot.Store
	liveCollector LiveCollector
	nodeLister    NodeLister
	cache         SnapshotCache
	cacheTTL      time.Duration
	now           func() time.Time
	logger        *slog.Logger
}

// New creates a collector HTTP server.
func New(store snapshot.Store) *Server {
	return &Server{
		store:  store,
		now:    time.Now,
		logger: slog.Default(),
	}
}

// NewWithLiveCollector creates a collector HTTP server with live probing enabled.
func NewWithLiveCollector(store snapshot.Store, collector LiveCollector) *Server {
	s := New(store)
	s.liveCollector = collector
	return s
}

// WithNodeLister enables the aggregate endpoint with the given node source.
func (s *Server) WithNodeLister(lister NodeLister) *Server {
	s.nodeLister = lister
	return s
}

// WithCache serves cached zone snapshots while they are within ttl of their
// own generatedAt, recollecting on expiry. The runtime TTL floor applies.
func (s *Server) WithCache(cache SnapshotCache, ttl time.Duration) *Server {
	s.cache = cache
	s.cacheTTL = snapshot.ClampCacheTTL(ttl)
	return s
}

// Handler returns the collector HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/readyz", s.handleReady)
	mux.HandleFunc(snapshotsAggregatePath, s.handleSnapshotsAggregate)
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

	payload, err := s.collectZone(r.Context(), nodeName)
	if err != nil {
		s.writeStoreError(w, nodeName, err)
		return
	}
	s.writeSnapshot(w, payload, nodeName)
}

// collectZone resolves one node's zone snapshot: fresh cache first, then
// live probe (cached on success), then stale cache, then file store — each
// fallback annotated so degraded provenance stays visible.
func (s *Server) collectZone(ctx context.Context, nodeName string) (snapshot.LogicalTopologySnapshot, error) {
	logger := s.logger.With("node", nodeName)

	if s.cache != nil {
		if cached, ok := s.cache.Get(nodeName); ok && snapshot.IsFresh(cached, s.cacheTTL, s.now()) {
			logger.Debug("serving fresh cached snapshot", "generatedAt", cached.Metadata.GeneratedAt)
			return cached, nil
		}
	}

	if s.liveCollector != nil {
		logger.Info("logical topology snapshot requested")
		payload, probeErr := s.liveCollector.Collect(ctx, nodeName)
		if probeErr == nil {
			if s.cache != nil {
				if err := s.cache.Put(nodeName, payload); err != nil {
					logger.Warn("failed to write snapshot cache entry", "error", err)
				}
			}
			return payload, nil
		}

		// A stale cache entry is still real observed data — prefer it over
		// the synthetic fixture fallback.
		if s.cache != nil {
			if cached, ok := s.cache.Get(nodeName); ok {
				logger.Warn("live OVN probe failed; serving stale cached snapshot", "error", probeErr, "generatedAt", cached.Metadata.GeneratedAt)
				cached = appendFallbackWarning(cached, nodeName, probeErr)
				cached = appendWarning(cached, "SNAPSHOT_STALE", fmt.Sprintf(
					"Serving cached snapshot generated at %s; refresh failed", cached.Metadata.GeneratedAt.UTC().Format(time.RFC3339)))
				if cached.Metadata.SourceHealth == "" || cached.Metadata.SourceHealth == "healthy" {
					cached.Metadata.SourceHealth = "degraded"
				}
				return cached, nil
			}
		}

		logger.Warn("live OVN probe failed; falling back to file snapshot", "error", probeErr)
		payload, err := s.store.GetByNode(ctx, nodeName)
		if err != nil {
			return snapshot.LogicalTopologySnapshot{}, err
		}
		payload = appendFallbackWarning(payload, nodeName, probeErr)
		if payload.Metadata.SourceHealth == "" || payload.Metadata.SourceHealth == "healthy" {
			payload.Metadata.SourceHealth = "degraded"
		}
		return payload, nil
	}

	return s.store.GetByNode(ctx, nodeName)
}

func (s *Server) handleSnapshotsAggregate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.nodeLister == nil {
		http.Error(w, "aggregate endpoint is not enabled", http.StatusNotFound)
		return
	}

	nodes, err := s.nodeLister.ListNodes(r.Context())
	if err != nil {
		s.logger.Error("failed to list nodes for aggregate snapshot", "error", err)
		http.Error(w, fmt.Sprintf("failed to list nodes: %v", err), http.StatusInternalServerError)
		return
	}

	type zoneResult struct {
		index   int
		payload snapshot.LogicalTopologySnapshot
		err     error
	}

	results := make([]zoneResult, len(nodes))
	semaphore := make(chan struct{}, aggregateConcurrency)
	var wg sync.WaitGroup
	for index, nodeName := range nodes {
		wg.Add(1)
		go func(index int, nodeName string) {
			defer wg.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()
			payload, zoneErr := s.collectZone(r.Context(), nodeName)
			if payload.Metadata.NodeName == "" {
				payload.Metadata.NodeName = nodeName
			}
			results[index] = zoneResult{index: index, payload: payload, err: zoneErr}
		}(index, nodeName)
	}
	wg.Wait()

	aggregate := snapshot.ClusterLogicalTopology{
		Metadata: snapshot.ClusterMetadata{
			SchemaVersion: snapshot.SchemaVersionV2,
			GeneratedAt:   time.Now().UTC(),
			SourceHealth:  "healthy",
		},
		Snapshots: []snapshot.LogicalTopologySnapshot{},
		Warnings:  []snapshot.Warning{},
	}

	for index, result := range results {
		if result.err != nil {
			aggregate.Warnings = append(aggregate.Warnings, snapshot.Warning{
				Code:    "ZONE_COLLECTION_FAILED",
				Message: fmt.Sprintf("zone collection failed for node %s: %v", nodes[index], result.err),
			})
			aggregate.Metadata.SourceHealth = "degraded"
			continue
		}
		if result.payload.Metadata.SourceHealth != "" && result.payload.Metadata.SourceHealth != "healthy" {
			aggregate.Metadata.SourceHealth = "degraded"
		}
		aggregate.Snapshots = append(aggregate.Snapshots, result.payload)
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set(headerSnapshotSourceHealth, aggregate.Metadata.SourceHealth)
	if err := json.NewEncoder(w).Encode(aggregate); err != nil {
		s.logger.Error("failed to encode aggregate payload", "error", err)
		http.Error(w, fmt.Sprintf("failed to encode payload: %v", err), http.StatusInternalServerError)
	}
}

func appendFallbackWarning(payload snapshot.LogicalTopologySnapshot, nodeName string, probeErr error) snapshot.LogicalTopologySnapshot {
	return appendWarning(payload, "LIVE_PROBE_FAILED", fmt.Sprintf("Live probe collection failed for node %s: %v", nodeName, probeErr))
}

func appendWarning(payload snapshot.LogicalTopologySnapshot, code, message string) snapshot.LogicalTopologySnapshot {
	for _, existing := range payload.Warnings {
		if existing.Code == code && existing.Message == message {
			return payload
		}
	}
	payload.Warnings = append(payload.Warnings, snapshot.Warning{Code: code, Message: message})
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
