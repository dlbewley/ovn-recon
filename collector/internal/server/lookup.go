package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
)

const (
	// warningZoneNotCached marks a node the lookup could not search because
	// no snapshot of its zone is stored.
	warningZoneNotCached = "ZONE_NOT_CACHED"
	// warningLookupCacheDisabled marks a live collector running without a
	// snapshot cache: there is nothing a lookup may read.
	warningLookupCacheDisabled = "LOOKUP_CACHE_DISABLED"
)

// handleLookup serves GET /api/v1/lookup/<kind>/<value>: where an address
// or a name is, across every zone snapshot already stored (ovn-recon-tpp.1).
//
// The value is everything after the kind segment, not one segment. A CIDR's
// slash arrives encoded (%2F) from a direct client and literal through the
// OpenShift console, whose plugin asset handler rebuilds the upstream URL
// from the decoded path; both spell the same request here.
//
// A lookup reads stored snapshots only. It never collects, and unlike a
// snapshot request it never starts a background revalidation, so it costs
// the cluster nothing however often it is called; each hit says how old its
// zone's snapshot is.
func (s *Server) handleLookup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	kind, value, found := strings.Cut(strings.TrimPrefix(r.URL.Path, lookupPrefix), "/")
	if !found {
		http.Error(w, lookupPathUsage, http.StatusBadRequest)
		return
	}
	query, err := snapshot.ParseLookupQuery(kind, value)
	if err != nil {
		http.Error(w, fmt.Sprintf("%v; %s", err, lookupPathUsage), http.StatusBadRequest)
		return
	}
	if s.nodeLister == nil {
		http.Error(w, "lookup endpoint is not enabled", http.StatusNotFound)
		return
	}

	started := time.Now()
	nodes, err := s.nodeLister.ListNodes(r.Context())
	if err != nil {
		s.logger.Error("failed to list nodes for lookup", "error", err)
		http.Error(w, fmt.Sprintf("failed to list nodes: %v", err), http.StatusInternalServerError)
		return
	}

	search := snapshot.NewLookupSearch(query)
	warnings := s.searchStoredZones(r.Context(), nodes, search)
	response := search.Response(snapshot.DefaultLookupLimit)
	response.Warnings = append(response.Warnings, warnings...)

	s.logger.Debug("lookup served",
		"kind", query.Kind,
		"zones", len(response.Zones),
		"hits", response.Total,
		"truncated", response.Truncated,
		"duration", time.Since(started).String(),
	)

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		s.logger.Error("failed to encode lookup payload", "error", err)
		http.Error(w, fmt.Sprintf("failed to encode payload: %v", err), http.StatusInternalServerError)
	}
}

// searchStoredZones feeds each node's stored snapshot to the search and
// returns a warning for every node it could not search, in node order.
//
// Snapshots are read a few at a time and dropped as soon as they are
// searched: a cache entry is a megabyte or more of JSON, and a lookup over a
// large cluster must not hold them all at once.
func (s *Server) searchStoredZones(ctx context.Context, nodes []string, search *snapshot.LookupSearch) []snapshot.Warning {
	if s.liveCollector != nil && s.cache == nil {
		return []snapshot.Warning{{
			Code:    warningLookupCacheDisabled,
			Message: "the snapshot cache is not enabled, so there are no stored snapshots to search",
		}}
	}

	missing := make([]string, len(nodes))
	semaphore := make(chan struct{}, aggregateConcurrency)
	var searchMu sync.Mutex
	var wg sync.WaitGroup
	for index, nodeName := range nodes {
		wg.Add(1)
		go func(index int, nodeName string) {
			defer wg.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()

			payload, reason := s.storedZone(ctx, nodeName)
			if reason != "" {
				missing[index] = reason
				return
			}
			if payload.Metadata.NodeName == "" {
				payload.Metadata.NodeName = nodeName
			}
			searchMu.Lock()
			defer searchMu.Unlock()
			search.AddZone(payload)
		}(index, nodeName)
	}
	wg.Wait()

	warnings := []snapshot.Warning{}
	for index, reason := range missing {
		if reason == "" {
			continue
		}
		warnings = append(warnings, snapshot.Warning{
			Code:    warningZoneNotCached,
			Message: fmt.Sprintf("zone of node %s was not searched: %s", nodes[index], reason),
		})
	}
	return warnings
}

// storedZone returns the snapshot a lookup may read for a node, or the
// reason there is none.
//
// With live probing, that is the node's cache entry and nothing else: an
// entry another collector build wrote is still observed data and is
// searched, while the fixture store is not, because a fixture's addresses
// presented as an answer about a live cluster would be wrong, not merely
// stale. Without live probing the collector serves the fixture store, and
// the lookup searches the same files.
func (s *Server) storedZone(ctx context.Context, nodeName string) (snapshot.LogicalTopologySnapshot, string) {
	if s.liveCollector != nil {
		cached, ok := s.cache.GetAnyBuild(nodeName)
		if !ok {
			return snapshot.LogicalTopologySnapshot{}, "no cached snapshot yet"
		}
		return cached, ""
	}

	payload, err := s.store.GetByNode(ctx, nodeName)
	if err != nil {
		return snapshot.LogicalTopologySnapshot{}, err.Error()
	}
	return payload, ""
}
