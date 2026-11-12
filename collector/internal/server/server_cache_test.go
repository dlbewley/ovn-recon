package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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

const (
	currentBuild  = "build-current"
	previousBuild = "build-previous"
)

func newCachedServer(t *testing.T, collector *countingCollector, ttl time.Duration, now time.Time) (*Server, *snapshot.DiskCache) {
	t.Helper()
	return newCachedServerAt(t, t.TempDir(), collector, ttl, now)
}

// newCachedServerAt runs the current build's server over an existing cache
// directory, the way an upgraded or restarted collector meets its volume.
func newCachedServerAt(t *testing.T, cacheDir string, collector *countingCollector, ttl time.Duration, now time.Time) (*Server, *snapshot.DiskCache) {
	t.Helper()
	cache, err := snapshot.NewDiskCache(cacheDir, currentBuild)
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

// seedEntryFromBuild leaves a cache entry the way a collector of the given
// build would have; an empty build writes the bare snapshot, as collectors
// that predate the build marker did.
func seedEntryFromBuild(t *testing.T, cacheDir, build string, payload snapshot.LogicalTopologySnapshot) {
	t.Helper()
	if build == "" {
		data, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("encode unstamped entry: %v", err)
		}
		if err := os.WriteFile(filepath.Join(cacheDir, payload.Metadata.NodeName+".json"), data, 0o600); err != nil {
			t.Fatalf("write unstamped entry: %v", err)
		}
		return
	}
	cache, err := snapshot.NewDiskCache(cacheDir, build)
	if err != nil {
		t.Fatalf("create %s cache: %v", build, err)
	}
	if err := cache.Put(payload.Metadata.NodeName, payload); err != nil {
		t.Fatalf("seed %s entry: %v", build, err)
	}
}

// entryWithoutNewTables is a snapshot an older collector would have cached:
// young enough to be within TTL, but with no database payload, standing in
// for the tables the current build has since learned to collect.
func entryWithoutNewTables(nodeName string, generatedAt time.Time) snapshot.LogicalTopologySnapshot {
	entry := zoneSnapshot(nodeName)
	entry.Metadata.GeneratedAt = generatedAt
	entry.Database = nil
	return entry
}

func TestEntryFromAnotherBuildIsRecollectedOnFirstRequest(t *testing.T) {
	for name, build := range map[string]string{"another build": previousBuild, "no marker": ""} {
		t.Run(name, func(t *testing.T) {
			now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
			collected := zoneSnapshot("")
			collected.Metadata.GeneratedAt = now
			collector := &countingCollector{payload: collected}
			cacheDir := t.TempDir()
			// Written seconds before the upgrade: well within the TTL.
			seedEntryFromBuild(t, cacheDir, build, entryWithoutNewTables("worker-a", now.Add(-10*time.Second)))
			srv, cache := newCachedServerAt(t, cacheDir, collector, 2*time.Minute, now)

			// The very first request must already carry what this build
			// collects: no serving the old entry while revalidating.
			payload := fetchNode(t, srv, "worker-a")
			if payload.Database == nil || !payload.Metadata.GeneratedAt.Equal(now) {
				t.Fatalf("expected a fresh collection, got the old entry (generatedAt %s)", payload.Metadata.GeneratedAt)
			}
			if len(payload.Warnings) != 0 {
				t.Fatalf("a successful recollection must not carry warnings: %#v", payload.Warnings)
			}
			if collector.callCount() != 1 {
				t.Fatalf("expected one synchronous collection, got %d", collector.callCount())
			}

			// The entry now belongs to this build and serves from cache.
			if cached, ok := cache.Get("worker-a"); !ok || cached.Database == nil {
				t.Fatalf("expected the recollected entry cached under this build, ok=%v", ok)
			}
			fetchNode(t, srv, "worker-a")
			if collector.callCount() != 1 {
				t.Fatalf("expected the second request served from cache, got %d collections", collector.callCount())
			}
		})
	}
}

func TestEntryFromSameBuildWithinTTLSurvivesRestart(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	collector := &countingCollector{payload: zoneSnapshot("")}
	cacheDir := t.TempDir()
	entry := zoneSnapshot("worker-a")
	entry.Metadata.GeneratedAt = now.Add(-10 * time.Second)
	seedEntryFromBuild(t, cacheDir, currentBuild, entry)
	srv, _ := newCachedServerAt(t, cacheDir, collector, 2*time.Minute, now)

	payload := fetchNode(t, srv, "worker-a")
	if !payload.Metadata.GeneratedAt.Equal(entry.Metadata.GeneratedAt) {
		t.Fatalf("expected the same build's entry served, got generatedAt %s", payload.Metadata.GeneratedAt)
	}
	if collector.callCount() != 0 {
		t.Fatalf("expected no collection for a fresh entry from this build, got %d", collector.callCount())
	}
}

