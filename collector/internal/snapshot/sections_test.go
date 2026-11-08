package snapshot

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func TestParseSections(t *testing.T) {
	cases := []struct {
		name   string
		values []string
		want   []Section
	}{
		{name: "parameter absent", values: nil, want: nil},
		{name: "empty value", values: []string{""}, want: nil},
		{name: "one section", values: []string{"policy"}, want: []Section{SectionPolicy}},
		{name: "comma separated", values: []string{"policy,services"}, want: []Section{SectionPolicy, SectionServices}},
		{name: "repeated parameter", values: []string{"services", "policy"}, want: []Section{SectionPolicy, SectionServices}},
		{name: "blanks and duplicates", values: []string{" policy , ,policy"}, want: []Section{SectionPolicy}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseSections(tc.values)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for _, section := range tc.want {
				if !got.Has(section) {
					t.Fatalf("got %v, want %v", got, tc.want)
				}
			}
		})
	}
}

func TestParseSectionsRejectsUnknownNamesListingTheValidOnes(t *testing.T) {
	for _, values := range [][]string{{"bogus"}, {"policy,bogus"}, {"policy", "Policy"}} {
		_, err := ParseSections(values)
		if err == nil {
			t.Fatalf("expected an error for %v", values)
		}
		if !strings.Contains(err.Error(), "valid sections: policy, services") {
			t.Fatalf("error must list the valid sections, got %q", err)
		}
	}
}

func fullDatabase() *LogicalDatabase {
	row := []SectionRow{{"uuid": "u1", "name": "n1"}}
	return &LogicalDatabase{
		LogicalRouters:     []LogicalRouterRow{{UUID: "lr", Name: "lr", PortUUIDs: []string{}}},
		LogicalRouterPorts: []LogicalRouterPortRow{},
		LogicalSwitches:    []LogicalSwitchRow{},
		LogicalSwitchPorts: []LogicalSwitchPortRow{},
		NATs:               []NATRow{},
		StaticRoutes:       []StaticRouteRow{},
		BridgeMappings:     []BridgeMappingRow{{Localnet: "physnet", Bridge: "br-ex"}},
		GatewayChassis:     []GatewayChassisRow{{UUID: "gc", Name: "gc"}},
		NBGlobal:           &NBGlobalRow{UUID: "nb"},
		ACLs:               row,
		PortGroups:         row,
		AddressSets:        row,
		LoadBalancers:      row,
		LoadBalancerGroups: row,
	}
}

