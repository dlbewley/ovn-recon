package snapshot

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const ovsBondsSchemaPath = "../../api/ovs-bonds.schema.json"
const ovsBondsFixtureDir = "../../fixtures/ovs-bonds"

func loadOVSBondsSchema(t *testing.T) jsonObject {
	t.Helper()
	raw, err := os.ReadFile(ovsBondsSchemaPath)
	if err != nil {
		t.Fatalf("read OVS bonds schema: %v", err)
	}
	var schema jsonObject
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatalf("decode OVS bonds schema: %v", err)
	}
	return schema
}

// TestOVSBondsSchemaMatchesGoTypes keeps ovs-bonds.schema.json and the Go
// types in step both ways (ovn-recon-1tw.7): every JSON field a type emits
// is a schema property and the reverse, and a field is required exactly
// when Go always emits it.
func TestOVSBondsSchemaMatchesGoTypes(t *testing.T) {
	schema := loadOVSBondsSchema(t)
	bond := schemaAt(t, schema, "properties", "bonds", "items")

	objects := []struct {
		name   string
		schema jsonObject
		goType reflect.Type
	}{
		{"response", schema, reflect.TypeOf(OVSBondsResponse{})},
		{"metadata", schemaAt(t, schema, "properties", "metadata"), reflect.TypeOf(Metadata{})},
		{"warning", schemaAt(t, schema, "properties", "warnings", "items"), reflect.TypeOf(Warning{})},
		{"bond", bond, reflect.TypeOf(OVSBond{})},
		{"activeMember", schemaAt(t, bond, "properties", "activeMember"), reflect.TypeOf(OVSBondActiveMember{})},
		{"member", schemaAt(t, bond, "properties", "members", "items"), reflect.TypeOf(OVSBondMember{})},
	}
	for _, object := range objects {
		var fields, always []string
		for index := 0; index < object.goType.NumField(); index++ {
			field := object.goType.Field(index)
			name, options, _ := strings.Cut(field.Tag.Get("json"), ",")
			if name == "" || name == "-" {
				t.Fatalf("%s.%s has no JSON name", object.goType.Name(), field.Name)
			}
			fields = append(fields, name)
			if !strings.Contains(options, "omitempty") {
				always = append(always, name)
			}
		}

		properties := []string{}
		for name := range schemaAt(t, object.schema, "properties") {
			properties = append(properties, name)
		}
		if !reflect.DeepEqual(sorted(properties), sorted(fields)) {
			t.Errorf("%s: schema properties %v, Go fields %v", object.name, sorted(properties), sorted(fields))
		}
		if required := stringsOf(object.schema["required"]); !reflect.DeepEqual(sorted(required), sorted(always)) {
			t.Errorf("%s: schema requires %v, Go always emits %v", object.name, sorted(required), sorted(always))
		}
		if object.schema["additionalProperties"] != false {
			t.Errorf("%s: schema must set additionalProperties false", object.name)
		}
	}

	version := stringsOf(schemaAt(t, schema, "properties", "metadata", "properties", "schemaVersion")["enum"])
	if !reflect.DeepEqual(version, []string{OVSBondsSchemaVersion}) {
		t.Errorf("schemaVersion enum %v, Go %q", version, OVSBondsSchemaVersion)
	}
}

func conformsToOVSBondsSchema(t *testing.T, schema jsonObject, label string, value any) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("encode %s: %v", label, err)
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("decode %s: %v", label, err)
	}
	if problems := validateAgainst(schema, decoded, "response"); len(problems) > 0 {
		t.Errorf("%s does not conform to the schema:\n  %s", label, strings.Join(problems, "\n  "))
	}
}

