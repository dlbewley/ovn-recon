package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
)

func getJSON(t *testing.T, srv *Server, path string, into any) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, req)
	if rr.Code == http.StatusOK && into != nil {
		if err := json.Unmarshal(rr.Body.Bytes(), into); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
	}
	return rr
}

// TestStatusAgreesWithTheAggregate: the status is the aggregate's envelope,
// zone for zone, health and warnings included, and carries no database.
func TestStatusAgreesWithTheAggregate(t *testing.T) {
	store := snapshot.NewFileStore(t.TempDir(), "")
	srv := NewWithLiveCollector(store, fakeAggregateCollector{failNode: "worker-b"}).
		WithNodeLister(fakeLister{nodes: []string{"worker-a", "worker-b", "worker-c"}})

	var aggregate snapshot.ClusterLogicalTopology
	if rr := getJSON(t, srv, "/api/v1/snapshots", &aggregate); rr.Code != http.StatusOK {
		t.Fatalf("aggregate: %d %s", rr.Code, rr.Body.String())
	}
	var status snapshot.CollectorStatus
	rr := getJSON(t, srv, "/api/v1/status", &status)
	if rr.Code != http.StatusOK {
		t.Fatalf("status: %d %s", rr.Code, rr.Body.String())
	}

	if status.Metadata.SchemaVersion != snapshot.StatusSchemaVersion {
		t.Fatalf("schemaVersion %q", status.Metadata.SchemaVersion)
	}
	if status.Metadata.SourceHealth != aggregate.Metadata.SourceHealth || status.Metadata.SourceHealth != snapshot.SourceDegraded {
		t.Fatalf("health: status %q, aggregate %q", status.Metadata.SourceHealth, aggregate.Metadata.SourceHealth)
	}
	if !reflect.DeepEqual(status.Warnings, aggregate.Warnings) {
		t.Fatalf("warnings: status %#v, aggregate %#v", status.Warnings, aggregate.Warnings)
	}
	if len(status.Zones) != len(aggregate.Snapshots) {
		t.Fatalf("zones: status %d, aggregate %d", len(status.Zones), len(aggregate.Snapshots))
	}
	for index, zone := range status.Zones {
		want := snapshot.ZoneStatusOf(aggregate.Snapshots[index])
		if !reflect.DeepEqual(zone, want) {
			t.Fatalf("zone %d: %#v, want %#v", index, zone, want)
		}
	}
	if strings.Contains(rr.Body.String(), "logicalRouters") || strings.Contains(rr.Body.String(), "database") {
		t.Fatalf("status carries database payload: %s", rr.Body.String())
	}
	if status.WarmUp != nil {
		t.Fatalf("warmUp present outside the start-up sweep: %#v", status.WarmUp)
	}
}

func TestStatusWithoutListerReturnsNotFound(t *testing.T) {
	srv := New(snapshot.NewFileStore(t.TempDir(), ""))
	if rr := getJSON(t, srv, "/api/v1/status", nil); rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404 without a lister, got %d", rr.Code)
	}
}

func TestStatusRejectsOtherMethods(t *testing.T) {
	srv := New(snapshot.NewFileStore(t.TempDir(), "")).WithNodeLister(fakeLister{})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/status", nil)
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rr.Code)
	}
}

// blockingCollector holds every Collect until released, so a test can read
// the status while the start-up sweep is part way through.
type blockingCollector struct {
	release chan struct{}
	started chan string
}

func (b blockingCollector) Collect(ctx context.Context, nodeName string) (snapshot.LogicalTopologySnapshot, error) {
	b.started <- nodeName
	select {
	case <-b.release:
	case <-ctx.Done():
		return snapshot.LogicalTopologySnapshot{}, ctx.Err()
	}
	return zoneSnapshot(nodeName), nil
}

type memoryCache struct {
	mu      sync.Mutex
	entries map[string]snapshot.LogicalTopologySnapshot
}

func (m *memoryCache) Get(node string) (snapshot.LogicalTopologySnapshot, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.entries[node]
	return entry, ok
}
func (m *memoryCache) GetAnyBuild(node string) (snapshot.LogicalTopologySnapshot, bool) {
	return m.Get(node)
}
func (m *memoryCache) Put(node string, payload snapshot.LogicalTopologySnapshot) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.entries[node] = payload
	return nil
}

// TestStatusReportsWarmUpProgress: while the sweep runs, the status says how
// many zones it set out to collect and how many have finished, and the zones
// it serves carry COLLECTOR_WARMING as the aggregate's do.
func TestStatusReportsWarmUpProgress(t *testing.T) {
	collector := blockingCollector{release: make(chan struct{}), started: make(chan string, 8)}
	fresh := zoneSnapshot("worker-a")
	fresh.Metadata.GeneratedAt = time.Now().UTC()
	cache := &memoryCache{entries: map[string]snapshot.LogicalTopologySnapshot{"worker-a": fresh}}
	srv := NewWithLiveCollector(snapshot.NewFileStore(t.TempDir(), ""), collector).
		WithNodeLister(fakeLister{nodes: []string{"worker-a", "worker-b", "worker-c"}}).
		WithCache(cache, time.Hour)

	done := make(chan struct{})
	go func() {
		srv.WarmCache(context.Background())
		close(done)
	}()
	// worker-a is fresh, so the sweep collects worker-b and worker-c.
	<-collector.started
	<-collector.started

	// Only worker-a is cached, so read the status from it alone: a node lister
	// that names worker-b would block on the held collection.
	srv.nodeLister = fakeLister{nodes: []string{"worker-a"}}
	var status snapshot.CollectorStatus
	if rr := getJSON(t, srv, "/api/v1/status", &status); rr.Code != http.StatusOK {
		t.Fatalf("status: %d %s", rr.Code, rr.Body.String())
	}
	if status.WarmUp == nil || status.WarmUp.Nodes != 2 || status.WarmUp.Done != 0 {
		t.Fatalf("warmUp mid-sweep = %#v, want 2 nodes, 0 done", status.WarmUp)
	}
	if len(status.Zones) != 1 || len(status.Zones[0].Warnings) == 0 || status.Zones[0].Warnings[0].Code != warningCollectorWarming {
		t.Fatalf("zone served mid-sweep should carry %s: %#v", warningCollectorWarming, status.Zones)
	}

	close(collector.release)
	<-done
	var after snapshot.CollectorStatus
	if rr := getJSON(t, srv, "/api/v1/status", &after); rr.Code != http.StatusOK {
		t.Fatalf("status: %d", rr.Code)
	}
	if after.WarmUp != nil {
		t.Fatalf("warmUp after the sweep = %#v, want absent", after.WarmUp)
	}
	if got := srv.warmDone.Load(); got != 2 {
		t.Fatalf("warmDone after the sweep = %d, want 2", got)
	}
}
