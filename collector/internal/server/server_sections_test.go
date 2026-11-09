package server

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
)

const fixtureDir = "../../fixtures/snapshots"

var (
	policyKeys  = []string{"acls", "addressSets", "portGroups"}
	serviceKeys = []string{"loadBalancerGroups", "loadBalancers"}
)

// withSections stands in for a collector that gathers every optional table.
// The policy rows are still placeholders (their shapes land with
// ovn-recon-e2b.5); the services rows are typed, and a payload that already
// carries them (the fixture corpus does) keeps its own.
func withSections(payload snapshot.LogicalTopologySnapshot) snapshot.LogicalTopologySnapshot {
	if payload.Database == nil {
		return payload
	}
	db := *payload.Database
	db.ACLs = []snapshot.SectionRow{{"uuid": "acl-1", "priority": float64(1001)}}
	db.PortGroups = []snapshot.SectionRow{{"uuid": "pg-1", "name": "clusterPortGroup"}}
	db.AddressSets = []snapshot.SectionRow{}
	if db.LoadBalancers == nil {
		db.LoadBalancers = []snapshot.LoadBalancerRow{
			{UUID: "lb-1", Name: "Service_shop/web_TCP_cluster", Protocol: "tcp", VIPs: map[string]string{"172.30.80.5:443": "10.129.5.152:10443"}},
			{UUID: "lb-2", Name: "Service_shop/idle_TCP_cluster", Protocol: "tcp", VIPs: map[string]string{"172.30.80.6:80": ""}},
		}
	}
	if db.LoadBalancerGroups == nil {
		db.LoadBalancerGroups = []snapshot.LoadBalancerGroupRow{{UUID: "lbg-1", Name: "clusterLBGroup", LoadBalancerUUIDs: []string{"lb-1", "lb-2"}}}
	}
	payload.Database = &db
	return payload
}

// withoutSectionKeys drops the optional section keys from a sorted key list:
// what a response without include= carries.
func withoutSectionKeys(keys []string) []string {
	section := map[string]bool{}
	for _, key := range sortedUnion(policyKeys, serviceKeys) {
		section[key] = true
	}
	ladder := []string{}
	for _, key := range keys {
		if !section[key] {
			ladder = append(ladder, key)
		}
	}
	return ladder
}

func get(t *testing.T, srv *Server, target string, header http.Header) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	for name, values := range header {
		req.Header[name] = values
	}
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, req)
	return rr
}

