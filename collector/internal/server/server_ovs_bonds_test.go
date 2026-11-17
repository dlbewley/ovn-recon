package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
)

const ovsBondsFixtureDir = "../../fixtures/ovs-bonds"

type fakeBondCollector struct {
	bonds []snapshot.OVSBond
	err   error
	calls int
	nodes []string
	ctx   context.Context
}

func (f *fakeBondCollector) CollectOVSBonds(ctx context.Context, nodeName string) ([]snapshot.OVSBond, error) {
	f.calls++
	f.nodes = append(f.nodes, nodeName)
	f.ctx = ctx
	return f.bonds, f.err
}

func liveBond() snapshot.OVSBond {
	return snapshot.OVSBond{
		Name:         "bond1",
		Mode:         "balance-slb",
		ActiveMember: &snapshot.OVSBondActiveMember{Name: "ens161", MAC: "00:50:56:b4:1b:27"},
		Members: []snapshot.OVSBondMember{
			{Name: "ens161", Enabled: true, Active: true, MayEnable: true},
			{Name: "ens256", Enabled: true, MayEnable: true},
		},
	}
}

func newBondsServer(collector OVSBondCollector, nodes []string) *Server {
	s := New(snapshot.NewFileStore(filepath.Join("..", "..", "fixtures", "snapshots"), "default.json"))
	if collector != nil {
		s = NewWithLiveCollector(s.store, &fakeLiveCollector{})
	}
	s = s.WithOVSBonds(collector, snapshot.NewOVSBondFixtures(ovsBondsFixtureDir))
	if nodes != nil {
		s = s.WithNodeLister(fakeLister{nodes: nodes})
	}
	return s
}

func getBonds(t *testing.T, s *Server, path string) (*httptest.ResponseRecorder, snapshot.OVSBondsResponse) {
	t.Helper()
	rr := httptest.NewRecorder()
	s.Handler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, path, nil))
	var payload snapshot.OVSBondsResponse
	if rr.Code == http.StatusOK {
		if err := json.Unmarshal(rr.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode %s: %v (%s)", path, err, rr.Body.String())
		}
	}
	return rr, payload
}

func TestOVSBondsLiveAnswer(t *testing.T) {
	collector := &fakeBondCollector{bonds: []snapshot.OVSBond{liveBond()}}
	s := newBondsServer(collector, []string{"worker-1"})
	now := time.Date(2026, 11, 16, 20, 15, 0, 0, time.UTC)
	s.now = func() time.Time { return now }

	rr, payload := getBonds(t, s, "/api/v1/ovs/bonds/worker-1")
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	if got := rr.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control %q", got)
	}
	if got := rr.Header().Get(headerSnapshotSourceHealth); got != "healthy" {
		t.Fatalf("source health header %q", got)
	}
	want := snapshot.Metadata{SchemaVersion: "v1alpha1", GeneratedAt: now, SourceHealth: "healthy", NodeName: "worker-1"}
	if payload.Metadata != want {
		t.Fatalf("metadata %+v, want %+v", payload.Metadata, want)
	}
	if len(payload.Warnings) != 0 || len(payload.Bonds) != 1 || payload.Bonds[0].Name != "bond1" {
		t.Fatalf("unexpected payload %+v", payload)
	}
	if collector.nodes[0] != "worker-1" {
		t.Fatalf("collected for %v", collector.nodes)
	}
	if deadline, ok := collector.ctx.Deadline(); !ok || time.Until(deadline) > ovsBondsProbeTimeout {
		t.Fatalf("the probe should run under the bond probe timeout, deadline %v (set %v)", deadline, ok)
	}

	// The JSON carries warnings and bonds as arrays, never null.
	raw := rr.Body.String()
	if !strings.Contains(raw, `"warnings":[]`) {
		t.Fatalf("warnings should encode as []: %s", raw)
	}
}

