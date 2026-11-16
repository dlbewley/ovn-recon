package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
)

// ovsPrefix roots the host OVS routes: /api/v1/ovs/bonds/<node>
// (ovn-recon-1tw.7). Like every other route, all arguments are in the path.
const ovsPrefix = "/api/v1/ovs/"

const ovsBondsPathUsage = "expected /api/v1/ovs/bonds/<node>"

// ovsBondsProbeTimeout caps one bond/show exec. The request context still
// applies; this keeps a wedged exec from holding a drawer's request for as
// long as the client is willing to wait.
const ovsBondsProbeTimeout = 20 * time.Second

// ovsBondsMemoTTL absorbs the double request a cold console load makes (the
// console mounts the page twice). Bond state is runtime state, so nothing
// is kept longer and nothing but a live answer is kept at all.
const ovsBondsMemoTTL = 3 * time.Second

// OVSBondCollector reads one node's OVS bonds live.
type OVSBondCollector interface {
	CollectOVSBonds(ctx context.Context, nodeName string) ([]snapshot.OVSBond, error)
}

// OVSBondFixtures holds per-node OVS bonds responses for the fallback.
type OVSBondFixtures interface {
	GetByNode(nodeName string) (snapshot.OVSBondsResponse, error)
}

var errUnknownNode = errors.New("unknown node")

type ovsBondsMemo struct {
	mu      sync.Mutex
	entries map[string]snapshot.OVSBondsResponse
}

// WithOVSBonds enables GET /api/v1/ovs/bonds/<node>. A nil collector serves
// the fixtures only, as the snapshot endpoints do without a cluster.
func (s *Server) WithOVSBonds(collector OVSBondCollector, fixtures OVSBondFixtures) *Server {
	s.ovsBondCollector = collector
	s.ovsBondFixtures = fixtures
	return s
}

