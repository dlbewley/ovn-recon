package snapshot

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

const statusSchemaPath = "../../api/collector-status.schema.json"

func loadStatusSchema(t *testing.T) jsonObject {
	t.Helper()
	raw, err := os.ReadFile(statusSchemaPath)
	if err != nil {
		t.Fatalf("read collector status schema: %v", err)
	}
	var schema jsonObject
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatalf("decode collector status schema: %v", err)
	}
	return schema
}

// TestStatusSchemaMatchesGoTypes keeps collector-status.schema.json and the
// Go types in step both ways (ovn-recon-1zx): every JSON field a type emits
// is a schema property and the reverse, and a field is required exactly when
// Go always emits it.
func TestStatusSchemaMatchesGoTypes(t *testing.T) {
	schema := loadStatusSchema(t)
	zone := schemaAt(t, schema, "properties", "zones", "items")

	objects := []struct {
		name   string
		schema jsonObject
		goType reflect.Type
	}{
		{"status", schema, reflect.TypeOf(CollectorStatus{})},
		{"metadata", schemaAt(t, schema, "properties", "metadata"), reflect.TypeOf(ClusterMetadata{})},
		{"warning", schemaAt(t, schema, "properties", "warnings", "items"), reflect.TypeOf(Warning{})},
		{"zone", zone, reflect.TypeOf(ZoneStatus{})},
		{"zone warning", schemaAt(t, zone, "properties", "warnings", "items"), reflect.TypeOf(Warning{})},
		{"warmUp", schemaAt(t, schema, "properties", "warmUp"), reflect.TypeOf(WarmUp{})},
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
	if !reflect.DeepEqual(version, []string{StatusSchemaVersion}) {
		t.Errorf("schemaVersion enum %v, Go %q", version, StatusSchemaVersion)
	}
}

// TestStatusConformsToSchema validates a status with every optional field
// set, and one with none.
func TestStatusConformsToSchema(t *testing.T) {
	schema := loadStatusSchema(t)
	at := time.Date(2026, 11, 17, 9, 0, 0, 0, time.UTC)
	cases := map[string]CollectorStatus{
		"full": {
			Metadata: ClusterMetadata{SchemaVersion: StatusSchemaVersion, GeneratedAt: at, SourceHealth: SourceDegraded},
			Zones: []ZoneStatus{{
				NodeName: "worker-1", GeneratedAt: at, SourceHealth: SourceHealthy, OVNVersion: "24.09.2-71.el9fdp",
				Warnings: []Warning{{Code: "COLLECTOR_WARMING", Message: "warming"}},
			}},
			Warnings: []Warning{{Code: "ZONE_COLLECTION_FAILED", Message: "worker-2"}},
			WarmUp:   &WarmUp{Nodes: 3, Done: 1},
		},
		"bare": {
			Metadata: ClusterMetadata{SchemaVersion: StatusSchemaVersion, GeneratedAt: at, SourceHealth: SourceHealthy},
			Zones:    []ZoneStatus{ZoneStatusOf(LogicalTopologySnapshot{Metadata: Metadata{NodeName: "worker-1", GeneratedAt: at}})},
			Warnings: []Warning{},
		},
	}
	for label, status := range cases {
		raw, err := json.Marshal(status)
		if err != nil {
			t.Fatalf("encode %s: %v", label, err)
		}
		var decoded any
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Fatalf("decode %s: %v", label, err)
		}
		if problems := validateAgainst(schema, decoded, "status"); len(problems) > 0 {
			t.Errorf("%s does not conform to the schema:\n  %s", label, strings.Join(problems, "\n  "))
		}
	}
}

func TestZoneStatusOfReadsTheOVNVersion(t *testing.T) {
	payload := LogicalTopologySnapshot{
		Metadata: Metadata{NodeName: "worker-1", SourceHealth: SourceHealthy},
		Database: &LogicalDatabase{NBGlobal: &NBGlobalRow{Options: map[string]string{"northd_internal_version": "24.09.2-71.el9fdp"}}},
	}
	status := ZoneStatusOf(payload)
	if status.OVNVersion != "24.09.2-71.el9fdp" || status.NodeName != "worker-1" {
		t.Fatalf("unexpected zone status %#v", status)
	}
	if status.Warnings == nil {
		t.Fatalf("warnings must encode as [], not null")
	}
}
