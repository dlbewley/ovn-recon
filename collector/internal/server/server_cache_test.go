package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
)

type countingCollector struct {
	calls   int
	fail    bool
	payload snapshot.LogicalTopologySnapshot
}

func (c *countingCollector) Collect(_ context.Context, nodeName string) (snapshot.LogicalTopologySnapshot, error) {
	c.calls++
	if c.fail {
		return snapshot.LogicalTopologySnapshot{}, errors.New("probe exploded")
	}
	payload := c.payload
	payload.Metadata.NodeName = nodeName
	return payload, nil
}

func newCachedServer(t *testing.T, collector *countingCollector, ttl time.Duration, now time.Time) (*Server, *snapshot.DiskCache) {
	t.Helper()
	cache, err := snapshot.NewDiskCache(t.TempDir())
	if err != nil {
		t.Fatalf("create cache: %v", err)
	}
	store := snapshot.NewFileStore(t.TempDir(), "")
	srv := NewWithLiveCollector(store, collector).WithCache(cache, ttl)
	srv.now = func() time.Time { return now }
	return srv, cache
}

func fetchNode(t *testing.T, srv *Server, node string) snapshot.LogicalTopologySnapshot {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/snapshots/"+node, nil)
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var payload snapshot.LogicalTopologySnapshot
	if err := json.Unmarshal(rr.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	return payload
}

func TestCacheServesFreshSnapshotWithoutRecollecting(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	collector := &countingCollector{payload: zoneSnapshot("")}
	collector.payload.Metadata.GeneratedAt = now
	srv, _ := newCachedServer(t, collector, 2*time.Minute, now)

	first := fetchNode(t, srv, "worker-a")
	second := fetchNode(t, srv, "worker-a")

	if collector.calls != 1 {
		t.Fatalf("expected one live collection, got %d", collector.calls)
	}
	if !second.Metadata.GeneratedAt.Equal(first.Metadata.GeneratedAt) {
		t.Fatalf("expected cached snapshot on second request")
	}
	if len(second.Warnings) != 0 {
		t.Fatalf("fresh cache hit must not carry warnings: %#v", second.Warnings)
	}
}

func TestCacheRecollectsWhenStale(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	collector := &countingCollector{payload: zoneSnapshot("")}
	collector.payload.Metadata.GeneratedAt = now.Add(-10 * time.Minute)
	srv, cache := newCachedServer(t, collector, 2*time.Minute, now)

	stale := zoneSnapshot("worker-a")
	stale.Metadata.GeneratedAt = now.Add(-time.Hour)
	if err := cache.Put("worker-a", stale); err != nil {
		t.Fatalf("seed stale cache: %v", err)
	}

	fetchNode(t, srv, "worker-a")
	if collector.calls != 1 {
		t.Fatalf("expected stale cache to trigger recollection, got %d calls", collector.calls)
	}
}

func TestCacheServesStaleEntryWhenProbeFails(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	collector := &countingCollector{fail: true}
	srv, cache := newCachedServer(t, collector, 2*time.Minute, now)

	stale := zoneSnapshot("worker-a")
	stale.Metadata.GeneratedAt = now.Add(-time.Hour)
	if err := cache.Put("worker-a", stale); err != nil {
		t.Fatalf("seed stale cache: %v", err)
	}

	payload := fetchNode(t, srv, "worker-a")
	if payload.Metadata.SourceHealth != "degraded" {
		t.Fatalf("expected degraded health, got %q", payload.Metadata.SourceHealth)
	}
	codes := map[string]bool{}
	for _, warning := range payload.Warnings {
		codes[warning.Code] = true
	}
	if !codes["LIVE_PROBE_FAILED"] || !codes["SNAPSHOT_STALE"] {
		t.Fatalf("expected LIVE_PROBE_FAILED and SNAPSHOT_STALE warnings, got %#v", payload.Warnings)
	}
	if payload.Database == nil {
		t.Fatal("expected cached database payload")
	}
}

func TestWithCacheClampsTTLToFloor(t *testing.T) {
	collector := &countingCollector{payload: zoneSnapshot("")}
	srv, _ := newCachedServer(t, collector, time.Second, time.Now())
	if srv.cacheTTL != snapshot.MinCacheTTL {
		t.Fatalf("expected TTL clamped to %s, got %s", snapshot.MinCacheTTL, srv.cacheTTL)
	}
}
