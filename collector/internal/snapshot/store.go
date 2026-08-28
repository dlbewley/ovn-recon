package snapshot

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

var ErrNotFound = errors.New("snapshot not found")

// Store retrieves logical topology snapshots by node.
type Store interface {
	GetByNode(ctx context.Context, nodeName string) (LogicalTopologySnapshot, error)
}

// FileStore reads snapshot payloads from JSON files on disk.
type FileStore struct {
	dir          string
	fallbackFile string
}

// NewFileStore creates a file-backed snapshot store.
func NewFileStore(dir, fallbackFile string) *FileStore {
	return &FileStore{dir: dir, fallbackFile: fallbackFile}
}

// GetByNode loads a node-scoped snapshot, falling back to default payload when configured.
func (s *FileStore) GetByNode(_ context.Context, nodeName string) (LogicalTopologySnapshot, error) {
	primary := filepath.Join(s.dir, fmt.Sprintf("%s.json", nodeName))
	payload, err := loadSnapshot(primary)
	if err == nil {
		if payload.Metadata.NodeName == "" {
			payload.Metadata.NodeName = nodeName
		}
		return payload, nil
	}

	if !errors.Is(err, os.ErrNotExist) {
		return LogicalTopologySnapshot{}, err
	}

	if s.fallbackFile == "" {
		return LogicalTopologySnapshot{}, ErrNotFound
	}

	fallback := filepath.Join(s.dir, s.fallbackFile)
	payload, err = loadSnapshot(fallback)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return LogicalTopologySnapshot{}, ErrNotFound
		}
		return LogicalTopologySnapshot{}, err
	}

	if payload.Metadata.NodeName == "" {
		payload.Metadata.NodeName = nodeName
	}
	return payload, nil
}

// ListNodes returns the node names with a snapshot file on disk, excluding
// the fallback file. Used as the aggregate endpoint's node source when live
// probing is unavailable.
func (s *FileStore) ListNodes(_ context.Context) ([]string, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, fmt.Errorf("list snapshot dir: %w", err)
	}

	nodes := []string{}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" || entry.Name() == s.fallbackFile {
			continue
		}
		nodes = append(nodes, entry.Name()[:len(entry.Name())-len(".json")])
	}
	sort.Strings(nodes)
	return nodes, nil
}

func loadSnapshot(path string) (LogicalTopologySnapshot, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return LogicalTopologySnapshot{}, err
	}

	var payload LogicalTopologySnapshot
	if err := json.Unmarshal(data, &payload); err != nil {
		return LogicalTopologySnapshot{}, fmt.Errorf("decode snapshot %s: %w", path, err)
	}

	return payload, nil
}
