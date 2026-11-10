package snapshot

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"
)

const lookupSchemaPath = "../../api/lookup-response.schema.json"

type jsonObject = map[string]any

func loadLookupSchema(t *testing.T) jsonObject {
	t.Helper()
	raw, err := os.ReadFile(lookupSchemaPath)
	if err != nil {
		t.Fatalf("read lookup schema: %v", err)
	}
	var schema jsonObject
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatalf("decode lookup schema: %v", err)
	}
	return schema
}

func schemaAt(t *testing.T, schema jsonObject, path ...string) jsonObject {
	t.Helper()
	current := schema
	for _, key := range path {
		next, ok := current[key].(jsonObject)
		if !ok {
			t.Fatalf("schema has no object at %s (missing %q)", strings.Join(path, "."), key)
		}
		current = next
	}
	return current
}

func stringsOf(values any) []string {
	list, _ := values.([]any)
	out := make([]string, 0, len(list))
	for _, value := range list {
		out = append(out, fmt.Sprint(value))
	}
	return out
}

func sorted(values []string) []string {
	out := append([]string{}, values...)
	sort.Strings(out)
	return out
}

// TestLookupSchemaMatchesGoTypes keeps the schema and the Go types in step
// in both directions: every JSON field a type can emit is a schema property
// and the reverse, a field is required exactly when Go always emits it, and
// each enum lists exactly the values the Go constants define.
func TestLookupSchemaMatchesGoTypes(t *testing.T) {
	schema := loadLookupSchema(t)

	objects := []struct {
		name   string
		schema jsonObject
		goType reflect.Type
	}{
		{"response", schema, reflect.TypeOf(LookupResponse{})},
		{"query", schemaAt(t, schema, "properties", "query"), reflect.TypeOf(LookupQuery{})},
		{"hit", schemaAt(t, schema, "properties", "hits", "items"), reflect.TypeOf(LookupHit{})},
		{"construct", schemaAt(t, schema, "properties", "hits", "items", "properties", "construct"), reflect.TypeOf(LookupConstruct{})},
		{"owner", schemaAt(t, schema, "properties", "hits", "items", "properties", "owner"), reflect.TypeOf(LookupOwner{})},
		{"zone", schemaAt(t, schema, "properties", "zones", "items"), reflect.TypeOf(LookupZone{})},
		{"warning", schemaAt(t, schema, "properties", "warnings", "items"), reflect.TypeOf(Warning{})},
	}
	for _, object := range objects {
		var fields, always []string
		for index := 0; index < object.goType.NumField(); index++ {
			field := object.goType.Field(index)
			if !field.IsExported() {
				continue
			}
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

	hit := schemaAt(t, schema, "properties", "hits", "items", "properties")
	enums := []struct {
		name   string
		schema any
		goList []string
	}{
		{"kind", schemaAt(t, schema, "properties", "query", "properties", "kind")["enum"], asStrings(LookupKinds())},
		{"table", schemaAt(t, hit, "table")["enum"], asStrings(LookupTables())},
		{"matchedField", schemaAt(t, hit, "matchedField")["enum"], asStrings(LookupFields())},
		{"matchType", schemaAt(t, hit, "matchType")["enum"], asStrings(LookupMatchTypes())},
		{"construct.kind", schemaAt(t, hit, "construct", "properties", "kind")["enum"], asStrings(LookupConstructKinds())},
	}
	for _, enum := range enums {
		// Order matters where it is documented (match types, tables), so the
		// lists are compared as written.
		if got := stringsOf(enum.schema); !reflect.DeepEqual(got, enum.goList) {
			t.Errorf("%s: schema enum %v, Go values %v", enum.name, got, enum.goList)
		}
	}
}

func asStrings[T ~string](values []T) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		out = append(out, string(value))
	}
	return out
}