func databaseKeysOf(t *testing.T, raw []byte) []string {
	t.Helper()
	var decoded struct {
		Database map[string]json.RawMessage `json:"database"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	keys := make([]string, 0, len(decoded.Database))
	for key := range decoded.Database {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func sortedUnion(groups ...[]string) []string {
	union := []string{}
	for _, group := range groups {
		union = append(union, group...)
	}
	sort.Strings(union)
	return union
}

// TestIncludeOverFixtureCorpus is the contract test for the include
// parameter: every fixture, extended with the optional sections, is served
// through the file store and must answer with today's database keys by
// default and add exactly the requested sections otherwise.
func TestIncludeOverFixtureCorpus(t *testing.T) {
	entries, err := os.ReadDir(fixtureDir)
	if err != nil {
		t.Fatalf("read fixture dir: %v", err)
	}

	storeDir := t.TempDir()
	todaysKeys := map[string][]string{}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" || entry.Name() == "default.json" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(fixtureDir, entry.Name()))
		if err != nil {
			t.Fatalf("read fixture: %v", err)
		}
		var fixture snapshot.LogicalTopologySnapshot
		if err := json.Unmarshal(raw, &fixture); err != nil {
			t.Fatalf("decode fixture %s: %v", entry.Name(), err)
		}
		node := strings.TrimSuffix(entry.Name(), ".json")
		// The fixtures carry the services section since ovn-recon-e2b.6;
		// the default response is the fixture without any section key.
		todaysKeys[node] = withoutSectionKeys(databaseKeysOf(t, raw))
		writeFixture(t, filepath.Join(storeDir, entry.Name()), withSections(fixture))
	}
	if len(todaysKeys) == 0 {
		t.Fatal("no fixtures found")
	}

	srv := New(snapshot.NewFileStore(storeDir, ""))
	for node, today := range todaysKeys {
		cases := []struct {
			query string
			want  []string
		}{
			{query: "", want: today},
			{query: "?include=", want: today},
			{query: "?include=policy", want: sortedUnion(today, policyKeys)},
			{query: "?include=services", want: sortedUnion(today, serviceKeys)},
			{query: "?include=policy,services", want: sortedUnion(today, policyKeys, serviceKeys)},
			{query: "?include=services&include=policy", want: sortedUnion(today, policyKeys, serviceKeys)},
		}
		for _, tc := range cases {
			t.Run(node+tc.query, func(t *testing.T) {
				rr := get(t, srv, "/api/v1/snapshots/"+node+tc.query, nil)
				if rr.Code != http.StatusOK {
					t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
				}
				if got := databaseKeysOf(t, rr.Body.Bytes()); !reflect.DeepEqual(got, tc.want) {
					t.Fatalf("database keys = %v, want %v", got, tc.want)
				}
			})
		}
	}
}

// TestFixtureServicesSectionIsServedOnlyOnRequest runs the real fixture
// corpus (no test double) through the file store: the services rows the
// fixtures carry come back complete with include=services and not at all
// without it, and the ladder part of the response is the same either way.
func TestFixtureServicesSectionIsServedOnlyOnRequest(t *testing.T) {
	srv := New(snapshot.NewFileStore(fixtureDir, ""))
	checked := 0
	for _, node := range []string{"cnv-1", "cnv-2", "ctrl-1"} {
		raw, err := os.ReadFile(filepath.Join(fixtureDir, node+".json"))
		if err != nil {
			t.Fatalf("read fixture: %v", err)
		}
		var fixture snapshot.LogicalTopologySnapshot
		if err := json.Unmarshal(raw, &fixture); err != nil {
			t.Fatalf("decode fixture %s: %v", node, err)
		}
		if fixture.Database.LoadBalancers == nil {
			continue
		}
		checked++

		var plain, detail snapshot.LogicalTopologySnapshot
		if err := json.Unmarshal(get(t, srv, "/api/v1/snapshots/"+node, nil).Body.Bytes(), &plain); err != nil {
			t.Fatalf("decode default response: %v", err)
		}
		if plain.Database.LoadBalancers != nil || plain.Database.LoadBalancerGroups != nil {
			t.Fatalf("%s: the default response must not carry the services section", node)
		}
		if err := json.Unmarshal(get(t, srv, "/api/v1/snapshots/"+node+"?include=services", nil).Body.Bytes(), &detail); err != nil {
			t.Fatalf("decode services response: %v", err)
		}
		if !reflect.DeepEqual(detail.Database.LoadBalancers, fixture.Database.LoadBalancers) ||
			!reflect.DeepEqual(detail.Database.LoadBalancerGroups, fixture.Database.LoadBalancerGroups) {
			t.Fatalf("%s: include=services must return the fixture's rows unchanged", node)
		}
		if len(detail.Database.LoadBalancers) == 0 || len(detail.Database.LoadBalancerGroups) == 0 {
			t.Fatalf("%s: expected service rows in the fixture", node)
		}
		detail.Database.LoadBalancers, detail.Database.LoadBalancerGroups = nil, nil
		if !reflect.DeepEqual(plain.Database, detail.Database) {
			t.Fatalf("%s: the ladder tables must be identical with and without include", node)
		}
	}
	if checked < 2 {
		t.Fatalf("expected at least two fixtures to carry the services section, got %d", checked)
	}
}

func TestIncludeDeliversCollectedEmptySectionAsEmptyArray(t *testing.T) {
	storeDir := t.TempDir()
	writeFixture(t, filepath.Join(storeDir, "worker-a.json"), withSections(zoneSnapshot("worker-a")))
	srv := New(snapshot.NewFileStore(storeDir, ""))

	rr := get(t, srv, "/api/v1/snapshots/worker-a?include=policy", nil)
	var decoded struct {
		Database map[string]json.RawMessage `json:"database"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got := string(decoded.Database["addressSets"]); got != "[]" {
		t.Fatalf("collected, empty section must be [], got %q", got)
	}
}

func TestUnknownIncludeIsBadRequestNamingValidSections(t *testing.T) {
	storeDir := t.TempDir()
	writeFixture(t, filepath.Join(storeDir, "worker-a.json"), zoneSnapshot("worker-a"))
	store := snapshot.NewFileStore(storeDir, "")
	srv := New(store).WithNodeLister(store)

	for _, target := range []string{
		"/api/v1/snapshots/worker-a?include=bogus",
		"/api/v1/snapshots/worker-a?include=policy,bogus",
		"/api/v1/snapshots?include=bogus",
	} {
		rr := get(t, srv, target, nil)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("%s: expected 400, got %d", target, rr.Code)
		}
		body := rr.Body.String()
		if !strings.Contains(body, `"bogus"`) || !strings.Contains(body, "valid sections: policy, services") {
			t.Fatalf("%s: body must name the bad and the valid sections, got %q", target, body)
		}
	}
}

