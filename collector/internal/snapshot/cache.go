package snapshot

import (
	"encoding/json"
	"fmt"
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
type DiskCache struct {
	dir string
}

// NewDiskCache creates the cache directory if needed and returns the cache.
func NewDiskCache(dir string) (*DiskCache, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, fmt.Errorf("cache directory is required")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create cache dir: %w", err)
	}
	return &DiskCache{dir: dir}, nil
}

func (c *DiskCache) path(nodeName string) string {
	return filepath.Join(c.dir, fmt.Sprintf("%s.json", nodeName))
}

// Get returns the cached snapshot for a node, or ok=false when absent or
// unreadable. Corrupt cache entries read as absent rather than failing the
// request; the next Put overwrites them.
func (c *DiskCache) Get(nodeName string) (LogicalTopologySnapshot, bool) {
	data, err := os.ReadFile(c.path(nodeName))
	if err != nil {
		return LogicalTopologySnapshot{}, false
	}
	var payload LogicalTopologySnapshot
	if err := json.Unmarshal(data, &payload); err != nil {
		return LogicalTopologySnapshot{}, false
	}
	return payload, true
}

// Put writes a snapshot atomically (temp file + rename) so a crashed write
// never leaves a torn cache entry.
func (c *DiskCache) Put(nodeName string, payload LogicalTopologySnapshot) error {
	data, err := json.Marshal(payload)
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
