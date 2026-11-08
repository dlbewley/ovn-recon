package snapshot

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// Section names an optional group of database tables. The collector reads
// and caches every table in one pass; a response carries a section only when
// the request asks for it with ?include=<section>[,<section>], so the ladder
// views keep their payload while the detail views opt in to the bulk
// (ovn-recon-e2b.9).
type Section string

const (
	// SectionPolicy is ACL, Port_Group and Address_Set (database.acls,
	// portGroups, addressSets).
	SectionPolicy Section = "policy"
	// SectionServices is Load_Balancer and Load_Balancer_Group
	// (database.loadBalancers, loadBalancerGroups).
	SectionServices Section = "services"
)

// sectionKeys maps each section to the database keys it gates. It is the
// single registry: ParseSections validates against it and the contract test
// checks it against LogicalDatabase's JSON tags.
var sectionKeys = map[Section][]string{
	SectionPolicy:   {"acls", "portGroups", "addressSets"},
	SectionServices: {"loadBalancers", "loadBalancerGroups"},
}

// Sections lists the valid section names, sorted.
func Sections() []Section {
	names := make([]Section, 0, len(sectionKeys))
	for name := range sectionKeys {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool { return names[i] < names[j] })
	return names
}

// SectionKeys returns the database keys a section gates.
func SectionKeys(section Section) []string {
	return append([]string(nil), sectionKeys[section]...)
}

// SectionSet is the set of sections a request asked for. The zero value
// (nil) requests none, which is the default response.
type SectionSet map[Section]bool

// Has reports whether the section was requested.
func (s SectionSet) Has(section Section) bool { return s[section] }

// ParseSections reads the values of an include query parameter. Each value
// is a comma-separated list, and the parameter may repeat; blanks are
// ignored, so "include=" requests nothing. An unknown name is an error that
// lists the valid ones.
func ParseSections(values []string) (SectionSet, error) {
	var set SectionSet
	for _, value := range values {
		for _, name := range strings.Split(value, ",") {
			name = strings.TrimSpace(name)
			if name == "" {
				continue
			}
			section := Section(name)
			if _, ok := sectionKeys[section]; !ok {
				valid := make([]string, 0, len(sectionKeys))
				for _, known := range Sections() {
					valid = append(valid, string(known))
				}
				return nil, fmt.Errorf("unknown include section %q; valid sections: %s", name, strings.Join(valid, ", "))
			}
			if set == nil {
				set = SectionSet{}
			}
			set[section] = true
		}
	}
	return set, nil
}

// Project returns the snapshot as a response for the requested sections:
// every section that was not requested is dropped from the database. The
// input is not modified (cached and collected payloads are shared), and a
// snapshot without a database passes through unchanged.
func Project(payload LogicalTopologySnapshot, sections SectionSet) LogicalTopologySnapshot {
	payload.Database = payload.Database.project(sections)
	return payload
}

func (db *LogicalDatabase) project(sections SectionSet) *LogicalDatabase {
	if db == nil {
		return nil
	}
	projected := *db
	if !sections.Has(SectionPolicy) {
		projected.ACLs = nil
		projected.PortGroups = nil
		projected.AddressSets = nil
	}
	if !sections.Has(SectionServices) {
		projected.LoadBalancers = nil
		projected.LoadBalancerGroups = nil
	}
	return &projected
}

// MarshalJSON keeps the difference between a section that is absent (nil:
// not requested, or not collected) and one that is collected and empty
// (non-nil, zero rows: emitted as []). encoding/json's omitempty drops both,
// so the section fields are re-declared here as pointers, which omitempty
// drops only when nil. The shallower fields shadow the embedded ones of the
// same JSON name; every other field encodes exactly as before.
//
// With go >= 1.24 in go.mod this method can be replaced by `omitzero` on the
// five fields.
func (db LogicalDatabase) MarshalJSON() ([]byte, error) {
	type plain LogicalDatabase
	wire := struct {
		plain
		ACLs               *[]SectionRow `json:"acls,omitempty"`
		PortGroups         *[]SectionRow `json:"portGroups,omitempty"`
		AddressSets        *[]SectionRow `json:"addressSets,omitempty"`
		LoadBalancers      *[]SectionRow `json:"loadBalancers,omitempty"`
		LoadBalancerGroups *[]SectionRow `json:"loadBalancerGroups,omitempty"`
	}{plain: plain(db)}
	wire.ACLs = presentRows(db.ACLs)
	wire.PortGroups = presentRows(db.PortGroups)
	wire.AddressSets = presentRows(db.AddressSets)
	wire.LoadBalancers = presentRows(db.LoadBalancers)
	wire.LoadBalancerGroups = presentRows(db.LoadBalancerGroups)
	return json.Marshal(wire)
}

func presentRows[T any](rows []T) *[]T {
	if rows == nil {
		return nil
	}
	return &rows
}
