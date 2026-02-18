package snapshot

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestFileStoreReturnsNodeSnapshot(t *testing.T) {
	tmpDir := t.TempDir()
	writeFixture(t, filepath.Join(tmpDir, "worker-a.json"), LogicalTopologySnapshot{
		Metadata: Metadata{SchemaVersion: "v1alpha1", NodeName: "worker-a", SourceHealth: "healthy"},
	})

	store := NewFileStore(tmpDir, "default.json")
	payload, err := store.GetByNode(context.Background(), "worker-a")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if payload.Metadata.NodeName != "worker-a" {
		t.Fatalf("expected worker-a, got %q", payload.Metadata.NodeName)
	}
}

func TestFileStoreFallsBackToDefault(t *testing.T) {
	tmpDir := t.TempDir()
	writeFixture(t, filepath.Join(tmpDir, "default.json"), LogicalTopologySnapshot{
		Metadata: Metadata{SchemaVersion: "v1alpha1", SourceHealth: "degraded"},
		Warnings: []Warning{{Code: "FALLBACK", Message: "default used"}},
	})

	store := NewFileStore(tmpDir, "default.json")
	payload, err := store.GetByNode(context.Background(), "missing-worker")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if payload.Metadata.NodeName != "missing-worker" {
		t.Fatalf("expected fallback nodeName to be injected, got %q", payload.Metadata.NodeName)
	}
}

func TestFileStoreReturnsNotFoundWhenNoFiles(t *testing.T) {
	store := NewFileStore(t.TempDir(), "default.json")
	_, err := store.GetByNode(context.Background(), "missing")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func writeFixture(t *testing.T, path string, payload LogicalTopologySnapshot) {
	t.Helper()
	bytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(path, bytes, 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
}
