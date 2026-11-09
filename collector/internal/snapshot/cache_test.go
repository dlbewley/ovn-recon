package snapshot

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testBuild = "build-current"

func cacheSnapshot(nodeName string, generatedAt time.Time) LogicalTopologySnapshot {
	return LogicalTopologySnapshot{
		Metadata: Metadata{
			SchemaVersion: SchemaVersionV2,
			GeneratedAt:   generatedAt,
			SourceHealth:  "healthy",
			NodeName:      nodeName,
		},
		Database: &LogicalDatabase{},
		Warnings: []Warning{},
	}
}

func TestDiskCacheRoundTrip(t *testing.T) {
	cache, err := NewDiskCache(filepath.Join(t.TempDir(), "cache"), testBuild)
	if err != nil {
		t.Fatalf("create cache: %v", err)
	}

	if _, ok := cache.Get("worker-a"); ok {
		t.Fatal("expected miss on empty cache")
	}

	generated := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	if err := cache.Put("worker-a", cacheSnapshot("worker-a", generated)); err != nil {
		t.Fatalf("put failed: %v", err)
	}

	cached, ok := cache.Get("worker-a")
	if !ok {
		t.Fatal("expected hit after put")
	}
	if !cached.Metadata.GeneratedAt.Equal(generated) || cached.Metadata.NodeName != "worker-a" {
		t.Fatalf("unexpected cached payload: %#v", cached.Metadata)
	}
}