func TestOVSBondsNodeWithoutBondsIsAnEmptyList(t *testing.T) {
	s := newBondsServer(&fakeBondCollector{bonds: nil}, []string{"worker-2"})
	rr, payload := getBonds(t, s, "/api/v1/ovs/bonds/worker-2")
	if rr.Code != http.StatusOK || payload.Metadata.SourceHealth != "healthy" {
		t.Fatalf("expected 200 ok, got %d %+v", rr.Code, payload.Metadata)
	}
	if !strings.Contains(rr.Body.String(), `"bonds":[]`) {
		t.Fatalf("bonds should encode as []: %s", rr.Body.String())
	}
}

func TestOVSBondsProbeFailureServesFixtureDegraded(t *testing.T) {
	collector := &fakeBondCollector{err: errors.New("ovs-vswitchd not reachable")}
	s := newBondsServer(collector, []string{"cnv-1", "cnv-9"})

	rr, payload := getBonds(t, s, "/api/v1/ovs/bonds/cnv-1")
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	if payload.Metadata.SourceHealth != "degraded" || rr.Header().Get(headerSnapshotSourceHealth) != "degraded" {
		t.Fatalf("fallback should be degraded, got %+v", payload.Metadata)
	}
	if len(payload.Bonds) != 1 || payload.Bonds[0].Name != "bond1" {
		t.Fatalf("expected the cnv-1 fixture's bond1, got %+v", payload.Bonds)
	}
	if len(payload.Warnings) != 1 || payload.Warnings[0].Code != "LIVE_PROBE_FAILED" || !strings.Contains(payload.Warnings[0].Message, "cnv-1") {
		t.Fatalf("expected one LIVE_PROBE_FAILED warning naming the node, got %+v", payload.Warnings)
	}

	// No fixture: an empty list, still degraded and still warned.
	rr, payload = getBonds(t, s, "/api/v1/ovs/bonds/cnv-9")
	if rr.Code != http.StatusOK || payload.Metadata.SourceHealth != "degraded" || len(payload.Bonds) != 0 || payload.Metadata.NodeName != "cnv-9" {
		t.Fatalf("expected an empty degraded answer for cnv-9, got %d %+v", rr.Code, payload)
	}
	if len(payload.Warnings) != 1 || payload.Warnings[0].Code != "LIVE_PROBE_FAILED" {
		t.Fatalf("expected LIVE_PROBE_FAILED, got %+v", payload.Warnings)
	}

	// A failure is never memoised: the next request probes again.
	getBonds(t, s, "/api/v1/ovs/bonds/cnv-1")
	if collector.calls != 3 {
		t.Fatalf("expected a probe per failed request, got %d", collector.calls)
	}
}

func TestOVSBondsMemoAbsorbsARepeatThenExpires(t *testing.T) {
	collector := &fakeBondCollector{bonds: []snapshot.OVSBond{liveBond()}}
	s := newBondsServer(collector, []string{"worker-1", "worker-2"})
	now := time.Date(2026, 11, 16, 20, 15, 0, 0, time.UTC)
	s.now = func() time.Time { return now }

	getBonds(t, s, "/api/v1/ovs/bonds/worker-1")
	now = now.Add(ovsBondsMemoTTL - time.Millisecond)
	_, payload := getBonds(t, s, "/api/v1/ovs/bonds/worker-1")
	if collector.calls != 1 {
		t.Fatalf("a repeat within %v should be served from the memo, got %d probes", ovsBondsMemoTTL, collector.calls)
	}
	if payload.Metadata.GeneratedAt.Equal(now) {
		t.Fatalf("a memoised answer keeps its own generatedAt")
	}

	getBonds(t, s, "/api/v1/ovs/bonds/worker-2")
	if collector.calls != 2 {
		t.Fatalf("the memo is per node, got %d probes", collector.calls)
	}

	now = now.Add(time.Millisecond)
	getBonds(t, s, "/api/v1/ovs/bonds/worker-1")
	if collector.calls != 3 {
		t.Fatalf("the memo should expire after %v, got %d probes", ovsBondsMemoTTL, collector.calls)
	}
}

