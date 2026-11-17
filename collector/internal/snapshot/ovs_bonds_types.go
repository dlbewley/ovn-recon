package snapshot

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// The OVS bond contract: the response of GET /api/v1/ovs/bonds/{node},
// the runtime state of the bonds that live inside a node's OVS bridges
// (ovn-recon-1tw.7). NodeNetworkState reports a bond's configuration but
// none of this. Mirrored by collector/api/ovs-bonds.schema.json and by the
// plugin's types in src/types.ts; ovs_bonds_contract_test.go keeps the
// schema and these types in step.
//
// Unlike a zone snapshot this is never cached: the active member and the
// rebalance timer move, and one ovs-appctl exec is cheap.

// OVSBondsSchemaVersion is metadata.schemaVersion of an OVS bonds response.
const OVSBondsSchemaVersion = "v1alpha1"

// A response read live says SourceHealthy; one served from a fixture after a
// failed probe says SourceDegraded, as a zone snapshot does. Collectors before
// ovn-recon-8cv said "ok" for a live answer; the plugin still reads that.

// OVSBondsResponse is one node's OVS bonds, as ovs-appctl bond/show prints
// them. Bonds is empty, never absent, on a node without OVS bonds.
type OVSBondsResponse struct {
	Metadata Metadata  `json:"metadata"`
	Warnings []Warning `json:"warnings"`
	Bonds    []OVSBond `json:"bonds"`
}

// OVSBond is one ---- <name> ---- block of bond/show. Every field but Name
// and Members is absent when OVS did not print its line (next rebalance,
// for one, is printed only for a balancing mode).
type OVSBond struct {
	Name string `json:"name"`
	// Mode is bond_mode: active-backup, balance-slb or balance-tcp.
	Mode string `json:"mode,omitempty"`
	// LACPStatus is lacp_status: off, negotiated or configured.
	LACPStatus       string `json:"lacpStatus,omitempty"`
	LACPFallbackAB   *bool  `json:"lacpFallbackAb,omitempty"`
	AllMembersActive *bool  `json:"allMembersActive,omitempty"`
	UpdelayMs        *int64 `json:"updelayMs,omitempty"`
	DowndelayMs      *int64 `json:"downdelayMs,omitempty"`
	NextRebalanceMs  *int64 `json:"nextRebalanceMs,omitempty"`
	// ActiveBackupPrimary is the configured primary member; absent when OVS
	// prints <none>.
	ActiveBackupPrimary *string `json:"activeBackupPrimary,omitempty"`
	// ActiveMember is absent when no member is active.
	ActiveMember *OVSBondActiveMember `json:"activeMember,omitempty"`
	// Members keeps OVS's order.
	Members []OVSBondMember `json:"members"`
}

// OVSBondActiveMember is the "active member mac: <mac>(<member>)" line.
type OVSBondActiveMember struct {
	Name string `json:"name"`
	MAC  string `json:"mac"`
}

// OVSBondMember is one "member <name>: enabled|disabled" block.
type OVSBondMember struct {
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
	// Active is true when the block carries an "active member" line.
	Active bool `json:"active"`
	// MayEnable is may_enable: whether OVS would enable the member (carrier
	// up, LACP agreeing), which can differ from Enabled during updelay.
	MayEnable bool `json:"mayEnable"`
}

// OVSBondFixtures reads per-node OVS bonds responses from JSON files
// (<dir>/<node>.json), the fallback when a live probe fails and the whole
// answer when the collector runs without a cluster. There is no default
// file: a node without a fixture has no bonds to invent.
type OVSBondFixtures struct {
	dir string
}

// NewOVSBondFixtures reads fixtures from dir; an empty dir has none.
func NewOVSBondFixtures(dir string) *OVSBondFixtures {
	return &OVSBondFixtures{dir: dir}
}

// GetByNode returns the node's fixture, or ErrNotFound.
func (f *OVSBondFixtures) GetByNode(nodeName string) (OVSBondsResponse, error) {
	if f == nil || f.dir == "" || nodeName == "" || filepath.Base(nodeName) != nodeName {
		return OVSBondsResponse{}, ErrNotFound
	}
	path := filepath.Join(f.dir, nodeName+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return OVSBondsResponse{}, ErrNotFound
		}
		return OVSBondsResponse{}, err
	}
	var payload OVSBondsResponse
	if err := json.Unmarshal(data, &payload); err != nil {
		return OVSBondsResponse{}, fmt.Errorf("decode OVS bonds fixture %s: %w", path, err)
	}
	if payload.Metadata.NodeName == "" {
		payload.Metadata.NodeName = nodeName
	}
	if payload.Warnings == nil {
		payload.Warnings = []Warning{}
	}
	if payload.Bonds == nil {
		payload.Bonds = []OVSBond{}
	}
	return payload, nil
}
