package probe

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
)

// capturedBondShow is `ovs-appctl bond/show` from OVS 3.5.2 on an OpenShift
// 5.0.1 node (ovn-recon-1tw.7), with the MAC rewritten to the fixture NIC.
const capturedBondShow = `---- bond1 ----
bond_mode: balance-slb
bond may use recirculation: no, Recirc-ID : -1
bond-hash-basis: 0
lb_output action: disabled, bond-id: -1
all members active: false
updelay: 0 ms
downdelay: 0 ms
next rebalance: 9036 ms
lacp_status: off
lacp_fallback_ab: false
active-backup primary: <none>
active member mac: 00:50:56:b4:1b:27(ens161)

member ens161: enabled
  active member
  may_enable: true

member ens256: enabled
  may_enable: true

`

func boolPtr(value bool) *bool       { return &value }
func int64Ptr(value int64) *int64    { return &value }
func stringPtr(value string) *string { return &value }

func TestParseOVSBondShow(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want []snapshot.OVSBond
	}{
		{
			name: "captured balance-slb sample",
			raw:  capturedBondShow,
			want: []snapshot.OVSBond{{
				Name:             "bond1",
				Mode:             "balance-slb",
				LACPStatus:       "off",
				LACPFallbackAB:   boolPtr(false),
				AllMembersActive: boolPtr(false),
				UpdelayMs:        int64Ptr(0),
				DowndelayMs:      int64Ptr(0),
				NextRebalanceMs:  int64Ptr(9036),
				ActiveMember:     &snapshot.OVSBondActiveMember{Name: "ens161", MAC: "00:50:56:b4:1b:27"},
				Members: []snapshot.OVSBondMember{
					{Name: "ens161", Enabled: true, Active: true, MayEnable: true},
					{Name: "ens256", Enabled: true, Active: false, MayEnable: true},
				},
			}},
		},
		{
			name: "active-backup with a primary and no rebalance line",
			raw: `---- bond0 ----
bond_mode: active-backup
bond may use recirculation: no, Recirc-ID : -1
bond-hash-basis: 0
lb_output action: disabled, bond-id: -1
all members active: false
updelay: 100 ms
downdelay: 200 ms
lacp_status: off
lacp_fallback_ab: false
active-backup primary: ens5
active member mac: 0A:58:0A:00:00:05(ens5)

member ens5: enabled
  active member
  may_enable: true

member ens6: enabled
  may_enable: true
`,
			want: []snapshot.OVSBond{{
				Name:                "bond0",
				Mode:                "active-backup",
				LACPStatus:          "off",
				LACPFallbackAB:      boolPtr(false),
				AllMembersActive:    boolPtr(false),
				UpdelayMs:           int64Ptr(100),
				DowndelayMs:         int64Ptr(200),
				ActiveBackupPrimary: stringPtr("ens5"),
				ActiveMember:        &snapshot.OVSBondActiveMember{Name: "ens5", MAC: "0a:58:0a:00:00:05"},
				Members: []snapshot.OVSBondMember{
					{Name: "ens5", Enabled: true, Active: true, MayEnable: true},
					{Name: "ens6", Enabled: true, Active: false, MayEnable: true},
				},
			}},
		},
		{
			name: "a member disabled that may not enable",
			raw: `---- bond1 ----
bond_mode: balance-slb
active member mac: 00:50:56:b4:1b:27(ens161)

member ens161: enabled
  active member
  may_enable: true

member ens256: disabled
  may_enable: false
`,
			want: []snapshot.OVSBond{{
				Name:         "bond1",
				Mode:         "balance-slb",
				ActiveMember: &snapshot.OVSBondActiveMember{Name: "ens161", MAC: "00:50:56:b4:1b:27"},
				Members: []snapshot.OVSBondMember{
					{Name: "ens161", Enabled: true, Active: true, MayEnable: true},
					{Name: "ens256", Enabled: false, Active: false, MayEnable: false},
				},
			}},
		},
		{
			name: "two bonds keep their order and their own members",
			raw: `---- bond-a ----
bond_mode: balance-tcp
lacp_status: negotiated
active member mac: 02:00:00:00:00:01(eth1)

member eth1: enabled
  active member
  may_enable: true

---- bond-b ----
bond_mode: active-backup
active member mac: 02:00:00:00:00:03(eth3)

member eth3: enabled
  active member
  may_enable: true

member eth4: enabled
  may_enable: true
`,
			want: []snapshot.OVSBond{
				{
					Name: "bond-a", Mode: "balance-tcp", LACPStatus: "negotiated",
					ActiveMember: &snapshot.OVSBondActiveMember{Name: "eth1", MAC: "02:00:00:00:00:01"},
					Members:      []snapshot.OVSBondMember{{Name: "eth1", Enabled: true, Active: true, MayEnable: true}},
				},
				{
					Name: "bond-b", Mode: "active-backup",
					ActiveMember: &snapshot.OVSBondActiveMember{Name: "eth3", MAC: "02:00:00:00:00:03"},
					Members: []snapshot.OVSBondMember{
						{Name: "eth3", Enabled: true, Active: true, MayEnable: true},
						{Name: "eth4", Enabled: true, Active: false, MayEnable: true},
					},
				},
			},
		},
		{
			name: "empty output is a node without bonds",
			raw:  "",
			want: []snapshot.OVSBond{},
		},
		{
			name: "blank lines only",
			raw:  "\n\n  \n",
			want: []snapshot.OVSBond{},
		},
		{
			name: "none values leave fields absent",
			raw: `---- bond1 ----
bond_mode: active-backup
active-backup primary: <none>
active member mac: <none>

member ens161: disabled
  may_enable: false
`,
			want: []snapshot.OVSBond{{
				Name: "bond1", Mode: "active-backup",
				Members: []snapshot.OVSBondMember{{Name: "ens161", Enabled: false, Active: false, MayEnable: false}},
			}},
		},
		{
			name: "OVS's own no-active-member spelling",
			raw: `---- bond1 ----
active member mac: 00:00:00:00:00:00(none)

member ens161: disabled
  may_enable: false
`,
			want: []snapshot.OVSBond{{
				Name:    "bond1",
				Members: []snapshot.OVSBondMember{{Name: "ens161"}},
			}},
		},
		{
			name: "junk, hash loads, SLB MACs and LACP details are skipped",
			raw: `ovs-appctl banner before any bond
---- bond1 ----
bond_mode: balance-slb
some future field: 42
updelay: soon ms
all members active: maybe
this line has no colon

member ens161: enabled
  active member
  may_enable: true
  hash 12: 3 kB load
    00:50:56:aa:bb:cc
  lacp actor: whatever
  may_enable: sometimes

member ens256: enabled
  may_enable: true
  hash 200: 0 kB load
member broken line without state
lacp_fallback_ab: true
`,
			want: []snapshot.OVSBond{{
				Name:           "bond1",
				Mode:           "balance-slb",
				LACPFallbackAB: boolPtr(true),
				Members: []snapshot.OVSBondMember{
					{Name: "ens161", Enabled: true, Active: true, MayEnable: true},
					{Name: "ens256", Enabled: true, Active: false, MayEnable: true},
				},
			}},
		},
		{
			name: "the older slave spelling",
			raw: `---- bond1 ----
bond_mode: active-backup
all slaves active: true
active slave mac: 00:50:56:b4:1b:27(ens161)

slave ens161: enabled
	active slave
	may_enable: true
`,
			want: []snapshot.OVSBond{{
				Name: "bond1", Mode: "active-backup", AllMembersActive: boolPtr(true),
				ActiveMember: &snapshot.OVSBondActiveMember{Name: "ens161", MAC: "00:50:56:b4:1b:27"},
				Members:      []snapshot.OVSBondMember{{Name: "ens161", Enabled: true, Active: true, MayEnable: true}},
			}},
		},
		{
			name: "CRLF line endings",
			raw:  "---- bond1 ----\r\nbond_mode: balance-slb\r\n\r\nmember ens161: enabled\r\n  active member\r\n  may_enable: true\r\n",
			want: []snapshot.OVSBond{{
				Name: "bond1", Mode: "balance-slb",
				Members: []snapshot.OVSBondMember{{Name: "ens161", Enabled: true, Active: true, MayEnable: true}},
			}},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := ParseOVSBondShow(test.raw)
			if !reflect.DeepEqual(got, test.want) {
				gotJSON, _ := json.MarshalIndent(got, "", "  ")
				wantJSON, _ := json.MarshalIndent(test.want, "", "  ")
				t.Fatalf("ParseOVSBondShow mismatch\ngot:  %s\nwant: %s", gotJSON, wantJSON)
			}
		})
	}
}

// TestParseOVSBondShowMatchesContractExample: the captured sample encodes
// to exactly the bonds of the contract's example response, which spells
// the absent primary as null where Go omits it.
func TestParseOVSBondShowMatchesContractExample(t *testing.T) {
	encoded, err := json.Marshal(ParseOVSBondShow(capturedBondShow))
	if err != nil {
		t.Fatal(err)
	}
	var got, want any
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(`[{
		"name": "bond1", "mode": "balance-slb", "lacpStatus": "off", "lacpFallbackAb": false,
		"allMembersActive": false, "updelayMs": 0, "downdelayMs": 0, "nextRebalanceMs": 9036,
		"activeMember": { "name": "ens161", "mac": "00:50:56:b4:1b:27" },
		"members": [
			{ "name": "ens161", "enabled": true, "active": true, "mayEnable": true },
			{ "name": "ens256", "enabled": true, "active": false, "mayEnable": true }
		]
	}]`), &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("encoded bonds %s differ from the contract example", encoded)
	}
}
