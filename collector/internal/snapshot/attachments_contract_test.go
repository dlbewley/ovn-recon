package snapshot

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

const attachmentsSchemaPath = "../../api/network-attachments.schema.json"

func loadAttachmentsSchema(t *testing.T) jsonObject {
	t.Helper()
	raw, err := os.ReadFile(attachmentsSchemaPath)
	if err != nil {
		t.Fatalf("read network attachments schema: %v", err)
	}
	var schema jsonObject
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatalf("decode network attachments schema: %v", err)
	}
	return schema
}

// TestAttachmentsSchemaMatchesGoTypes keeps the schema and the Go types in step
// both ways: every JSON field is a schema property and the reverse, and a field
// is required exactly when Go always emits it.
func TestAttachmentsSchemaMatchesGoTypes(t *testing.T) {
	schema := loadAttachmentsSchema(t)
	network := schemaAt(t, schema, "properties", "networks", "items")

	objects := []struct {
		name   string
		schema jsonObject
		goType reflect.Type
	}{
		{"attachments", schema, reflect.TypeOf(NetworkAttachments{})},
		{"metadata", schemaAt(t, schema, "properties", "metadata"), reflect.TypeOf(ClusterMetadata{})},
		{"warning", schemaAt(t, schema, "properties", "warnings", "items"), reflect.TypeOf(Warning{})},
		{"network", network, reflect.TypeOf(AttachedNetwork{})},
		{"node", schemaAt(t, network, "properties", "nodes", "items"), reflect.TypeOf(AttachedNode{})},
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
	if !reflect.DeepEqual(version, []string{AttachmentsSchemaVersion}) {
		t.Errorf("schemaVersion enum %v, Go %q", version, AttachmentsSchemaVersion)
	}
}

func TestAttachmentsConformToSchema(t *testing.T) {
	schema := loadAttachmentsSchema(t)
	zones, networks := CountAttachments([]LogicalTopologySnapshot{attachmentZone("worker-1", SourceHealthy,
		podPort("demo.net_blue_web-1", "blue", "blue/net"),
	)})
	payload := NetworkAttachments{
		Metadata: ClusterMetadata{SchemaVersion: AttachmentsSchemaVersion, GeneratedAt: time.Date(2026, 11, 18, 9, 0, 0, 0, time.UTC), SourceHealth: SourceHealthy},
		Zones:    zones,
		Networks: networks,
		Warnings: []Warning{{Code: "ZONE_COLLECTION_FAILED", Message: "worker-2"}},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if problems := validateAgainst(schema, decoded, "attachments"); len(problems) > 0 {
		t.Errorf("payload does not conform to the schema:\n  %s", strings.Join(problems, "\n  "))
	}
}

func podPort(name, namespace, nad string) LogicalSwitchPortRow {
	ids := map[string]string{portExternalIDPod: "true", portExternalIDNamespace: namespace}
	if nad != "" {
		ids[portExternalIDNAD] = nad
	}
	return LogicalSwitchPortRow{UUID: name, Name: name, ExternalIDs: ids}
}

func attachmentZone(node, health string, ports ...LogicalSwitchPortRow) LogicalTopologySnapshot {
	return LogicalTopologySnapshot{
		Metadata: Metadata{NodeName: node, SourceHealth: health},
		Database: &LogicalDatabase{LogicalSwitchPorts: ports},
	}
}

func TestCountAttachmentsPerNetworkAndNode(t *testing.T) {
	remote := podPort("demo.net_blue_web-9", "blue", "blue/net")
	remote.Type = "remote"
	zones, networks := CountAttachments([]LogicalTopologySnapshot{
		attachmentZone("worker-b", SourceHealthy,
			podPort("demo.net_blue_web-1", "blue", "blue/net"),
			// A second port of the same pod on the same network counts once.
			podPort("demo.net_blue_web-1", "blue", "blue/net"),
			podPort("demo.net_blue_virt-launcher-db-x7k2p", "blue", "blue/net"),
			remote,
			// The default network's ports name no NAD.
			podPort("blue_web-1", "blue", ""),
			LogicalSwitchPortRow{Name: "k8s-worker-b"},
		),
		attachmentZone("worker-a", "",
			podPort("demo.net_blue_web-2", "blue", "blue/net"),
			podPort("other_red_api-1", "red", "red/other"),
		),
	})

	if want := []string{"worker-a", "worker-b"}; !reflect.DeepEqual(zones, want) {
		t.Fatalf("zones %v, want %v", zones, want)
	}
	want := []AttachedNetwork{
		{NAD: "blue/net", Nodes: []AttachedNode{
			{NodeName: "worker-a", Pods: 1},
			{NodeName: "worker-b", Pods: 1, VirtLaunchers: 1},
		}},
		{NAD: "red/other", Nodes: []AttachedNode{{NodeName: "worker-a", Pods: 1}}},
	}
	if !reflect.DeepEqual(networks, want) {
		t.Fatalf("networks %#v, want %#v", networks, want)
	}
}

// TestCountAttachmentsLeavesOutDegradedZones: a degraded zone serves fixture
// data, so it is neither counted nor named as counted.
func TestCountAttachmentsLeavesOutDegradedZones(t *testing.T) {
	zones, networks := CountAttachments([]LogicalTopologySnapshot{
		attachmentZone("worker-a", SourceDegraded, podPort("n_blue_web-1", "blue", "blue/net")),
		{Metadata: Metadata{NodeName: "worker-b", SourceHealth: SourceHealthy}},
	})
	if len(zones) != 0 || len(networks) != 0 {
		t.Fatalf("zones %v, networks %#v, want neither", zones, networks)
	}
	if zones == nil || networks == nil {
		t.Fatalf("zones and networks must encode as [], not null")
	}
}
