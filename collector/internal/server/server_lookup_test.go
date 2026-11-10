package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
)

// fixtureModeServer is the collector as it runs without a cluster: the file
// store serves the fixture corpus and lists its nodes.
func fixtureModeServer() *Server {
	store := snapshot.NewFileStore(fixtureDir, "default.json")
	return New(store).WithNodeLister(store)
}

func decodeLookup(t *testing.T, rr *httptest.ResponseRecorder) snapshot.LookupResponse {
	t.Helper()
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var response snapshot.LookupResponse
	decoder := json.NewDecoder(rr.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&response); err != nil {
		t.Fatalf("decode lookup response: %v", err)
	}
	return response
}

func lookup(t *testing.T, srv *Server, path string) snapshot.LookupResponse {
	t.Helper()
	return decodeLookup(t, get(t, srv, "/api/v1/lookup/"+path, nil))
}

func warningCodes(response snapshot.LookupResponse) []string {
	codes := []string{}
	for _, warning := range response.Warnings {
		codes = append(codes, warning.Code)
	}
	return codes
}

// A CIDR's slash has to survive the trip in a path. A direct client sends it
// encoded; the OpenShift console decodes the path before it forwards it, so
// the collector sees a literal slash and one more segment. Both are the same
// request.
func TestLookupPathCarriesACIDRSlashEncodedOrLiteral(t *testing.T) {
	srv := fixtureModeServer()

	encoded := "/api/v1/lookup/cidr/" + url.PathEscape("10.1.2.0/24")
	if !strings.HasSuffix(encoded, "/cidr/10.1.2.0%2F24") {
		t.Fatalf("test setup: expected an encoded slash, got %q", encoded)
	}
	viaEncoded := get(t, srv, encoded, nil)
	viaLiteral := get(t, srv, "/api/v1/lookup/cidr/10.1.2.0/24", nil)
	if viaEncoded.Code != http.StatusOK || viaLiteral.Code != http.StatusOK {
		t.Fatalf("expected 200 for both spellings, got %d and %d: %s", viaEncoded.Code, viaLiteral.Code, viaEncoded.Body.String())
	}
	if viaEncoded.Body.String() != viaLiteral.Body.String() {
		t.Fatal("the encoded and the literal spelling answered differently")
	}

	response := decodeLookup(t, viaEncoded)
	if response.Query.Kind != snapshot.LookupKindCIDR || response.Query.Value != "10.1.2.0/24" {
		t.Fatalf("the slash did not survive: query %+v", response.Query)
	}
	if response.Total == 0 || response.Hits[0].MatchType != snapshot.LookupMatchExact || response.Hits[0].MatchedValue != "10.1.2.0/24" {
		t.Fatalf("expected the subnet itself as the first hit, got %+v", response.Hits)
	}

	// The same for an IPv6 prefix, whose colons are encoded too by a client
	// that encodes the whole value.
	for _, path := range []string{"cidr/fd69::%2F112", "cidr/fd69::/112", "cidr/fd69%3A%3A%2F112"} {
		if got := lookup(t, srv, path).Query.Value; got != "fd69::/112" {
			t.Errorf("%s: query value %q, want fd69::/112", path, got)
		}
	}
	// Every other kind arrives decoded as well.
	if got := lookup(t, srv, "mac/0a%3A58%3A0a%3A83%3A00%3A46"); got.Query.Value != "0a:58:0a:83:00:46" || got.Total != 1 {
		t.Errorf("encoded MAC: %+v, %d hits", got.Query, got.Total)
	}
	if got := lookup(t, srv, "name/thanos%20querier"); got.Query.Value != "thanos querier" {
		t.Errorf("encoded space: %+v", got.Query)
	}
}

// Nothing is read from a query string: the console drops it on the way to
// the collector (ovn-recon-e2b.12), so a request must mean the same without
// it.
func TestLookupIgnoresTheQueryString(t *testing.T) {
	srv := fixtureModeServer()
	plain := get(t, srv, "/api/v1/lookup/ip/100.88.0.5", nil)
	withQuery := get(t, srv, "/api/v1/lookup/ip/100.88.0.5?value=10.131.0.70&kind=name&limit=1", nil)
	if plain.Code != http.StatusOK || plain.Body.String() != withQuery.Body.String() {
		t.Fatalf("a query string changed the answer: %d %s", withQuery.Code, withQuery.Body.String())
	}
}