// validateAgainst checks a decoded JSON value against the subset of JSON
// Schema the lookup schema uses (type, required, properties,
// additionalProperties false, items, enum, minimum) and returns what does
// not conform.
func validateAgainst(schema jsonObject, value any, path string) []string {
	var problems []string
	fail := func(format string, args ...any) {
		problems = append(problems, path+": "+fmt.Sprintf(format, args...))
	}

	switch schema["type"] {
	case "object":
		object, ok := value.(jsonObject)
		if !ok {
			fail("expected an object, got %T", value)
			return problems
		}
		properties, _ := schema["properties"].(jsonObject)
		for _, name := range stringsOf(schema["required"]) {
			if _, present := object[name]; !present {
				fail("missing required %q", name)
			}
		}
		for name, child := range object {
			childSchema, known := properties[name].(jsonObject)
			if !known {
				if schema["additionalProperties"] == false {
					fail("unexpected property %q", name)
				}
				continue
			}
			problems = append(problems, validateAgainst(childSchema, child, path+"."+name)...)
		}
	case "array":
		list, ok := value.([]any)
		if !ok {
			fail("expected an array, got %T", value)
			return problems
		}
		items, _ := schema["items"].(jsonObject)
		for index, child := range list {
			problems = append(problems, validateAgainst(items, child, fmt.Sprintf("%s[%d]", path, index))...)
		}
	case "string":
		text, ok := value.(string)
		if !ok {
			fail("expected a string, got %T", value)
			return problems
		}
		if enum := stringsOf(schema["enum"]); len(enum) > 0 && !contains(enum, text) {
			fail("%q is not one of %v", text, enum)
		}
	case "integer":
		number, ok := value.(float64)
		if !ok || number != float64(int64(number)) {
			fail("expected an integer, got %v", value)
			return problems
		}
		if minimum, ok := schema["minimum"].(float64); ok && number < minimum {
			fail("%v is below the minimum %v", number, minimum)
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			fail("expected a boolean, got %T", value)
		}
	default:
		fail("schema type %v is not handled by this test", schema["type"])
	}
	return problems
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// TestLookupResponsesConformToSchema validates what the collector actually
// answers, for every kind and every optional field, against the published
// schema.
func TestLookupResponsesConformToSchema(t *testing.T) {
	schema := loadLookupSchema(t)
	zones := append(fixtureZones(t), syntheticZone())

	queries := []struct{ kind, value string }{
		{"ip", "10.131.0.70"},
		{"ip", "100.88.0.5"},
		{"ip", "172.30.0.10"},
		{"ip", "192.0.2.50"},
		{"ip", "10.20.0.7"},
		{"ip", "10.20.0.8"},
		{"ip", "fd00:30::10"},
		{"ip", "203.0.113.9"},
		{"cidr", "10.1.2.0/24"},
		{"cidr", "10.128.0.0/14"},
		{"cidr", "fd00:20::/64"},
		{"mac", "0a:58:0a:83:00:46"},
		{"mac", "0a:00:00:00:00:51"},
		{"mac", "0a:58:64:58:00:05"},
		{"name", "openshift"},
		{"name", "example-p-cudn"},
		{"name", "team-a"},
	}

	seenFields := map[LookupField]bool{}
	seenTypes := map[LookupMatchType]bool{}
	seenTables := map[LookupTable]bool{}
	for _, query := range queries {
		response := Lookup(mustQuery(t, query.kind, query.value), zones, 0)
		response.Warnings = append(response.Warnings, Warning{Code: "ZONE_NOT_CACHED", Message: "example"})
		for _, hit := range response.Hits {
			seenFields[hit.MatchedField] = true
			seenTypes[hit.MatchType] = true
			seenTables[hit.Table] = true
		}

		raw, err := json.Marshal(response)
		if err != nil {
			t.Fatalf("encode %s/%s: %v", query.kind, query.value, err)
		}
		var decoded any
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Fatalf("decode %s/%s: %v", query.kind, query.value, err)
		}
		if problems := validateAgainst(schema, decoded, "response"); len(problems) > 0 {
			t.Errorf("%s/%s does not conform to the schema:\n  %s", query.kind, query.value, strings.Join(problems[:min(len(problems), 10)], "\n  "))
		}
	}

	// The queries above are only a fair test if between them they exercise
	// every value the contract enumerates.
	for _, field := range LookupFields() {
		if !seenFields[field] {
			t.Errorf("no query in this test matched on field %q", field)
		}
	}
	for _, matchType := range LookupMatchTypes() {
		if !seenTypes[matchType] {
			t.Errorf("no query in this test produced match type %q", matchType)
		}
	}
	for _, table := range LookupTables() {
		if !seenTables[table] {
			t.Errorf("no query in this test hit table %q", table)
		}
	}
}
