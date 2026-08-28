package snapshot

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

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
	cache, err := NewDiskCache(filepath.Join(t.TempDir(), "cache"))
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
	cache, err := NewDiskCache(dir)
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
	cache, err := NewDiskCache(dir)
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
