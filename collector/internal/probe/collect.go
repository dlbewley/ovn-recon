package probe

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
)

var (
	logicalRouterCommand     = []string{"ovn-nbctl", "--format=json", "list", "Logical_Router"}
	logicalRouterPortCommand = []string{"ovn-nbctl", "--format=json", "list", "Logical_Router_Port"}
	logicalSwitchCommand     = []string{"ovn-nbctl", "--format=json", "list", "Logical_Switch"}
	logicalSwitchPortCommand = []string{"ovn-nbctl", "--format=json", "list", "Logical_Switch_Port"}
	natCommand               = []string{"ovn-nbctl", "--format=json", "list", "NAT"}
	staticRouteCommand       = []string{"ovn-nbctl", "--format=json", "list", "Logical_Router_Static_Route"}
	// Bridge mappings live on the local chassis in the Southbound database;
	// exec target resolution finds the container where ovn-sbctl works.
	chassisCommand = []string{"ovn-sbctl", "--format=json", "--columns=other_config", "find", "Chassis", "other_config:is-remote=false"}
)

var (
	defaultCollectOptionsMu sync.RWMutex
	defaultCollectOptions   = CollectOptions{
		Logger:             slog.Default(),
		IncludeProbeOutput: false,
	}
)

// CollectOptions controls collector probe logging behavior.
type CollectOptions struct {
	Logger             *slog.Logger
	IncludeProbeOutput bool
}

// SetDefaultCollectOptions updates process-wide defaults for probe collection logging.
func SetDefaultCollectOptions(opts CollectOptions) {
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	defaultCollectOptionsMu.Lock()
	defaultCollectOptions = opts
	defaultCollectOptionsMu.Unlock()
}

func getDefaultCollectOptions() CollectOptions {
	defaultCollectOptionsMu.RLock()
	opts := defaultCollectOptions
	defaultCollectOptionsMu.RUnlock()
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	return opts
}

// Runner executes OVN commands.
type Runner interface {
	Run(ctx context.Context, command []string) (string, error)
}

// CollectSnapshot builds a logical topology snapshot from OVN NB command outputs.
func CollectSnapshot(ctx context.Context, runner Runner, nodeName string, now time.Time) (snapshot.LogicalTopologySnapshot, error) {
	return CollectSnapshotWithOptions(ctx, runner, nodeName, now, getDefaultCollectOptions())
}

// CollectSnapshotWithOptions builds a logical topology snapshot with explicit logging options.
func CollectSnapshotWithOptions(ctx context.Context, runner Runner, nodeName string, now time.Time, opts CollectOptions) (snapshot.LogicalTopologySnapshot, error) {
	database, warnings := collectDatabase(ctx, runner, opts)

	// Deprecated v1 graph payload, retained until the placeholder renderer is
	// replaced (ovn-recon-kck.7).
	nodes, edges := buildGraph(database.LogicalRouters, database.LogicalRouterPorts, database.LogicalSwitches, database.LogicalSwitchPorts)

	sourceHealth := "healthy"
	if len(warnings) > 0 {
		sourceHealth = "degraded"
	}

	return snapshot.LogicalTopologySnapshot{
		Metadata: snapshot.Metadata{
			SchemaVersion: snapshot.SchemaVersionV2,
			GeneratedAt:   now.UTC(),
			SourceHealth:  sourceHealth,
			NodeName:      nodeName,
		},
		Database: database,
		Nodes:    nodes,
		Edges:    edges,
		Groups:   []snapshot.Group{},
		Warnings: warnings,
	}, nil
}

type warningSink struct {
	warnings []snapshot.Warning
	added    map[string]bool
}

func (s *warningSink) append(code, message string) {
	if s.added == nil {
		s.added = map[string]bool{}
	}
	if s.added[code+message] {
		return
	}
	s.warnings = append(s.warnings, snapshot.Warning{Code: code, Message: message})
	s.added[code+message] = true
}

// collectTable runs one probe command and parses its table, reporting
// failures as warnings so one bad table degrades rather than aborts.
func collectTable[T any](
	ctx context.Context,
	runner Runner,
	opts CollectOptions,
	resource string,
	command []string,
	parse func(string) ([]T, bool, error),
	sink *warningSink,
) []T {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}

	logger.Debug("running OVN probe command", "resource", resource, "command", strings.Join(command, " "))
	raw, err := runner.Run(ctx, command)
	if err != nil {
		logger.Warn("OVN probe command failed", "resource", resource, "error", err)
		sink.append("COMMAND_FAILED", fmt.Sprintf("%s command failed: %v", resource, err))
		return []T{}
	}

	logProbeOutput(logger, opts.IncludeProbeOutput, command, raw)
	rows, normalized, parseErr := parse(raw)
	if parseErr != nil {
		logger.Warn("OVN probe parser failed", "resource", resource, "error", parseErr)
		logProbeParseContext(logger, opts.IncludeProbeOutput, raw)
		sink.append("PARSER_FAILED", fmt.Sprintf("%s parse failed: %v", resource, parseErr))
		return []T{}
	}
	if normalized {
		logger.Debug("OVN probe parser normalized input", "resource", resource)
		sink.append("PARSER_NORMALIZED", "Input required normalization due to inconsistent OVN command output")
	}
	return rows
}

