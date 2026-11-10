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

// sectionsPrefix roots the path spelling of the include parameter:
// /api/v1/sections/<section>[,<section>]/snapshots[/<node>].
const sectionsPrefix = "/api/v1/sections/"

// includeParam selects the optional sections a snapshot response carries.
const includeParam = "include"

const sectionsPathUsage = "expected /api/v1/sections/<section>[,<section>]/snapshots[/<node>]"

// lookupPrefix roots the address and name lookup:
// /api/v1/lookup/<kind>/<value>. Like the sections route, every argument is
// in the path, because the console drops query strings (ovn-recon-e2b.12).
const lookupPrefix = "/api/v1/lookup/"

const lookupPathUsage = "expected /api/v1/lookup/<ip|mac|cidr|name>/<value>"

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

// SnapshotCache stores zone snapshots between requests. Get returns only
// entries written by the running collector build; GetAnyBuild also returns
// entries left by another build, which may lack data this build collects.
type SnapshotCache interface {
	Get(nodeName string) (snapshot.LogicalTopologySnapshot, bool)
	GetAnyBuild(nodeName string) (snapshot.LogicalTopologySnapshot, bool)
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

	// refreshMu guards single-flight background revalidation per node.
	refreshMu       sync.Mutex
	refreshInFlight map[string]bool
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
	mux.Handle(snapshotsAggregatePath, withGzip(http.HandlerFunc(s.handleSnapshotsAggregate)))
	mux.Handle(snapshotsPrefix, withGzip(http.HandlerFunc(s.handleSnapshotByNode)))
	mux.Handle(sectionsPrefix, withGzip(http.HandlerFunc(s.handleSectionsPath)))
	mux.Handle(lookupPrefix, withGzip(http.HandlerFunc(s.handleLookup)))
	return mux
}

// handleSectionsPath serves the path spelling of ?include=:
//
//	/api/v1/sections/<a>[,<b>]/snapshots           the aggregate
//	/api/v1/sections/<a>[,<b>]/snapshots/<node>    one node
//
// It exists because the OpenShift console's plugin asset handler, the only
// route from the plugin to this service on a default install, forwards a
// request's path and drops its query string, so ?include= never arrives
// there (ovn-recon-e2b.12). The path is rewritten onto the query form and
// served by the same handlers, so the two spellings cannot drift apart; a
// request that uses both gets the union.
func (s *Server) handleSectionsPath(w http.ResponseWriter, r *http.Request) {
	list, rest, found := strings.Cut(strings.TrimPrefix(r.URL.Path, sectionsPrefix), "/")
	if !found || strings.TrimSpace(list) == "" {
		http.Error(w, sectionsPathUsage, http.StatusNotFound)
		return
	}

	target := *r.URL
	query := target.Query()
	query.Add(includeParam, list)
	target.RawQuery = query.Encode()
	target.Path = "/api/v1/" + rest
	target.RawPath = ""
	rewritten := r.Clone(r.Context())
	rewritten.URL = &target

	switch {
	case target.Path == snapshotsAggregatePath:
		s.handleSnapshotsAggregate(w, rewritten)
	case strings.HasPrefix(target.Path, snapshotsPrefix):
		s.handleSnapshotByNode(w, rewritten)
	default:
		http.Error(w, sectionsPathUsage, http.StatusNotFound)
	}
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
	sections, ok := requestedSections(w, r)
	if !ok {
		return
	}

	payload, err := s.collectZone(r.Context(), nodeName)
	if err != nil {
		s.writeStoreError(w, nodeName, err)
		return
	}
	s.writeSnapshot(w, snapshot.Project(payload, sections), nodeName)
}

// requestedSections reads ?include= (which handleSectionsPath also fills
// from the path spelling) and answers 400 itself, naming the valid
// sections, when a name is unknown. collectZone always resolves the full
// snapshot (one collect, one cache entry per node); the sections only decide
// what a response carries, so asking for more never triggers a recollect.
func requestedSections(w http.ResponseWriter, r *http.Request) (snapshot.SectionSet, bool) {
	sections, err := snapshot.ParseSections(r.URL.Query()[includeParam])
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return nil, false
	}
	return sections, true
}

