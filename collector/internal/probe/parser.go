package probe

import (
	"encoding/json"
	"fmt"
	"strings"
)

// LogicalRouter models the minimum fields needed for logical topology assembly.
type LogicalRouter struct {
	UUID      string
	Name      string
	PortUUIDs []string
}

// LogicalRouterPort models the minimum fields needed for logical topology assembly.
type LogicalRouterPort struct {
	UUID string
	Name string
}

// LogicalSwitch models the minimum fields needed for logical topology assembly.
type LogicalSwitch struct {
	UUID      string
	Name      string
	PortUUIDs []string
}

// LogicalSwitchPort models the minimum fields needed for logical topology assembly.
type LogicalSwitchPort struct {
	UUID    string
	Name    string
	Type    string
	Options map[string]string
}

type tablePayload struct {
	Headings []string `json:"headings"`
	Data     [][]any  `json:"data"`
}

func parseTableRows(raw string) ([]map[string]any, bool, error) {
	payload, normalized, err := decodeTablePayload(raw)
	if err != nil {
		return nil, false, err
	}

	rows := make([]map[string]any, 0, len(payload.Data))
	for rowIndex, row := range payload.Data {
		if len(row) != len(payload.Headings) {
			return nil, normalized, fmt.Errorf("row %d has %d values but %d headings", rowIndex, len(row), len(payload.Headings))
		}

		mapped := make(map[string]any, len(row))
		for i, heading := range payload.Headings {
			mapped[heading] = decodeOVSValue(row[i])
		}
		rows = append(rows, mapped)
	}

	return rows, normalized, nil
}

func decodeTablePayload(raw string) (tablePayload, bool, error) {
	var payload tablePayload
	if err := json.Unmarshal([]byte(raw), &payload); err == nil {
		return payload, false, nil
	}

	// Some OVN command paths emit pseudo-JSON with single quotes.
	normalizedRaw := strings.ReplaceAll(raw, "'", `"`)
	if normalizedRaw == raw {
		return tablePayload{}, false, fmt.Errorf("decode table payload")
	}

	if err := json.Unmarshal([]byte(normalizedRaw), &payload); err != nil {
		return tablePayload{}, false, fmt.Errorf("decode normalized table payload: %w", err)
	}

	return payload, true, nil
}

func decodeOVSValue(value any) any {
	switch typed := value.(type) {
	case []any:
		if len(typed) == 2 {
			tag, ok := typed[0].(string)
			if ok {
				switch tag {
				case "uuid":
					return asString(typed[1])
				case "set":
					items, ok := typed[1].([]any)
					if !ok {
						return []any{}
					}
					decoded := make([]any, 0, len(items))
					for _, item := range items {
						decoded = append(decoded, decodeOVSValue(item))
					}
					return decoded
				case "map":
					pairs, ok := typed[1].([]any)
					if !ok {
						return map[string]any{}
					}
					decoded := map[string]any{}
					for _, pair := range pairs {
						kv, ok := pair.([]any)
						if !ok || len(kv) != 2 {
							continue
						}
						key := fmt.Sprintf("%v", decodeOVSValue(kv[0]))
						decoded[key] = decodeOVSValue(kv[1])
					}
					return decoded
				}
			}
		}

		decoded := make([]any, 0, len(typed))
		for _, item := range typed {
			decoded = append(decoded, decodeOVSValue(item))
		}
		return decoded
	case map[string]any:
		decoded := map[string]any{}
		for key, item := range typed {
			decoded[key] = decodeOVSValue(item)
		}
		return decoded
	default:
		return value
	}
}

func ParseLogicalRouters(raw string) ([]LogicalRouter, bool, error) {
	rows, normalized, err := parseTableRows(raw)
	if err != nil {
		return nil, false, err
	}

	routers := make([]LogicalRouter, 0, len(rows))
	for _, row := range rows {
		routers = append(routers, LogicalRouter{
			UUID:      stringField(row, "_uuid"),
			Name:      stringField(row, "name"),
			PortUUIDs: stringSliceField(row, "ports"),
		})
	}
	return routers, normalized, nil
}

func ParseLogicalRouterPorts(raw string) ([]LogicalRouterPort, bool, error) {
	rows, normalized, err := parseTableRows(raw)
	if err != nil {
		return nil, false, err
	}

	ports := make([]LogicalRouterPort, 0, len(rows))
	for _, row := range rows {
		ports = append(ports, LogicalRouterPort{
			UUID: stringField(row, "_uuid"),
			Name: stringField(row, "name"),
		})
	}
	return ports, normalized, nil
}

func ParseLogicalSwitches(raw string) ([]LogicalSwitch, bool, error) {
	rows, normalized, err := parseTableRows(raw)
	if err != nil {
		return nil, false, err
	}

	switches := make([]LogicalSwitch, 0, len(rows))
	for _, row := range rows {
		switches = append(switches, LogicalSwitch{
			UUID:      stringField(row, "_uuid"),
			Name:      stringField(row, "name"),
			PortUUIDs: stringSliceField(row, "ports"),
		})
	}
	return switches, normalized, nil
}

func ParseLogicalSwitchPorts(raw string) ([]LogicalSwitchPort, bool, error) {
	rows, normalized, err := parseTableRows(raw)
	if err != nil {
		return nil, false, err
	}

	ports := make([]LogicalSwitchPort, 0, len(rows))
	for _, row := range rows {
		ports = append(ports, LogicalSwitchPort{
			UUID:    stringField(row, "_uuid"),
			Name:    stringField(row, "name"),
			Type:    stringField(row, "type"),
			Options: stringMapField(row, "options"),
		})
	}
	return ports, normalized, nil
}

func stringField(row map[string]any, key string) string {
	return asString(row[key])
}

func stringSliceField(row map[string]any, key string) []string {
	raw, ok := row[key]
	if !ok {
		return []string{}
	}
	items, ok := raw.([]any)
	if !ok {
		if asString(raw) == "" {
			return []string{}
		}
		return []string{asString(raw)}
	}

	out := make([]string, 0, len(items))
	for _, item := range items {
		value := asString(item)
		if value == "" {
			continue
		}
		out = append(out, value)
	}
	return out
}

func stringMapField(row map[string]any, key string) map[string]string {
	raw, ok := row[key]
	if !ok {
		return map[string]string{}
	}
	mapped, ok := raw.(map[string]any)
	if !ok {
		return map[string]string{}
	}

	out := map[string]string{}
	for mapKey, mapValue := range mapped {
		out[mapKey] = asString(mapValue)
	}
	return out
}

func asString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case fmt.Stringer:
		return typed.String()
	case nil:
		return ""
	default:
		return fmt.Sprintf("%v", typed)
	}
}
