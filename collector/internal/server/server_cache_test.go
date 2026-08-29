package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
)

type countingCollector struct {
	mu      sync.Mutex
	calls   int
	fail    bool
	payload snapshot.LogicalTopologySnapshot
}

func (c *countingCollector) callCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls
}

func (c *countingCollector) Collect(_ context.Context, nodeName string) (snapshot.LogicalTopologySnapshot, error) {
	c.mu.Lock()
	c.calls++
	c.mu.Unlock()
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

	if collector.callCount() != 1 {
		t.Fatalf("expected one live collection, got %d", collector.calls)
	}
	if !second.Metadata.GeneratedAt.Equal(first.Metadata.GeneratedAt) {
		t.Fatalf("expected cached snapshot on second request")
	}
	if len(second.Warnings) != 0 {
		t.Fatalf("fresh cache hit must not carry warnings: %#v", second.Warnings)
	}
}

func TestStaleCacheServesImmediatelyAndRevalidatesInBackground(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	fresh := zoneSnapshot("")
	fresh.Metadata.GeneratedAt = now.Add(-time.Second)
	collector := &countingCollector{payload: fresh}
	srv, cache := newCachedServer(t, collector, 2*time.Minute, now)

	stale := zoneSnapshot("worker-a")
	stale.Metadata.GeneratedAt = now.Add(-time.Hour)
	if err := cache.Put("worker-a", stale); err != nil {
		t.Fatalf("seed stale cache: %v", err)
	}

	// The request must not block on recollection: it serves the stale entry.
	payload := fetchNode(t, srv, "worker-a")
	if !payload.Metadata.GeneratedAt.Equal(stale.Metadata.GeneratedAt) {
		t.Fatalf("expected the stale entry served immediately, got generatedAt %s", payload.Metadata.GeneratedAt)
	}

	// The background revalidation lands shortly after.
	deadline := time.Now().Add(5 * time.Second)
	for {
		if cached, ok := cache.Get("worker-a"); ok && cached.Metadata.GeneratedAt.Equal(fresh.Metadata.GeneratedAt) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("background revalidation never updated the cache (collector calls: %d)", collector.callCount())
		}
		time.Sleep(20 * time.Millisecond)
	}
	if collector.callCount() != 1 {
		t.Fatalf("expected exactly one background recollection, got %d", collector.calls)
	}
}

func TestWarmCacheCollectsOnlyMissingOrStaleEntries(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	fresh := zoneSnapshot("")
	fresh.Metadata.GeneratedAt = now.Add(-time.Second)
	collector := &countingCollector{payload: fresh}
	srv, cache := newCachedServer(t, collector, 2*time.Minute, now)
	srv.WithNodeLister(fakeLister{nodes: []string{"worker-a", "worker-b", "worker-c"}})

	// worker-a already fresh; worker-b stale; worker-c missing.
	freshEntry := zoneSnapshot("worker-a")
	freshEntry.Metadata.GeneratedAt = now.Add(-time.Minute)
	if err := cache.Put("worker-a", freshEntry); err != nil {
		t.Fatalf("seed fresh cache: %v", err)
	}
	staleEntry := zoneSnapshot("worker-b")
	staleEntry.Metadata.GeneratedAt = now.Add(-time.Hour)
	if err := cache.Put("worker-b", staleEntry); err != nil {
		t.Fatalf("seed stale cache: %v", err)
	}

	srv.WarmCache(context.Background())

	if collector.callCount() != 2 {
		t.Fatalf("expected warm-up to collect exactly the stale and missing zones, got %d calls", collector.callCount())
	}
	for _, node := range []string{"worker-b", "worker-c"} {
		cached, ok := cache.Get(node)
		if !ok || !cached.Metadata.GeneratedAt.Equal(fresh.Metadata.GeneratedAt) {
			t.Fatalf("expected %s warmed, got ok=%v", node, ok)
		}
	}

	// A second warm-up with everything fresh is a no-op.
	srv.WarmCache(context.Background())
	if collector.callCount() != 2 {
		t.Fatalf("expected no-op warm-up, got %d calls", collector.callCount())
	}
}

func TestStaleCacheStillServesWhenRevalidationFails(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	collector := &countingCollector{fail: true}
	srv, cache := newCachedServer(t, collector, 2*time.Minute, now)

	stale := zoneSnapshot("worker-a")
	stale.Metadata.GeneratedAt = now.Add(-time.Hour)
	if err := cache.Put("worker-a", stale); err != nil {
		t.Fatalf("seed stale cache: %v", err)
	}

	// The stale entry serves immediately and cleanly; the probe failure is
	// the background revalidation's problem (logged), and the entry's own
	// generatedAt carries the staleness signal to the UI.
	payload := fetchNode(t, srv, "worker-a")
	if !payload.Metadata.GeneratedAt.Equal(stale.Metadata.GeneratedAt) {
		t.Fatalf("expected stale entry served, got generatedAt %s", payload.Metadata.GeneratedAt)
	}
	if payload.Database == nil {
		t.Fatal("expected cached database payload")
	}

	// Even after the failed background refresh, later requests keep serving
	// real observed data rather than falling to fixtures.
	deadline := time.Now().Add(3 * time.Second)
	for collector.callCount() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	second := fetchNode(t, srv, "worker-a")
	if !second.Metadata.GeneratedAt.Equal(stale.Metadata.GeneratedAt) {
		t.Fatalf("expected stale entry to keep serving after failed refresh")
	}
}

func TestWithCacheClampsTTLToFloor(t *testing.T) {
	collector := &countingCollector{payload: zoneSnapshot("")}
	srv, _ := newCachedServer(t, collector, time.Second, time.Now())
	if srv.cacheTTL != snapshot.MinCacheTTL {
		t.Fatalf("expected TTL clamped to %s, got %s", snapshot.MinCacheTTL, srv.cacheTTL)
	}
}