func TestLookupSearchesEveryFixtureZoneInFixtureMode(t *testing.T) {
	srv := fixtureModeServer()
	rr := get(t, srv, "/api/v1/lookup/ip/100.88.0.5", nil)
	if got := rr.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q", got)
	}
	if got := rr.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q", got)
	}
	response := decodeLookup(t, rr)

	nodes := []string{}
	for _, zone := range response.Zones {
		nodes = append(nodes, zone.Node)
		if zone.SnapshotGeneratedAt.IsZero() {
			t.Errorf("zone %s has no snapshot time", zone.Node)
		}
	}
	// The fallback fixture is not a zone.
	if strings.Join(nodes, ",") != "cnv-1,cnv-2,ctrl-1" {
		t.Fatalf("expected the three node fixtures, got %v", nodes)
	}
	if len(response.Warnings) != 0 {
		t.Fatalf("unexpected warnings: %+v", response.Warnings)
	}

	// One address, two networks, in each zone: all of it comes back.
	perNode := map[string]map[string]bool{}
	for _, hit := range response.Hits {
		if perNode[hit.Node] == nil {
			perNode[hit.Node] = map[string]bool{}
		}
		perNode[hit.Node][hit.Network] = true
	}
	for _, node := range nodes {
		if !perNode[node][snapshot.DefaultNetwork] || !perNode[node]["demo-mirror_example-l3-udn"] {
			t.Errorf("zone %s: expected the address in the default and the user-defined network, got %v", node, perNode[node])
		}
	}
}

func TestLookupTruncatesAtTheCap(t *testing.T) {
	response := lookup(t, fixtureModeServer(), "cidr/10.128.0.0%2F14")
	if response.Limit != snapshot.DefaultLookupLimit || len(response.Hits) != snapshot.DefaultLookupLimit {
		t.Fatalf("expected %d hits, got %d (limit %d)", snapshot.DefaultLookupLimit, len(response.Hits), response.Limit)
	}
	if !response.Truncated || response.Total <= snapshot.DefaultLookupLimit {
		t.Fatalf("expected truncated=true with a larger total, got truncated=%v total=%d", response.Truncated, response.Total)
	}

	small := lookup(t, fixtureModeServer(), "ip/100.88.0.5")
	if small.Truncated || small.Total != len(small.Hits) {
		t.Fatalf("a small answer must not be marked truncated: %+v", small)
	}
}

func TestLookupRejectsWhatItCannotParse(t *testing.T) {
	srv := fixtureModeServer()
	cases := []struct {
		path       string
		wantInBody string
	}{
		{"ip/10.1.2", "not an IP address"},
		{"ip/10.1.2.0%2F24", "not an IP address"},
		{"ip/thanos-querier", "not an IP address"},
		{"mac/0a:58:0a:83:00", "not a MAC address"},
		{"mac/10.131.0.70", "not a MAC address"},
		{"cidr/10.1.2.5", "not a CIDR"},
		{"cidr/10.1.2.0%2F33", "not a CIDR"},
		{"cidr/10.1.2.0/24/extra", "not a CIDR"},
		{"pod/thanos-querier", "valid kinds: ip, mac, cidr, name"},
		{"name/", "value is required"},
		{"name/%20", "value is required"},
		{"ip", "expected /api/v1/lookup/"},
		{"", "expected /api/v1/lookup/"},
	}
	for _, tc := range cases {
		rr := get(t, srv, "/api/v1/lookup/"+tc.path, nil)
		if rr.Code != http.StatusBadRequest {
			t.Errorf("%q: expected 400, got %d: %s", tc.path, rr.Code, rr.Body.String())
			continue
		}
		if !strings.Contains(rr.Body.String(), tc.wantInBody) {
			t.Errorf("%q: body %q does not say %q", tc.path, rr.Body.String(), tc.wantInBody)
		}
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/lookup/ip/10.131.0.70", nil)
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST: expected 405, got %d", rr.Code)
	}

	// Without a node source there is nothing to enumerate, as for the
	// aggregate endpoint.
	bare := New(snapshot.NewFileStore(fixtureDir, "default.json"))
	if rr := get(t, bare, "/api/v1/lookup/ip/10.131.0.70", nil); rr.Code != http.StatusNotFound {
		t.Errorf("no node lister: expected 404, got %d", rr.Code)
	}
}