// handleOVSBonds serves GET /api/v1/ovs/bonds/<node>: the runtime state of
// the bonds inside the node's OVS bridges, read with `ovs-appctl bond/show`
// in its ovnkube-node pod (ovn-recon-1tw.7).
func (s *Server) handleOVSBonds(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	resource, nodeName, found := strings.Cut(strings.TrimPrefix(r.URL.Path, ovsPrefix), "/")
	nodeName = strings.TrimSpace(nodeName)
	if !found || resource != "bonds" || nodeName == "" || strings.Contains(nodeName, "/") {
		http.Error(w, ovsBondsPathUsage, http.StatusNotFound)
		return
	}

	payload, err := s.resolveOVSBonds(r.Context(), nodeName)
	if err != nil {
		if errors.Is(err, errUnknownNode) {
			http.Error(w, fmt.Sprintf("node %q not found; %s", nodeName, ovsBondsPathUsage), http.StatusNotFound)
			return
		}
		s.logger.Error("failed to resolve OVS bonds", "node", nodeName, "error", err)
		http.Error(w, fmt.Sprintf("failed to load OVS bonds: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set(headerSnapshotSourceHealth, payload.Metadata.SourceHealth)
	w.Header().Set(headerSnapshotNodeName, payload.Metadata.NodeName)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		s.logger.Error("failed to encode OVS bonds payload", "node", nodeName, "error", err)
		http.Error(w, fmt.Sprintf("failed to encode payload: %v", err), http.StatusInternalServerError)
	}
}

// resolveOVSBonds answers for one node. With live probing: a recent live
// answer, else one bond/show exec; when that fails, the node's fixture or
// an empty list, marked LIVE_PROBE_FAILED and degraded the way a zone
// snapshot served from a fixture is. Without live probing: the fixture, or
// an empty list for a node the collector knows.
func (s *Server) resolveOVSBonds(ctx context.Context, nodeName string) (snapshot.OVSBondsResponse, error) {
	if memo, ok := s.ovsBondsMemoGet(nodeName); ok {
		return memo, nil
	}

	fixture, fixtureErr := s.ovsBondFixture(nodeName)
	if fixtureErr != nil && !errors.Is(fixtureErr, snapshot.ErrNotFound) {
		return snapshot.OVSBondsResponse{}, fixtureErr
	}
	hasFixture := fixtureErr == nil
	if !hasFixture && !s.nodeMayExist(ctx, nodeName) {
		return snapshot.OVSBondsResponse{}, errUnknownNode
	}

	if s.ovsBondCollector == nil {
		if hasFixture {
			return fixture, nil
		}
		return s.emptyOVSBonds(nodeName), nil
	}

	probeCtx, cancel := context.WithTimeout(ctx, ovsBondsProbeTimeout)
	defer cancel()
	bonds, probeErr := s.ovsBondCollector.CollectOVSBonds(probeCtx, nodeName)
	if probeErr == nil {
		payload := s.emptyOVSBonds(nodeName)
		if bonds != nil {
			payload.Bonds = bonds
		}
		s.ovsBondsMemoPut(nodeName, payload)
		return payload, nil
	}

	s.logger.Warn("live OVS bond probe failed; falling back", "node", nodeName, "fixture", hasFixture, "error", probeErr)
	payload := s.emptyOVSBonds(nodeName)
	if hasFixture {
		payload = fixture
	}
	payload.Warnings = append(slices.Clone(payload.Warnings), snapshot.Warning{
		Code:    "LIVE_PROBE_FAILED",
		Message: fmt.Sprintf("Live probe collection failed for node %s: %v", nodeName, probeErr),
	})
	payload.Metadata.SourceHealth = "degraded"
	return payload, nil
}

func (s *Server) ovsBondFixture(nodeName string) (snapshot.OVSBondsResponse, error) {
	if s.ovsBondFixtures == nil {
		return snapshot.OVSBondsResponse{}, snapshot.ErrNotFound
	}
	payload, err := s.ovsBondFixtures.GetByNode(nodeName)
	if err != nil {
		return snapshot.OVSBondsResponse{}, err
	}
	payload.Metadata.NodeName = nodeName
	if payload.Metadata.SchemaVersion == "" {
		payload.Metadata.SchemaVersion = snapshot.OVSBondsSchemaVersion
	}
	if payload.Metadata.SourceHealth == "" {
		payload.Metadata.SourceHealth = snapshot.OVSBondsSourceHealthy
	}
	return payload, nil
}

// nodeMayExist is false only when the node lister answers and does not name
// the node. Without a lister, or when it fails, the collector cannot tell,
// so the probe (or the empty answer) decides.
func (s *Server) nodeMayExist(ctx context.Context, nodeName string) bool {
	if s.nodeLister == nil {
		return true
	}
	nodes, err := s.nodeLister.ListNodes(ctx)
	if err != nil {
		s.logger.Warn("node discovery failed; not checking the OVS bonds node name", "node", nodeName, "error", err)
		return true
	}
	return slices.Contains(nodes, nodeName)
}

func (s *Server) emptyOVSBonds(nodeName string) snapshot.OVSBondsResponse {
	return snapshot.OVSBondsResponse{
		Metadata: snapshot.Metadata{
			SchemaVersion: snapshot.OVSBondsSchemaVersion,
			GeneratedAt:   s.now().UTC(),
			SourceHealth:  snapshot.OVSBondsSourceHealthy,
			NodeName:      nodeName,
		},
		Warnings: []snapshot.Warning{},
		Bonds:    []snapshot.OVSBond{},
	}
}

func (s *Server) ovsBondsMemoGet(nodeName string) (snapshot.OVSBondsResponse, bool) {
	s.ovsBonds.mu.Lock()
	defer s.ovsBonds.mu.Unlock()
	payload, ok := s.ovsBonds.entries[nodeName]
	if !ok {
		return snapshot.OVSBondsResponse{}, false
	}
	if s.now().Sub(payload.Metadata.GeneratedAt) >= ovsBondsMemoTTL {
		delete(s.ovsBonds.entries, nodeName)
		return snapshot.OVSBondsResponse{}, false
	}
	return payload, true
}

func (s *Server) ovsBondsMemoPut(nodeName string, payload snapshot.OVSBondsResponse) {
	s.ovsBonds.mu.Lock()
	defer s.ovsBonds.mu.Unlock()
	if s.ovsBonds.entries == nil {
		s.ovsBonds.entries = map[string]snapshot.OVSBondsResponse{}
	}
	s.ovsBonds.entries[nodeName] = payload
}