func collectDatabase(ctx context.Context, runner Runner, opts CollectOptions) (*snapshot.LogicalDatabase, []snapshot.Warning) {
	sink := &warningSink{}

	database := &snapshot.LogicalDatabase{
		LogicalRouters:     collectTable(ctx, runner, opts, "Logical_Router", logicalRouterCommand, ParseLogicalRouters, sink),
		LogicalRouterPorts: collectTable(ctx, runner, opts, "Logical_Router_Port", logicalRouterPortCommand, ParseLogicalRouterPorts, sink),
		LogicalSwitches:    collectTable(ctx, runner, opts, "Logical_Switch", logicalSwitchCommand, ParseLogicalSwitches, sink),
		LogicalSwitchPorts: collectTable(ctx, runner, opts, "Logical_Switch_Port", logicalSwitchPortCommand, ParseLogicalSwitchPorts, sink),
		NATs:               collectTable(ctx, runner, opts, "NAT", natCommand, ParseNATs, sink),
		StaticRoutes:       collectTable(ctx, runner, opts, "Logical_Router_Static_Route", staticRouteCommand, ParseStaticRoutes, sink),
		BridgeMappings:     collectTable(ctx, runner, opts, "Chassis", chassisCommand, ParseChassisBridgeMappings, sink),
	}

	warnings := sink.warnings
	if warnings == nil {
		warnings = []snapshot.Warning{}
	}
	return database, warnings
}

func buildGraph(
	routers []snapshot.LogicalRouterRow,
	routerPorts []snapshot.LogicalRouterPortRow,
	switches []snapshot.LogicalSwitchRow,
	switchPorts []snapshot.LogicalSwitchPortRow,
) ([]snapshot.Node, []snapshot.Edge) {
	nodes := map[string]snapshot.Node{}
	edges := map[string]snapshot.Edge{}

	routerPortByUUID := map[string]snapshot.LogicalRouterPortRow{}
	for _, port := range routerPorts {
		routerPortByUUID[port.UUID] = port
	}

	routerIDByRouterPortName := map[string]string{}
	for _, router := range routers {
		routerNodeID := firstNonEmpty(router.UUID, router.Name)
		nodes[routerNodeID] = snapshot.Node{
			ID:    routerNodeID,
			Kind:  "logical_router",
			Label: firstNonEmpty(router.Name, routerNodeID),
			Data: map[string]interface{}{
				"uuid": router.UUID,
			},
		}
		for _, portUUID := range router.PortUUIDs {
			if port, ok := routerPortByUUID[portUUID]; ok && port.Name != "" {
				routerIDByRouterPortName[port.Name] = routerNodeID
			}
		}
	}

	switchIDByPortUUID := map[string]string{}
	for _, logicalSwitch := range switches {
		switchNodeID := firstNonEmpty(logicalSwitch.UUID, logicalSwitch.Name)
		nodes[switchNodeID] = snapshot.Node{
			ID:    switchNodeID,
			Kind:  "logical_switch",
			Label: firstNonEmpty(logicalSwitch.Name, switchNodeID),
			Data: map[string]interface{}{
				"uuid": logicalSwitch.UUID,
			},
		}
		for _, portUUID := range logicalSwitch.PortUUIDs {
			switchIDByPortUUID[portUUID] = switchNodeID
		}
	}

	for _, port := range switchPorts {
		portNodeID := firstNonEmpty(port.UUID, port.Name)
		nodes[portNodeID] = snapshot.Node{
			ID:    portNodeID,
			Kind:  "logical_switch_port",
			Label: firstNonEmpty(port.Name, portNodeID),
			Data: map[string]interface{}{
				"uuid":    port.UUID,
				"type":    port.Type,
				"options": port.Options,
			},
		}

		if switchNodeID, ok := switchIDByPortUUID[port.UUID]; ok {
			edgeID := edgeKey("switch_to_port", switchNodeID, portNodeID)
			edges[edgeID] = snapshot.Edge{
				ID:     edgeID,
				Source: switchNodeID,
				Target: portNodeID,
				Kind:   "switch_to_port",
			}
		}

		if port.Type == "router" {
			routerPortName := port.Options["router-port"]
			routerNodeID, hasRouter := routerIDByRouterPortName[routerPortName]
			switchNodeID, hasSwitch := switchIDByPortUUID[port.UUID]
			if hasRouter && hasSwitch {
				edgeID := edgeKey("router_to_switch", routerNodeID, switchNodeID)
				edges[edgeID] = snapshot.Edge{
					ID:     edgeID,
					Source: routerNodeID,
					Target: switchNodeID,
					Kind:   "router_to_switch",
				}
			}
		}
	}

	orderedNodes := make([]snapshot.Node, 0, len(nodes))
	for _, node := range nodes {
		orderedNodes = append(orderedNodes, node)
	}
	sort.Slice(orderedNodes, func(i, j int) bool {
		return orderedNodes[i].ID < orderedNodes[j].ID
	})

	orderedEdges := make([]snapshot.Edge, 0, len(edges))
	for _, edge := range edges {
		orderedEdges = append(orderedEdges, edge)
	}
	sort.Slice(orderedEdges, func(i, j int) bool {
		return orderedEdges[i].ID < orderedEdges[j].ID
	})

	return orderedNodes, orderedEdges
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func edgeKey(kind, source, target string) string {
	return fmt.Sprintf("%s:%s:%s", kind, source, target)
}

func logProbeOutput(logger *slog.Logger, includeProbeOutput bool, command []string, output string) {
	if includeProbeOutput {
		// Intentionally log full probe output when explicitly enabled for debugging.
		logger.Debug("OVN probe command output", "command", strings.Join(command, " "), "output", output)
		return
	}
	logger.Debug("OVN probe command completed", "command", strings.Join(command, " "), "outputBytes", len(output))
}

func logProbeParseContext(logger *slog.Logger, includeProbeOutput bool, output string) {
	if includeProbeOutput {
		// Intentionally log full parse context when explicitly enabled for debugging.
		logger.Debug("OVN probe parser input", "output", output)
		return
	}
	logger.Debug("OVN probe parser input", "outputBytes", len(output))
}