func TestLookupResponseIsGzippedWhenAccepted(t *testing.T) {
	srv := fixtureModeServer()
	plain := get(t, srv, "/api/v1/lookup/cidr/10.128.0.0%2F14", nil)
	if plain.Header().Get("Content-Encoding") != "" {
		t.Fatalf("a request that does not accept gzip must get the plain body")
	}
	if !strings.Contains(strings.Join(plain.Header().Values("Vary"), ","), "Accept-Encoding") {
		t.Errorf("expected Vary: Accept-Encoding, got %v", plain.Header().Values("Vary"))
	}

	zipped := get(t, srv, "/api/v1/lookup/cidr/10.128.0.0%2F14", http.Header{"Accept-Encoding": {"gzip"}})
	if zipped.Code != http.StatusOK || zipped.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("expected a gzip response, got %d %q", zipped.Code, zipped.Header().Get("Content-Encoding"))
	}
	if string(gunzip(t, zipped.Body.Bytes())) != plain.Body.String() {
		t.Fatal("the gzip body does not decode to the plain one")
	}
	if zipped.Body.Len() >= plain.Body.Len() {
		t.Errorf("gzip did not shrink the response: %d >= %d", zipped.Body.Len(), plain.Body.Len())
	}

	// Errors stay plain.
	bad := get(t, srv, "/api/v1/lookup/ip/nope", http.Header{"Accept-Encoding": {"gzip"}})
	if bad.Code != http.StatusBadRequest || bad.Header().Get("Content-Encoding") != "" {
		t.Errorf("expected a plain 400, got %d %q", bad.Code, bad.Header().Get("Content-Encoding"))
	}
}

// refusingStore fails the test when a lookup reads the fixture store.
type refusingStore struct{ t *testing.T }

func (s refusingStore) GetByNode(_ context.Context, nodeName string) (snapshot.LogicalTopologySnapshot, error) {
	s.t.Errorf("lookup read the fixture store for %s while live probing is enabled", nodeName)
	return snapshot.LogicalTopologySnapshot{}, snapshot.ErrNotFound
}

// lookupZone is a small zone holding one address on a pod port.
func lookupZone(nodeName, address string, generatedAt time.Time) snapshot.LogicalTopologySnapshot {
	zone := zoneSnapshot(nodeName)
	zone.Metadata.GeneratedAt = generatedAt
	zone.Database.LogicalSwitches = []snapshot.LogicalSwitchRow{
		{UUID: "ls-" + nodeName, Name: nodeName, PortUUIDs: []string{"lsp-" + nodeName}},
	}
	zone.Database.LogicalSwitchPorts = []snapshot.LogicalSwitchPortRow{
		{
			UUID:        "lsp-" + nodeName,
			Name:        "team-a_web-" + nodeName,
			Addresses:   []string{"0a:58:0a:14:00:05 " + address},
			ExternalIDs: map[string]string{"namespace": "team-a", "pod": "true"},
		},
	}
	return zone
}