// TestOVSBondsResponsesConformToSchema validates a response with every
// optional field set, one with none, the contract's own example (which
// spells an absent primary as null) and every fixture.
func TestOVSBondsResponsesConformToSchema(t *testing.T) {
	schema := loadOVSBondsSchema(t)
	yes, no := true, false
	zero, rebalance := int64(0), int64(9036)
	primary := "ens161"

	full := OVSBondsResponse{
		Metadata: Metadata{SchemaVersion: OVSBondsSchemaVersion, GeneratedAt: time.Date(2026, 11, 16, 20, 15, 0, 0, time.UTC), SourceHealth: "degraded", NodeName: "worker-1"},
		Warnings: []Warning{{Code: "LIVE_PROBE_FAILED", Message: "example"}},
		Bonds: []OVSBond{{
			Name: "bond1", Mode: "active-backup", LACPStatus: "off", LACPFallbackAB: &no, AllMembersActive: &yes,
			UpdelayMs: &zero, DowndelayMs: &zero, NextRebalanceMs: &rebalance, ActiveBackupPrimary: &primary,
			ActiveMember: &OVSBondActiveMember{Name: "ens161", MAC: "00:50:56:b4:1b:27"},
			Members: []OVSBondMember{
				{Name: "ens161", Enabled: true, Active: true, MayEnable: true},
				{Name: "ens256", Enabled: false, Active: false, MayEnable: false},
			},
		}},
	}
	conformsToOVSBondsSchema(t, schema, "full response", full)

	bare := OVSBondsResponse{
		Metadata: Metadata{SchemaVersion: OVSBondsSchemaVersion, GeneratedAt: time.Now().UTC(), SourceHealth: OVSBondsSourceHealthy, NodeName: "worker-2"},
		Warnings: []Warning{},
		Bonds:    []OVSBond{{Name: "bond0", Members: []OVSBondMember{}}},
	}
	conformsToOVSBondsSchema(t, schema, "bare response", bare)

	var example any
	if err := json.Unmarshal([]byte(contractExample), &example); err != nil {
		t.Fatalf("decode the contract example: %v", err)
	}
	if problems := validateAgainst(schema, example, "response"); len(problems) > 0 {
		t.Errorf("the contract example does not conform to the schema:\n  %s", strings.Join(problems, "\n  "))
	}

	paths, err := filepath.Glob(filepath.Join(ovsBondsFixtureDir, "*.json"))
	if err != nil || len(paths) == 0 {
		t.Fatalf("no OVS bonds fixtures found in %s: %v", ovsBondsFixtureDir, err)
	}
	fixtures := NewOVSBondFixtures(ovsBondsFixtureDir)
	for _, path := range paths {
		node := strings.TrimSuffix(filepath.Base(path), ".json")
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		var decoded any
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
		if problems := validateAgainst(schema, decoded, "response"); len(problems) > 0 {
			t.Errorf("fixture %s does not conform to the schema:\n  %s", path, strings.Join(problems, "\n  "))
		}
		payload, err := fixtures.GetByNode(node)
		if err != nil {
			t.Fatalf("load fixture %s: %v", node, err)
		}
		if payload.Metadata.NodeName != node {
			t.Errorf("fixture %s names node %q", path, payload.Metadata.NodeName)
		}
	}
}

func TestOVSBondFixturesGetByNode(t *testing.T) {
	fixtures := NewOVSBondFixtures(ovsBondsFixtureDir)
	payload, err := fixtures.GetByNode("cnv-1")
	if err != nil {
		t.Fatalf("cnv-1: %v", err)
	}
	if len(payload.Bonds) != 1 || payload.Bonds[0].Name != "bond1" || len(payload.Bonds[0].Members) != 2 {
		t.Fatalf("cnv-1 fixture should carry bond1 over two members, got %+v", payload.Bonds)
	}
	for _, node := range []string{"no-such-node", "", "../snapshots/cnv-1"} {
		if _, err := fixtures.GetByNode(node); err != ErrNotFound {
			t.Errorf("GetByNode(%q) = %v, want ErrNotFound", node, err)
		}
	}
	if _, err := NewOVSBondFixtures("").GetByNode("cnv-1"); err != ErrNotFound {
		t.Errorf("no directory should have no fixtures, got %v", err)
	}
}

// contractExample is the response in the coordinating contract for
// ovn-recon-1tw.7, verbatim.
const contractExample = `{
  "metadata": {
    "schemaVersion": "v1alpha1",
    "generatedAt": "2026-11-16T20:15:00Z",
    "sourceHealth": "ok",
    "nodeName": "worker-1"
  },
  "warnings": [],
  "bonds": [
    {
      "name": "bond1",
      "mode": "balance-slb",
      "lacpStatus": "off",
      "lacpFallbackAb": false,
      "allMembersActive": false,
      "updelayMs": 0,
      "downdelayMs": 0,
      "nextRebalanceMs": 9036,
      "activeBackupPrimary": null,
      "activeMember": { "name": "ens161", "mac": "00:50:56:b4:1b:27" },
      "members": [
        { "name": "ens161", "enabled": true, "active": true, "mayEnable": true },
        { "name": "ens256", "enabled": true, "active": false, "mayEnable": true }
      ]
    }
  ]
}`
