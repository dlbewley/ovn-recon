package probe

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
)

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

func ParseLogicalRouters(raw string) ([]snapshot.LogicalRouterRow, bool, error) {
	rows, normalized, err := parseTableRows(raw)
	if err != nil {
		return nil, false, err
	}

	routers := make([]snapshot.LogicalRouterRow, 0, len(rows))
	for _, row := range rows {
		routers = append(routers, snapshot.LogicalRouterRow{
			UUID:             stringField(row, "_uuid"),
			Name:             stringField(row, "name"),
			PortUUIDs:        stringSliceField(row, "ports"),
			NATUUIDs:         stringSliceField(row, "nat"),
			StaticRouteUUIDs: stringSliceField(row, "static_routes"),
			Options:          stringMapField(row, "options"),
			ExternalIDs:      stringMapField(row, "external_ids"),
		})
	}
	return routers, normalized, nil
}

func ParseLogicalRouterPorts(raw string) ([]snapshot.LogicalRouterPortRow, bool, error) {
	rows, normalized, err := parseTableRows(raw)
	if err != nil {
		return nil, false, err
	}

	ports := make([]snapshot.LogicalRouterPortRow, 0, len(rows))
	for _, row := range rows {
		ports = append(ports, snapshot.LogicalRouterPortRow{
			UUID:                stringField(row, "_uuid"),
			Name:                stringField(row, "name"),
			MAC:                 stringField(row, "mac"),
			Networks:            stringSliceField(row, "networks"),
			Peer:                optionalStringField(row, "peer"),
			GatewayChassisUUIDs: stringSliceField(row, "gateway_chassis"),
			Options:             stringMapField(row, "options"),
			ExternalIDs:         stringMapField(row, "external_ids"),
		})
	}
	return ports, normalized, nil
}

func ParseLogicalSwitches(raw string) ([]snapshot.LogicalSwitchRow, bool, error) {
	rows, normalized, err := parseTableRows(raw)
	if err != nil {
		return nil, false, err
	}

	switches := make([]snapshot.LogicalSwitchRow, 0, len(rows))
	for _, row := range rows {
		switches = append(switches, snapshot.LogicalSwitchRow{
			UUID:        stringField(row, "_uuid"),
			Name:        stringField(row, "name"),
			PortUUIDs:   stringSliceField(row, "ports"),
			OtherConfig: stringMapField(row, "other_config"),
			ExternalIDs: stringMapField(row, "external_ids"),
		})
	}
	return switches, normalized, nil
}

func ParseLogicalSwitchPorts(raw string) ([]snapshot.LogicalSwitchPortRow, bool, error) {
	rows, normalized, err := parseTableRows(raw)
	if err != nil {
		return nil, false, err
	}

	ports := make([]snapshot.LogicalSwitchPortRow, 0, len(rows))
	for _, row := range rows {
		ports = append(ports, snapshot.LogicalSwitchPortRow{
			UUID:        stringField(row, "_uuid"),
			Name:        stringField(row, "name"),
			Type:        stringField(row, "type"),
			Addresses:   stringSliceField(row, "addresses"),
			Tag:         optionalStringField(row, "tag"),
			Options:     stringMapField(row, "options"),
			ExternalIDs: stringMapField(row, "external_ids"),
		})
	}
	return ports, normalized, nil
}

func ParseNATs(raw string) ([]snapshot.NATRow, bool, error) {
	rows, normalized, err := parseTableRows(raw)
	if err != nil {
		return nil, false, err
	}

	nats := make([]snapshot.NATRow, 0, len(rows))
	for _, row := range rows {
		nats = append(nats, snapshot.NATRow{
			UUID:        stringField(row, "_uuid"),
			Type:        stringField(row, "type"),
			ExternalIP:  stringField(row, "external_ip"),
			LogicalIP:   stringField(row, "logical_ip"),
			LogicalPort: optionalStringField(row, "logical_port"),
			ExternalMAC: optionalStringField(row, "external_mac"),
			Options:     stringMapField(row, "options"),
			ExternalIDs: stringMapField(row, "external_ids"),
		})
	}
	return nats, normalized, nil
}

func ParseStaticRoutes(raw string) ([]snapshot.StaticRouteRow, bool, error) {
	rows, normalized, err := parseTableRows(raw)
	if err != nil {
		return nil, false, err
	}

	routes := make([]snapshot.StaticRouteRow, 0, len(rows))
	for _, row := range rows {
		routes = append(routes, snapshot.StaticRouteRow{
			UUID:        stringField(row, "_uuid"),
			IPPrefix:    stringField(row, "ip_prefix"),
			Nexthop:     stringField(row, "nexthop"),
			Policy:      optionalStringField(row, "policy"),
			OutputPort:  optionalStringField(row, "output_port"),
			Options:     stringMapField(row, "options"),
			ExternalIDs: stringMapField(row, "external_ids"),
		})
	}
	return routes, normalized, nil
}

// ParseChassisBridgeMappings extracts localnet-to-bridge mappings from the
// local chassis rows' other_config:ovn-bridge-mappings, whose value is a
// comma-separated list of "localnet:bridge" pairs.
func ParseChassisBridgeMappings(raw string) ([]snapshot.BridgeMappingRow, bool, error) {
	rows, normalized, err := parseTableRows(raw)
	if err != nil {
		return nil, false, err
	}

	mappings := []snapshot.BridgeMappingRow{}
	seen := map[string]bool{}
	for _, row := range rows {
		otherConfig := stringMapField(row, "other_config")
		for _, pair := range strings.Split(otherConfig["ovn-bridge-mappings"], ",") {
			pair = strings.TrimSpace(pair)
			if pair == "" {
				continue
			}
			separator := strings.Index(pair, ":")
			if separator <= 0 || separator == len(pair)-1 {
				continue
			}
			mapping := snapshot.BridgeMappingRow{
				Localnet: pair[:separator],
				Bridge:   pair[separator+1:],
			}
			key := mapping.Localnet + ":" + mapping.Bridge
			if seen[key] {
				continue
			}
			seen[key] = true
			mappings = append(mappings, mapping)
		}
	}

	sort.Slice(mappings, func(i, j int) bool { return mappings[i].Localnet < mappings[j].Localnet })
	return mappings, normalized, nil
}

func stringField(row map[string]any, key string) string {
	return asString(row[key])
}

// optionalStringField reads an OVSDB optional scalar, which arrives as a
// bare value when present and as an empty (or single-element) set when not.
func optionalStringField(row map[string]any, key string) string {
	raw, ok := row[key]
	if !ok {
		return ""
	}
	if items, isSlice := raw.([]any); isSlice {
		if len(items) == 0 {
			return ""
		}
		return asString(items[0])
	}
	return asString(raw)
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