func TestDiskCacheUsesDeterministicFileNames(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cache")
	cache, err := NewDiskCache(dir, testBuild)
	if err != nil {
		t.Fatalf("create cache: %v", err)
	}
	if err := cache.Put("worker-a", cacheSnapshot("worker-a", time.Now())); err != nil {
		t.Fatalf("put failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "worker-a.json")); err != nil {
		t.Fatalf("expected worker-a.json cache file: %v", err)
	}
}

func TestDiskCacheTreatsCorruptEntryAsMiss(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cache")
	cache, err := NewDiskCache(dir, testBuild)
	if err != nil {
		t.Fatalf("create cache: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "worker-a.json"), []byte("{torn"), 0o600); err != nil {
		t.Fatalf("write corrupt entry: %v", err)
	}
	if _, ok := cache.Get("worker-a"); ok {
		t.Fatal("expected corrupt entry to read as miss")
	}
}

func TestNewDiskCacheRequiresBuildMarker(t *testing.T) {
	if _, err := NewDiskCache(filepath.Join(t.TempDir(), "cache"), " "); err == nil {
		t.Fatal("expected an empty build marker to be rejected")
	}
}

func TestDiskCacheTrustsOnlyEntriesFromItsOwnBuild(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cache")
	previous, err := NewDiskCache(dir, "build-previous")
	if err != nil {
		t.Fatalf("create previous-build cache: %v", err)
	}
	generated := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	if err := previous.Put("worker-a", cacheSnapshot("worker-a", generated)); err != nil {
		t.Fatalf("put failed: %v", err)
	}

	// The same build reopening the volume (a pod restart) trusts the entry.
	restarted, err := NewDiskCache(dir, "build-previous")
	if err != nil {
		t.Fatalf("reopen cache: %v", err)
	}
	if _, ok := restarted.Get("worker-a"); !ok {
		t.Fatal("expected an entry from the same build to be trusted")
	}

	// A different build (an upgrade) does not, but can still reach it as a
	// last resort.
	upgraded, err := NewDiskCache(dir, testBuild)
	if err != nil {
		t.Fatalf("create upgraded cache: %v", err)
	}
	if _, ok := upgraded.Get("worker-a"); ok {
		t.Fatal("expected an entry from another build to read as absent")
	}
	lastResort, ok := upgraded.GetAnyBuild("worker-a")
	if !ok || !lastResort.Metadata.GeneratedAt.Equal(generated) {
		t.Fatalf("expected GetAnyBuild to return the other build's entry, got ok=%v %#v", ok, lastResort.Metadata)
	}

	// Recollecting under the new build makes the entry current again.
	if err := upgraded.Put("worker-a", cacheSnapshot("worker-a", generated.Add(time.Minute))); err != nil {
		t.Fatalf("put failed: %v", err)
	}
	if _, ok := upgraded.Get("worker-a"); !ok {
		t.Fatal("expected the rewritten entry to be trusted")
	}
}

func TestDiskCacheTreatsUnstampedEntryAsAnotherBuild(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cache")
	cache, err := NewDiskCache(dir, testBuild)
	if err != nil {
		t.Fatalf("create cache: %v", err)
	}

	// A collector that predates the marker wrote the bare snapshot.
	generated := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	legacy, err := json.Marshal(cacheSnapshot("worker-a", generated))
	if err != nil {
		t.Fatalf("encode legacy entry: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "worker-a.json"), legacy, 0o600); err != nil {
		t.Fatalf("write legacy entry: %v", err)
	}

	if _, ok := cache.Get("worker-a"); ok {
		t.Fatal("expected an entry with no marker to read as absent")
	}
	if lastResort, ok := cache.GetAnyBuild("worker-a"); !ok || !lastResort.Metadata.GeneratedAt.Equal(generated) {
		t.Fatalf("expected GetAnyBuild to return the unstamped entry, got ok=%v", ok)
	}
}

func TestDiskCacheEntryStaysReadableAsPlainSnapshot(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cache")
	cache, err := NewDiskCache(dir, testBuild)
	if err != nil {
		t.Fatalf("create cache: %v", err)
	}
	generated := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	if err := cache.Put("worker-a", cacheSnapshot("worker-a", generated)); err != nil {
		t.Fatalf("put failed: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(dir, "worker-a.json"))
	if err != nil {
		t.Fatalf("read entry: %v", err)
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(data, &keys); err != nil {
		t.Fatalf("decode entry: %v", err)
	}
	if string(keys["cacheWriterBuild"]) != `"`+testBuild+`"` {
		t.Fatalf("expected the build marker beside the snapshot keys, got %s", keys["cacheWriterBuild"])
	}

	// The marker sits beside the snapshot's own keys, so a collector that
	// predates it (a downgrade) still decodes the file as a snapshot, and
	// the marker never leaks into what Get hands to a response.
	var plain LogicalTopologySnapshot
	if err := json.Unmarshal(data, &plain); err != nil {
		t.Fatalf("decode entry as plain snapshot: %v", err)
	}
	if !plain.Metadata.GeneratedAt.Equal(generated) || plain.Database == nil {
		t.Fatalf("entry did not decode as a plain snapshot: %#v", plain.Metadata)
	}
	cached, _ := cache.Get("worker-a")
	served, err := json.Marshal(cached)
	if err != nil {
		t.Fatalf("encode served snapshot: %v", err)
	}
	if strings.Contains(string(served), "cacheWriterBuild") {
		t.Fatalf("build marker leaked into the served snapshot: %s", served)
	}
}

func TestBuildMarkerFollowsExecutableContent(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		return path
	}
	marker := func(path string) string {
		got, err := fileBuildMarker(path)
		if err != nil {
			t.Fatalf("marker for %s: %v", path, err)
		}
		return got
	}

	first := marker(write("collector-a", "collects six tables"))
	if first == "" || first != marker(write("collector-a-copy", "collects six tables")) {
		t.Fatalf("expected identical binaries to share a marker, got %q", first)
	}
	if first == marker(write("collector-b", "collects eight tables")) {
		t.Fatal("expected a different binary to get a different marker")
	}
	if _, err := fileBuildMarker(filepath.Join(dir, "missing")); err == nil {
		t.Fatal("expected an unreadable executable to be an error")
	}
}

func TestExecutableBuildMarkerIsStableWithinABuild(t *testing.T) {
	first, err := ExecutableBuildMarker()
	if err != nil {
		t.Fatalf("identify build: %v", err)
	}
	second, err := ExecutableBuildMarker()
	if err != nil {
		t.Fatalf("identify build: %v", err)
	}
	if first == "" || first != second {
		t.Fatalf("expected a stable non-empty marker, got %q then %q", first, second)
	}
}

func TestIsFresh(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	ttl := 2 * time.Minute

	if !IsFresh(cacheSnapshot("n", now.Add(-time.Minute)), ttl, now) {
		t.Fatal("one-minute-old snapshot should be fresh at 2m TTL")
	}
	if IsFresh(cacheSnapshot("n", now.Add(-3*time.Minute)), ttl, now) {
		t.Fatal("three-minute-old snapshot should be stale at 2m TTL")
	}
	if IsFresh(cacheSnapshot("n", time.Time{}), ttl, now) {
		t.Fatal("zero generatedAt should never be fresh")
	}
	if IsFresh(cacheSnapshot("n", now.Add(time.Hour)), ttl, now) {
		t.Fatal("future generatedAt should read as not fresh")
	}
}

func TestClampCacheTTLEnforcesFloor(t *testing.T) {
	if got := ClampCacheTTL(5 * time.Second); got != MinCacheTTL {
		t.Fatalf("expected floor %s, got %s", MinCacheTTL, got)
	}
	if got := ClampCacheTTL(5 * time.Minute); got != 5*time.Minute {
		t.Fatalf("expected TTL preserved, got %s", got)
	}
}