func TestAggregateHonoursIncludeAndOmitsSectionsByDefault(t *testing.T) {
	storeDir := t.TempDir()
	writeFixture(t, filepath.Join(storeDir, "worker-a.json"), withSections(zoneSnapshot("worker-a")))
	writeFixture(t, filepath.Join(storeDir, "worker-b.json"), withSections(zoneSnapshot("worker-b")))
	store := snapshot.NewFileStore(storeDir, "")
	srv := New(store).WithNodeLister(store)

	zoneKeys := func(query string) [][]string {
		t.Helper()
		rr := get(t, srv, "/api/v1/snapshots"+query, nil)
		if rr.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
		}
		var decoded struct {
			Snapshots []json.RawMessage `json:"snapshots"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &decoded); err != nil {
			t.Fatalf("decode aggregate: %v", err)
		}
		if len(decoded.Snapshots) != 2 {
			t.Fatalf("expected two zones, got %d", len(decoded.Snapshots))
		}
		keys := [][]string{}
		for _, zone := range decoded.Snapshots {
			keys = append(keys, databaseKeysOf(t, zone))
		}
		return keys
	}

	ladder := []string{"logicalRouterPorts", "logicalRouters", "logicalSwitchPorts", "logicalSwitches", "nats", "staticRoutes"}
	for _, keys := range zoneKeys("") {
		if !reflect.DeepEqual(keys, ladder) {
			t.Fatalf("default aggregate must be ladder-only, got %v", keys)
		}
	}
	for _, keys := range zoneKeys("?include=services") {
		if want := sortedUnion(ladder, serviceKeys); !reflect.DeepEqual(keys, want) {
			t.Fatalf("aggregate with services = %v, want %v", keys, want)
		}
	}
	for _, keys := range zoneKeys("?include=policy,services") {
		if want := sortedUnion(ladder, policyKeys, serviceKeys); !reflect.DeepEqual(keys, want) {
			t.Fatalf("aggregate with both = %v, want %v", keys, want)
		}
	}
}

// TestCacheStoresFullSnapshotSoIncludeNeverRecollects covers the "one
// collect, one cache entry" decision: a ladder request fills the cache with
// the full snapshot, and a later request for the sections is a projection of
// that same entry.
func TestCacheStoresFullSnapshotSoIncludeNeverRecollects(t *testing.T) {
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	collector := &countingCollector{payload: withSections(zoneSnapshot(""))}
	collector.payload.Metadata.GeneratedAt = now
	srv, cache := newCachedServer(t, collector, 2*time.Minute, now)
	srv.WithNodeLister(fakeLister{nodes: []string{"worker-a"}})

	ladder := get(t, srv, "/api/v1/snapshots/worker-a", nil)
	if got := databaseKeysOf(t, ladder.Body.Bytes()); len(got) != 6 {
		t.Fatalf("ladder response must not carry sections, got %v", got)
	}

	cached, ok := cache.Get("worker-a")
	if !ok {
		t.Fatal("expected a cache entry after the first request")
	}
	if len(cached.Database.ACLs) != 1 || len(cached.Database.LoadBalancers) != 2 || cached.Database.AddressSets == nil {
		t.Fatalf("the cache entry must hold the full snapshot, got %#v", cached.Database)
	}

	detail := get(t, srv, "/api/v1/snapshots/worker-a?include=policy,services", nil)
	if got := databaseKeysOf(t, detail.Body.Bytes()); len(got) != 11 {
		t.Fatalf("expected the five section keys on top of the ladder, got %v", got)
	}
	aggregate := get(t, srv, "/api/v1/snapshots?include=policy", nil)
	if aggregate.Code != http.StatusOK {
		t.Fatalf("aggregate: expected 200, got %d", aggregate.Code)
	}
	// And back again: the projection did not strip the cached entry.
	again := get(t, srv, "/api/v1/snapshots/worker-a?include=services", nil)
	if got := databaseKeysOf(t, again.Body.Bytes()); len(got) != 8 {
		t.Fatalf("expected the two service keys on top of the ladder, got %v", got)
	}

	if collector.callCount() != 1 {
		t.Fatalf("expected one live collection across all four requests, got %d", collector.callCount())
	}
}

func gunzip(t *testing.T, body []byte) []byte {
	t.Helper()
	reader, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("response is not gzip: %v", err)
	}
	plain, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read gzip body: %v", err)
	}
	return plain
}

func TestSnapshotEndpointsGzipWhenAccepted(t *testing.T) {
	storeDir := t.TempDir()
	raw, err := os.ReadFile(filepath.Join(fixtureDir, "cnv-1.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fixture snapshot.LogicalTopologySnapshot
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	writeFixture(t, filepath.Join(storeDir, "cnv-1.json"), withSections(fixture))
	store := snapshot.NewFileStore(storeDir, "")
	srv := New(store).WithNodeLister(store)

	for _, target := range []string{
		"/api/v1/snapshots/cnv-1",
		"/api/v1/snapshots/cnv-1?include=policy,services",
		"/api/v1/snapshots",
	} {
		t.Run(target, func(t *testing.T) {
			plain := get(t, srv, target, nil)
			if plain.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d", plain.Code)
			}
			if got := plain.Header().Get("Content-Encoding"); got != "" {
				t.Fatalf("a request without Accept-Encoding must not be encoded, got %q", got)
			}
			if got := plain.Header().Get("Vary"); got != "Accept-Encoding" {
				t.Fatalf("expected Vary: Accept-Encoding, got %q", got)
			}

			zipped := get(t, srv, target, http.Header{"Accept-Encoding": {"gzip, deflate, br"}})
			if zipped.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d", zipped.Code)
			}
			if got := zipped.Header().Get("Content-Encoding"); got != "gzip" {
				t.Fatalf("expected Content-Encoding: gzip, got %q", got)
			}
			if got := zipped.Header().Get("Vary"); got != "Accept-Encoding" {
				t.Fatalf("expected Vary: Accept-Encoding, got %q", got)
			}
			if got := zipped.Header().Get("Content-Type"); got != "application/json" {
				t.Fatalf("expected the JSON content type to survive, got %q", got)
			}
			if got := zipped.Header().Get(headerSnapshotSourceHealth); got == "" {
				t.Fatal("snapshot headers must survive compression")
			}
			if zipped.Body.Len() >= plain.Body.Len() {
				t.Fatalf("gzip did not shrink the body: %d >= %d", zipped.Body.Len(), plain.Body.Len())
			}

			inflated := gunzip(t, zipped.Body.Bytes())
			if target == "/api/v1/snapshots" {
				// The aggregate stamps its own generatedAt per request, so
				// compare the zones it carries rather than the whole body.
				zones := func(body []byte) []byte {
					var decoded struct {
						Snapshots json.RawMessage `json:"snapshots"`
					}
					if err := json.Unmarshal(body, &decoded); err != nil {
						t.Fatalf("decode aggregate: %v", err)
					}
					return decoded.Snapshots
				}
				if !bytes.Equal(zones(inflated), zones(plain.Body.Bytes())) {
					t.Fatal("the inflated aggregate must carry the same zones as the uncompressed response")
				}
				return
			}
			if !bytes.Equal(inflated, plain.Body.Bytes()) {
				t.Fatal("the inflated body must equal the uncompressed response")
			}
		})
	}
}

func TestGzipLeavesErrorsAndProbesPlain(t *testing.T) {
	srv := New(snapshot.NewFileStore(t.TempDir(), ""))
	accept := http.Header{"Accept-Encoding": {"gzip"}}

	for target, wantStatus := range map[string]int{
		"/api/v1/snapshots/missing":               http.StatusNotFound,
		"/api/v1/snapshots/missing?include=bogus": http.StatusBadRequest,
		"/healthz": http.StatusOK,
	} {
		rr := get(t, srv, target, accept)
		if rr.Code != wantStatus {
			t.Fatalf("%s: expected %d, got %d", target, wantStatus, rr.Code)
		}
		if got := rr.Header().Get("Content-Encoding"); got != "" {
			t.Fatalf("%s: must not be encoded, got %q", target, got)
		}
	}
}

func TestAcceptsGzip(t *testing.T) {
	cases := map[string]bool{
		"":                           false,
		"identity":                   false,
		"gzip":                       true,
		"GZIP":                       true,
		"x-gzip":                     true,
		"deflate, gzip;q=0.8":        true,
		"gzip;q=0":                   false,
		"gzip; q=0.0, *":             false,
		"*":                          true,
		"*;q=0":                      false,
		"br, zstd":                   false,
		"gzip;q=1.0, identity;q=0.5": true,
	}
	for value, want := range cases {
		header := http.Header{}
		if value != "" {
			header.Set("Accept-Encoding", value)
		}
		if got := acceptsGzip(header); got != want {
			t.Errorf("acceptsGzip(%q) = %v, want %v", value, got, want)
		}
	}
}
