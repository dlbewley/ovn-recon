package snapshot

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// MinCacheTTL is the runtime floor for cache freshness. The OvnRecon API
// enforces the same minimum; this guard covers direct env configuration.
const MinCacheTTL = 30 * time.Second

// DiskCache stores zone snapshots as one JSON file per node in a writable
// directory (EmptyDir or PVC, mounted by the operator). File naming is
// deterministic: <dir>/<node>.json — the same convention as the fixture
// store, but in a separate directory so fixtures stay read-only.
//
// Every entry is stamped with the build marker of the collector that wrote
// it. A volume outlives the collector that filled it, and a newer collector
// may gather tables or columns the older one did not, so an entry written by
// any other build (or carrying no stamp at all) is not trusted as current:
// Get reports it absent and only GetAnyBuild returns it.
type DiskCache struct {
	dir   string
	build string
}

// cacheEntry is the on-disk form of one entry: the snapshot's own keys plus
// the writer's build marker beside them. The marker belongs to the cache
// file, not to the snapshot contract; it never reaches an API response. A
// collector that predates the marker reads such a file as a plain snapshot.
type cacheEntry struct {
	LogicalTopologySnapshot
	WriterBuild string `json:"cacheWriterBuild,omitempty"`
}

// NewDiskCache creates the cache directory if needed and returns a cache
// whose entries are stamped with, and checked against, build (normally
// ExecutableBuildMarker).
func NewDiskCache(dir, build string) (*DiskCache, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, fmt.Errorf("cache directory is required")
	}
	if strings.TrimSpace(build) == "" {
		return nil, fmt.Errorf("cache build marker is required")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create cache dir: %w", err)
	}
	return &DiskCache{dir: dir, build: build}, nil
}

func (c *DiskCache) path(nodeName string) string {
	return filepath.Join(c.dir, fmt.Sprintf("%s.json", nodeName))
}

func (c *DiskCache) read(nodeName string) (cacheEntry, bool) {
	data, err := os.ReadFile(c.path(nodeName))
	if err != nil {
		return cacheEntry{}, false
	}
	var entry cacheEntry
	if err := json.Unmarshal(data, &entry); err != nil {
		return cacheEntry{}, false
	}
	return entry, true
}

// Get returns the node's cached snapshot when this build wrote it, or
// ok=false when the entry is absent, unreadable, unstamped, or stamped by
// another build. Corrupt cache entries read as absent rather than failing
// the request; the next Put overwrites them.
func (c *DiskCache) Get(nodeName string) (LogicalTopologySnapshot, bool) {
	entry, ok := c.read(nodeName)
	if !ok || entry.WriterBuild != c.build {
		return LogicalTopologySnapshot{}, false
	}
	return entry.LogicalTopologySnapshot, true
}

// GetAnyBuild returns the node's cached snapshot whichever build wrote it.
// It may lack tables or columns this build collects, so it is only fit as a
// last resort when a live collection has failed, never as a current answer.
func (c *DiskCache) GetAnyBuild(nodeName string) (LogicalTopologySnapshot, bool) {
	entry, ok := c.read(nodeName)
	if !ok {
		return LogicalTopologySnapshot{}, false
	}
	return entry.LogicalTopologySnapshot, true
}

// Put writes a snapshot, stamped with this build's marker, atomically (temp
// file + rename) so a crashed write never leaves a torn cache entry.
func (c *DiskCache) Put(nodeName string, payload LogicalTopologySnapshot) error {
	data, err := json.Marshal(cacheEntry{LogicalTopologySnapshot: payload, WriterBuild: c.build})
	if err != nil {
		return fmt.Errorf("encode cache entry: %w", err)
	}

	tmp, err := os.CreateTemp(c.dir, fmt.Sprintf(".%s-*.tmp", nodeName))
	if err != nil {
		return fmt.Errorf("create cache temp file: %w", err)
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return fmt.Errorf("write cache entry: %w", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("close cache temp file: %w", err)
	}
	if err := os.Rename(tmpName, c.path(nodeName)); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("commit cache entry: %w", err)
	}
	return nil
}

// ExecutableBuildMarker identifies the running collector binary by a digest
// of its own executable. Nothing has to be bumped by hand: any rebuild that
// could change what is collected changes the marker, and restarting the same
// image keeps it. When the executable cannot be read it returns the error
// with a marker unique to this process, so no earlier entry is trusted.
func ExecutableBuildMarker() (string, error) {
	path, err := os.Executable()
	if err == nil {
		var marker string
		if marker, err = fileBuildMarker(path); err == nil {
			return marker, nil
		}
	}
	return fmt.Sprintf("unidentified-%d-%d", os.Getpid(), time.Now().UnixNano()),
		fmt.Errorf("identify collector build: %w", err)
}

func fileBuildMarker(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()

	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return "sha256:" + hex.EncodeToString(digest.Sum(nil))[:16], nil
}

// IsFresh reports whether a snapshot's own generation timestamp is within
// ttl of now. Freshness rides on metadata.generatedAt rather than file
// mtime so it is meaningful across pod restarts and volume reattachment.
func IsFresh(payload LogicalTopologySnapshot, ttl time.Duration, now time.Time) bool {
	generated := payload.Metadata.GeneratedAt
	if generated.IsZero() {
		return false
	}
	age := now.Sub(generated)
	return age >= 0 && age < ttl
}

// ClampCacheTTL enforces the runtime TTL floor.
func ClampCacheTTL(ttl time.Duration) time.Duration {
	if ttl < MinCacheTTL {
		return MinCacheTTL
	}
	return ttl
}