// With live probing a lookup reads the cache and nothing else: it never
// collects, never starts the background revalidation a snapshot request
// would, and never answers from the fixture store.
func TestLookupReadsOnlyTheCacheWhenLive(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	longAgo := now.Add(-48 * time.Hour)

	collector := &countingCollector{payload: lookupZone("unused", "10.20.0.99", now)}
	cacheDir := t.TempDir()
	cache, err := snapshot.NewDiskCache(cacheDir, currentBuild)
	if err != nil {
		t.Fatalf("create cache: %v", err)
	}
	srv := NewWithLiveCollector(refusingStore{t}, collector).
		WithCache(cache, time.Minute).
		WithNodeLister(fakeLister{nodes: []string{"node-a", "node-b", "node-c"}})
	srv.now = func() time.Time { return now }

	// node-a: written by this build, far past its TTL. node-b: left on the
	// volume by another build. node-c: never collected.
	if err := cache.Put("node-a", lookupZone("node-a", "10.20.0.5", longAgo)); err != nil {
		t.Fatalf("seed node-a: %v", err)
	}
	seedEntryFromBuild(t, cacheDir, previousBuild, lookupZone("node-b", "10.20.0.5", longAgo))

	response := lookup(t, srv, "ip/10.20.0.5")

	if len(response.Zones) != 2 || response.Zones[0].Node != "node-a" || response.Zones[1].Node != "node-b" {
		t.Fatalf("expected the two cached zones, got %+v", response.Zones)
	}
	if response.Total != 2 {
		t.Fatalf("expected one hit per cached zone, got %+v", response.Hits)
	}
	for _, hit := range response.Hits {
		if !hit.SnapshotGeneratedAt.Equal(longAgo) {
			t.Errorf("hit should carry its snapshot's age, got %s", hit.SnapshotGeneratedAt)
		}
		if hit.Owner == nil || hit.Owner.Name != "web-"+hit.Node {
			t.Errorf("unexpected hit: %+v", hit)
		}
	}
	codes := warningCodes(response)
	if len(codes) != 1 || codes[0] != warningZoneNotCached || !strings.Contains(response.Warnings[0].Message, "node-c") {
		t.Fatalf("expected one %s warning naming node-c, got %+v", warningZoneNotCached, response.Warnings)
	}

	// Stale entries and a missing one: a snapshot request would collect in
	// all three cases. Give a wrongly started background refresh time to
	// show itself.
	time.Sleep(50 * time.Millisecond)
	if calls := collector.callCount(); calls != 0 {
		t.Fatalf("a lookup triggered %d live collection(s)", calls)
	}
	srv.refreshMu.Lock()
	inFlight := len(srv.refreshInFlight)
	srv.refreshMu.Unlock()
	if inFlight != 0 {
		t.Fatalf("a lookup started %d background refresh(es)", inFlight)
	}
	if _, ok := cache.GetAnyBuild("node-c"); ok {
		t.Fatal("a lookup wrote a cache entry")
	}
}

func TestLookupWithoutACacheSaysThereIsNothingToSearch(t *testing.T) {
	collector := &countingCollector{payload: lookupZone("unused", "10.20.0.5", time.Now())}
	srv := NewWithLiveCollector(refusingStore{t}, collector).
		WithNodeLister(fakeLister{nodes: []string{"node-a", "node-b"}})

	response := lookup(t, srv, "ip/10.20.0.5")
	if len(response.Zones) != 0 || response.Total != 0 || response.Hits == nil {
		t.Fatalf("expected an empty answer, got %+v", response)
	}
	if codes := warningCodes(response); len(codes) != 1 || codes[0] != warningLookupCacheDisabled {
		t.Fatalf("expected one %s warning, got %+v", warningLookupCacheDisabled, response.Warnings)
	}
	if calls := collector.callCount(); calls != 0 {
		t.Fatalf("a lookup triggered %d live collection(s)", calls)
	}
}

// Many zones are read a few at a time; every one must still be searched,
// and the answer must not depend on which read finished first.
func TestLookupOverManyZonesIsCompleteAndStable(t *testing.T) {
	generatedAt := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	cache, err := snapshot.NewDiskCache(t.TempDir(), currentBuild)
	if err != nil {
		t.Fatalf("create cache: %v", err)
	}
	nodes := []string{}
	for index := 0; index < 3*aggregateConcurrency+1; index++ {
		node := "node-" + string(rune('a'+index))
		nodes = append(nodes, node)
		if err := cache.Put(node, lookupZone(node, "10.20.0.5", generatedAt)); err != nil {
			t.Fatalf("seed %s: %v", node, err)
		}
	}
	srv := NewWithLiveCollector(refusingStore{t}, &countingCollector{}).
		WithCache(cache, time.Minute).
		WithNodeLister(fakeLister{nodes: nodes})

	first := get(t, srv, "/api/v1/lookup/mac/0a:58:0a:14:00:05", nil)
	firstBody := first.Body.String() // decoding drains the recorder
	response := decodeLookup(t, first)
	if len(response.Zones) != len(nodes) || response.Total != len(nodes) {
		t.Fatalf("expected %d zones and hits, got %d zones and %d hits", len(nodes), len(response.Zones), response.Total)
	}
	for index, hit := range response.Hits {
		if hit.Node != nodes[index] {
			t.Fatalf("hits are not in node order: %d is %s", index, hit.Node)
		}
	}
	for attempt := 0; attempt < 5; attempt++ {
		if again := get(t, srv, "/api/v1/lookup/mac/0a:58:0a:14:00:05", nil); again.Body.String() != firstBody {
			t.Fatalf("the same lookup answered differently:\n%s\n%s", firstBody, again.Body.String())
		}
	}
}