func TestOVSBondsFixtureModeWithoutACluster(t *testing.T) {
	s := newBondsServer(nil, []string{"cnv-1", "cnv-2"})

	rr, payload := getBonds(t, s, "/api/v1/ovs/bonds/cnv-1")
	if rr.Code != http.StatusOK || payload.Metadata.SourceHealth != "healthy" || len(payload.Bonds) != 1 || len(payload.Warnings) != 0 {
		t.Fatalf("fixture mode should serve the fixture as it is, got %d %+v", rr.Code, payload)
	}

	// A node the lister knows that has no fixture: an empty, healthy list.
	s = newBondsServer(nil, []string{"cnv-1", "worker-7"})
	rr, payload = getBonds(t, s, "/api/v1/ovs/bonds/worker-7")
	if rr.Code != http.StatusOK || payload.Metadata.SourceHealth != "healthy" || len(payload.Bonds) != 0 || payload.Metadata.NodeName != "worker-7" {
		t.Fatalf("a known node without a fixture should be an empty list, got %d %+v", rr.Code, payload)
	}
}

func TestOVSBondsUnknownNodeAndBadPaths(t *testing.T) {
	collector := &fakeBondCollector{bonds: []snapshot.OVSBond{liveBond()}}
	s := newBondsServer(collector, []string{"worker-1"})

	for _, path := range []string{
		"/api/v1/ovs/bonds/",
		"/api/v1/ovs/bonds",
		"/api/v1/ovs/",
		"/api/v1/ovs/bridges/worker-1",
		"/api/v1/ovs/bonds/worker-1/extra",
		"/api/v1/ovs/bonds/%20",
	} {
		rr, _ := getBonds(t, s, path)
		if rr.Code != http.StatusNotFound || !strings.Contains(rr.Body.String(), ovsBondsPathUsage) {
			t.Errorf("%s: expected 404 with the usage line, got %d %q", path, rr.Code, rr.Body.String())
		}
	}

	rr, _ := getBonds(t, s, "/api/v1/ovs/bonds/nobody")
	if rr.Code != http.StatusNotFound || !strings.Contains(rr.Body.String(), "nobody") || !strings.Contains(rr.Body.String(), ovsBondsPathUsage) {
		t.Fatalf("an unknown node should be a 404 naming it, got %d %q", rr.Code, rr.Body.String())
	}
	if collector.calls != 0 {
		t.Fatalf("an unknown node or bad path must not probe, got %d", collector.calls)
	}

	// A node with a fixture is known even when the lister misses it, and a
	// failing lister cannot rule a node out.
	if rr, _ := getBonds(t, s, "/api/v1/ovs/bonds/cnv-1"); rr.Code != http.StatusOK {
		t.Fatalf("a fixture node should answer, got %d", rr.Code)
	}
	s = s.WithNodeLister(fakeLister{err: errors.New("api down")})
	if rr, _ := getBonds(t, s, "/api/v1/ovs/bonds/somebody"); rr.Code != http.StatusOK {
		t.Fatalf("a failing lister should let the probe decide, got %d", rr.Code)
	}

	rr = httptest.NewRecorder()
	s.Handler().ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/api/v1/ovs/bonds/worker-1", nil))
	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST should be 405, got %d", rr.Code)
	}
}

func TestOVSBondsResponseIsGzipped(t *testing.T) {
	s := newBondsServer(&fakeBondCollector{bonds: []snapshot.OVSBond{liveBond()}}, []string{"worker-1"})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/ovs/bonds/worker-1", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rr := httptest.NewRecorder()
	s.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK || rr.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("expected a gzipped 200, got %d %q", rr.Code, rr.Header().Get("Content-Encoding"))
	}
	reader, err := gzip.NewReader(bytes.NewReader(rr.Body.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	var payload snapshot.OVSBondsResponse
	if err := json.Unmarshal(body, &payload); err != nil || len(payload.Bonds) != 1 {
		t.Fatalf("decode gzipped body: %v %+v", err, payload)
	}
}