// collectZone resolves one node's zone snapshot: fresh cache first; a stale
// entry is served immediately while a single-flight background refresh
// revalidates it (staleness stays bounded near the TTL while anyone is
// watching, and nothing runs when nobody is); a missing entry falls through
// to a synchronous live probe (cached on success), then stale cache, then
// file store — each fallback annotated so degraded provenance stays visible.
//
// An entry written by another collector build counts as missing however
// young it is: it may lack tables this build collects, so it is recollected
// synchronously rather than served, and only used if that collection fails.
func (s *Server) collectZone(ctx context.Context, nodeName string) (snapshot.LogicalTopologySnapshot, error) {
	logger := s.logger.With("node", nodeName)

	if s.cache != nil {
		if cached, ok := s.cache.Get(nodeName); ok {
			if snapshot.IsFresh(cached, s.cacheTTL, s.now()) {
				logger.Debug("serving fresh cached snapshot", "generatedAt", cached.Metadata.GeneratedAt)
				return cached, nil
			}
			if s.liveCollector != nil {
				logger.Debug("serving stale cached snapshot; revalidating in background", "generatedAt", cached.Metadata.GeneratedAt)
				s.refreshZoneAsync(nodeName)
				return cached, nil
			}
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
		// the synthetic fixture fallback, even one another build wrote.
		if s.cache != nil {
			if cached, ok := s.cache.GetAnyBuild(nodeName); ok {
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

// refreshZoneAsync revalidates one node's cache entry in the background,
// deduplicating concurrent triggers. Runs detached from the request context.
func (s *Server) refreshZoneAsync(nodeName string) {
	s.refreshMu.Lock()
	if s.refreshInFlight == nil {
		s.refreshInFlight = map[string]bool{}
	}
	if s.refreshInFlight[nodeName] {
		s.refreshMu.Unlock()
		return
	}
	s.refreshInFlight[nodeName] = true
	s.refreshMu.Unlock()

	go func() {
		defer func() {
			s.refreshMu.Lock()
			delete(s.refreshInFlight, nodeName)
			s.refreshMu.Unlock()
		}()

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()

		payload, err := s.liveCollector.Collect(ctx, nodeName)
		if err != nil {
			s.logger.Warn("background cache revalidation failed", "node", nodeName, "error", err)
			return
		}
		if err := s.cache.Put(nodeName, payload); err != nil {
			s.logger.Warn("failed to write revalidated cache entry", "node", nodeName, "error", err)
		}
	}()
}

// WarmCache collects zones whose cache entries are missing, stale, or
// written by another collector build, so the first request after startup
// serves warm. A PVC-backed cache with fresh entries from this build makes
// this a no-op; there is no recurring refresh cycle — after startup,
// revalidation only happens on request (stale-while-revalidate).
func (s *Server) WarmCache(ctx context.Context) {
	if s.cache == nil || s.liveCollector == nil || s.nodeLister == nil {
		return
	}

	nodes, err := s.nodeLister.ListNodes(ctx)
	if err != nil {
		s.logger.Warn("cache warm-up skipped; node discovery failed", "error", err)
		return
	}

	warmed := 0
	semaphore := make(chan struct{}, aggregateConcurrency)
	var wg sync.WaitGroup
	for _, nodeName := range nodes {
		if cached, ok := s.cache.Get(nodeName); ok && snapshot.IsFresh(cached, s.cacheTTL, s.now()) {
			continue
		}
		warmed++
		wg.Add(1)
		go func(nodeName string) {
			defer wg.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()
			payload, err := s.liveCollector.Collect(ctx, nodeName)
			if err != nil {
				s.logger.Warn("cache warm-up collection failed", "node", nodeName, "error", err)
				return
			}
			if err := s.cache.Put(nodeName, payload); err != nil {
				s.logger.Warn("cache warm-up write failed", "node", nodeName, "error", err)
			}
		}(nodeName)
	}
	wg.Wait()
	s.logger.Info("cache warm-up complete", "nodes", len(nodes), "collected", warmed)
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
	sections, ok := requestedSections(w, r)
	if !ok {
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
		aggregate.Snapshots = append(aggregate.Snapshots, snapshot.Project(result.payload, sections))
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