func TestEntryFromAnotherBuildStillServesWhenCollectionFails(t *testing.T) {
	for name, build := range map[string]string{"another build": previousBuild, "no marker": ""} {
		t.Run(name, func(t *testing.T) {
			now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
			collector := &countingCollector{fail: true}
			cacheDir := t.TempDir()
			old := zoneSnapshot("worker-a")
			old.Metadata.GeneratedAt = now.Add(-10 * time.Second)
			seedEntryFromBuild(t, cacheDir, build, old)
			srv, cache := newCachedServerAt(t, cacheDir, collector, 2*time.Minute, now)

			// Real observed data beats nothing, but it is flagged: the
			// collection was attempted first and its failure is visible.
			payload := fetchNode(t, srv, "worker-a")
			if collector.callCount() != 1 {
				t.Fatalf("expected a collection attempt before falling back, got %d", collector.callCount())
			}
			if !payload.Metadata.GeneratedAt.Equal(old.Metadata.GeneratedAt) || payload.Database == nil {
				t.Fatalf("expected the old entry served as fallback, got generatedAt %s", payload.Metadata.GeneratedAt)
			}
			if payload.Metadata.SourceHealth != "degraded" {
				t.Fatalf("expected degraded source health, got %q", payload.Metadata.SourceHealth)
			}
			codes := map[string]bool{}
			for _, warning := range payload.Warnings {
				codes[warning.Code] = true
			}
			if !codes["LIVE_PROBE_FAILED"] || !codes["SNAPSHOT_STALE"] {
				t.Fatalf("expected LIVE_PROBE_FAILED and SNAPSHOT_STALE warnings, got %#v", payload.Warnings)
			}

			// The fallback does not adopt the entry: it is retried, not
			// trusted, on the next request.
			if _, ok := cache.Get("worker-a"); ok {
				t.Fatal("a failed collection must not make the old entry current")
			}
			fetchNode(t, srv, "worker-a")
			if collector.callCount() != 2 {
				t.Fatalf("expected the next request to retry collection, got %d", collector.callCount())
			}
		})
	}
}

func TestWarmCacheRecollectsEntriesFromAnotherBuild(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	collected := zoneSnapshot("")
	collected.Metadata.GeneratedAt = now
	collector := &countingCollector{payload: collected}
	cacheDir := t.TempDir()

	// All three entries are within TTL; only worker-a is this build's.
	young := now.Add(-10 * time.Second)
	current := zoneSnapshot("worker-a")
	current.Metadata.GeneratedAt = young
	seedEntryFromBuild(t, cacheDir, currentBuild, current)
	seedEntryFromBuild(t, cacheDir, previousBuild, entryWithoutNewTables("worker-b", young))
	seedEntryFromBuild(t, cacheDir, "", entryWithoutNewTables("worker-c", young))

	srv, cache := newCachedServerAt(t, cacheDir, collector, 2*time.Minute, now)
	srv.WithNodeLister(fakeLister{nodes: []string{"worker-a", "worker-b", "worker-c"}})
	srv.WarmCache(context.Background())

	if collector.callCount() != 2 {
		t.Fatalf("expected warm-up to recollect the two entries from other builds, got %d calls", collector.callCount())
	}
	if cached, ok := cache.Get("worker-a"); !ok || !cached.Metadata.GeneratedAt.Equal(young) {
		t.Fatalf("expected this build's fresh entry left alone, ok=%v", ok)
	}
	for _, node := range []string{"worker-b", "worker-c"} {
		cached, ok := cache.Get(node)
		if !ok || cached.Database == nil || !cached.Metadata.GeneratedAt.Equal(now) {
			t.Fatalf("expected %s recollected under this build, ok=%v", node, ok)
		}
	}
}

func hasWarning(payload snapshot.LogicalTopologySnapshot, code string) bool {
	for _, warning := range payload.Warnings {
		if warning.Code == code {
			return true
		}
	}
	return false
}

func TestSnapshotsServedDuringWarmUpCarryTheWarmingMark(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	fresh := zoneSnapshot("")
	fresh.Metadata.GeneratedAt = now.Add(-time.Second)
	collector := &countingCollector{payload: fresh}
	srv, cache := newCachedServer(t, collector, 2*time.Minute, now)

	srv.warming.Store(true)
	if payload := fetchNode(t, srv, "worker-a"); !hasWarning(payload, warningCollectorWarming) {
		t.Fatalf("expected %s while warming, got %+v", warningCollectorWarming, payload.Warnings)
	}
	// The mark belongs to the response only: the cache entry stays clean.
	if cached, ok := cache.Get("worker-a"); !ok || hasWarning(cached, warningCollectorWarming) {
		t.Fatalf("expected a clean cache entry, got ok=%v warnings=%+v", ok, cached.Warnings)
	}

	srv.warming.Store(false)
	if payload := fetchNode(t, srv, "worker-a"); hasWarning(payload, warningCollectorWarming) {
		t.Fatalf("expected no %s after warm-up, got %+v", warningCollectorWarming, payload.Warnings)
	}
}

func TestWarmCacheClearsTheWarmingMarkWhenDone(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	collector := &countingCollector{payload: zoneSnapshot("")}
	srv, _ := newCachedServer(t, collector, 2*time.Minute, now)
	srv.WithNodeLister(fakeLister{nodes: []string{"worker-a"}})

	srv.WarmCache(context.Background())
	if srv.warming.Load() {
		t.Fatal("expected the warming mark cleared after warm-up")
	}
}