func databaseKeys(t *testing.T, db *LogicalDatabase) []string {
	t.Helper()
	raw, err := json.Marshal(db)
	if err != nil {
		t.Fatalf("marshal database: %v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("decode database: %v", err)
	}
	keys := make([]string, 0, len(decoded))
	for key := range decoded {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func without(keys []string, drop ...string) []string {
	dropped := map[string]bool{}
	for _, key := range drop {
		dropped[key] = true
	}
	kept := []string{}
	for _, key := range keys {
		if !dropped[key] {
			kept = append(kept, key)
		}
	}
	return kept
}

// TestProjectGatesExactlyTheRegisteredKeys ties the three places a section
// is spelled together: the registry, the projection and the JSON tags.
func TestProjectGatesExactlyTheRegisteredKeys(t *testing.T) {
	full := Project(LogicalTopologySnapshot{Database: fullDatabase()}, SectionSet{SectionPolicy: true, SectionServices: true})
	all := databaseKeys(t, full.Database)

	policyKeys := SectionKeys(SectionPolicy)
	serviceKeys := SectionKeys(SectionServices)
	if len(policyKeys) != 3 || len(serviceKeys) != 2 {
		t.Fatalf("unexpected registry: policy %v, services %v", policyKeys, serviceKeys)
	}
	for _, key := range append(policyKeys, serviceKeys...) {
		if len(without(all, key)) != len(all)-1 {
			t.Fatalf("section key %q is not a database JSON key (have %v)", key, all)
		}
	}

	cases := []struct {
		name     string
		sections SectionSet
		want     []string
	}{
		{name: "none", sections: nil, want: without(all, append(policyKeys, serviceKeys...)...)},
		{name: "policy", sections: SectionSet{SectionPolicy: true}, want: without(all, serviceKeys...)},
		{name: "services", sections: SectionSet{SectionServices: true}, want: without(all, policyKeys...)},
		{name: "both", sections: SectionSet{SectionPolicy: true, SectionServices: true}, want: all},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := databaseKeys(t, Project(LogicalTopologySnapshot{Database: fullDatabase()}, tc.sections).Database)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("database keys = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestProjectDoesNotModifyItsInput(t *testing.T) {
	stored := LogicalTopologySnapshot{Database: fullDatabase()}
	projected := Project(stored, nil)

	if projected.Database == stored.Database {
		t.Fatal("projection must copy the database, cached payloads are shared")
	}
	if stored.Database.ACLs == nil || stored.Database.LoadBalancers == nil {
		t.Fatal("projection stripped the stored snapshot")
	}
	if projected.Database.ACLs != nil || projected.Database.LoadBalancerGroups != nil {
		t.Fatal("projection kept a section that was not requested")
	}

	if got := Project(LogicalTopologySnapshot{}, SectionSet{SectionPolicy: true}); got.Database != nil {
		t.Fatal("a snapshot without a database must pass through")
	}
}

// TestSectionEncodingSeparatesAbsentFromEmpty pins the contract: an absent
// key means "not requested or not collected", [] means "collected and empty".
func TestSectionEncodingSeparatesAbsentFromEmpty(t *testing.T) {
	db := &LogicalDatabase{
		ACLs:          []SectionRow{},
		LoadBalancers: []SectionRow{{"uuid": "lb"}},
	}
	raw, err := json.Marshal(LogicalTopologySnapshot{Database: db})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded struct {
		Database map[string]json.RawMessage `json:"database"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}

	if got := string(decoded.Database["acls"]); got != "[]" {
		t.Fatalf("a collected, empty section must encode as [], got %q", got)
	}
	if got := string(decoded.Database["loadBalancers"]); got != `[{"uuid":"lb"}]` {
		t.Fatalf("unexpected loadBalancers encoding %q", got)
	}
	for _, key := range []string{"portGroups", "addressSets", "loadBalancerGroups"} {
		if _, present := decoded.Database[key]; present {
			t.Fatalf("nil section %q must be absent, got %s", key, raw)
		}
	}

	// The distinction survives the cache's encode/decode round trip.
	var roundTripped LogicalTopologySnapshot
	if err := json.Unmarshal(raw, &roundTripped); err != nil {
		t.Fatalf("round trip decode: %v", err)
	}
	if roundTripped.Database.ACLs == nil || len(roundTripped.Database.ACLs) != 0 {
		t.Fatalf("empty section did not round trip: %#v", roundTripped.Database.ACLs)
	}
	if roundTripped.Database.PortGroups != nil {
		t.Fatalf("absent section did not round trip: %#v", roundTripped.Database.PortGroups)
	}
}

// TestDatabaseEncodingIsUnchangedWithoutSections proves the custom marshaler
// is invisible to today's consumers: every fixture encodes to the same bytes
// as the plain struct encoding it replaced.
func TestDatabaseEncodingIsUnchangedWithoutSections(t *testing.T) {
	type plainDatabase LogicalDatabase
	type plainSnapshot struct {
		Metadata Metadata       `json:"metadata"`
		Database *plainDatabase `json:"database,omitempty"`
		Nodes    []Node         `json:"nodes"`
		Edges    []Edge         `json:"edges"`
		Groups   []Group        `json:"groups"`
		Warnings []Warning      `json:"warnings"`
	}

	entries, err := os.ReadDir(fixtureDir)
	if err != nil {
		t.Fatalf("read fixture dir: %v", err)
	}
	checked := 0
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		checked++
		raw, err := os.ReadFile(filepath.Join(fixtureDir, entry.Name()))
		if err != nil {
			t.Fatalf("read fixture: %v", err)
		}
		var snap LogicalTopologySnapshot
		if err := json.Unmarshal(raw, &snap); err != nil {
			t.Fatalf("decode %s: %v", entry.Name(), err)
		}
		var plain plainSnapshot
		if err := json.Unmarshal(raw, &plain); err != nil {
			t.Fatalf("decode %s as plain: %v", entry.Name(), err)
		}

		var got, want bytes.Buffer
		if err := json.NewEncoder(&got).Encode(Project(snap, nil)); err != nil {
			t.Fatalf("encode %s: %v", entry.Name(), err)
		}
		if err := json.NewEncoder(&want).Encode(plain); err != nil {
			t.Fatalf("encode %s as plain: %v", entry.Name(), err)
		}
		if !bytes.Equal(got.Bytes(), want.Bytes()) {
			t.Fatalf("%s: encoding changed (%d bytes, want %d)", entry.Name(), got.Len(), want.Len())
		}
	}
	if checked == 0 {
		t.Fatal("no fixtures found")
	}
}
