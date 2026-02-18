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
	routers, routerPorts, switches, switchPorts, warnings, err := collectResources(ctx, runner, opts)
	if err != nil {
		return snapshot.LogicalTopologySnapshot{}, err
	}

	nodes, edges := buildGraph(routers, routerPorts, switches, switchPorts)
	sourceHealth := "healthy"
	if len(warnings) > 0 {
		sourceHealth = "degraded"
	}

	return snapshot.LogicalTopologySnapshot{
		Metadata: snapshot.Metadata{
			SchemaVersion: "v1alpha1",
			GeneratedAt:   now.UTC(),
			SourceHealth:  sourceHealth,
			NodeName:      nodeName,
		},
		Nodes:    nodes,
		Edges:    edges,
		Groups:   []snapshot.Group{},
		Warnings: warnings,
	}, nil
}

func collectResources(ctx context.Context, runner Runner, opts CollectOptions) ([]LogicalRouter, []LogicalRouterPort, []LogicalSwitch, []LogicalSwitchPort, []snapshot.Warning, error) {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	warnings := []snapshot.Warning{}
	addedWarnings := map[string]bool{}

	appendWarning := func(code, message string) {
		if addedWarnings[code+message] {
			return
		}
		warnings = append(warnings, snapshot.Warning{Code: code, Message: message})
		addedWarnings[code+message] = true
	}

	routers := []LogicalRouter{}
	logger.Debug("running OVN probe command", "resource", "Logical_Router", "command", strings.Join(logicalRouterCommand, " "))
	rawRouters, err := runner.Run(ctx, logicalRouterCommand)
	if err != nil {
		logger.Warn("OVN probe command failed", "resource", "Logical_Router", "error", err)
		appendWarning("COMMAND_FAILED", fmt.Sprintf("Logical_Router command failed: %v", err))
	} else {
		logProbeOutput(logger, opts.IncludeProbeOutput, logicalRouterCommand, rawRouters)
		parsedRouters, normalized, parseErr := ParseLogicalRouters(rawRouters)
		if parseErr != nil {
			logger.Warn("OVN probe parser failed", "resource", "Logical_Router", "error", parseErr)
			logProbeParseContext(logger, opts.IncludeProbeOutput, rawRouters)
			appendWarning("PARSER_FAILED", fmt.Sprintf("Logical_Router parse failed: %v", parseErr))
		} else {
			routers = parsedRouters
			if normalized {
				logger.Debug("OVN probe parser normalized input", "resource", "Logical_Router")
				appendWarning("PARSER_NORMALIZED", "Input required normalization due to inconsistent OVN command output")
			}
		}
	}

	routerPorts := []LogicalRouterPort{}
	logger.Debug("running OVN probe command", "resource", "Logical_Router_Port", "command", strings.Join(logicalRouterPortCommand, " "))
	rawRouterPorts, err := runner.Run(ctx, logicalRouterPortCommand)
	if err != nil {
		logger.Warn("OVN probe command failed", "resource", "Logical_Router_Port", "error", err)
		appendWarning("COMMAND_FAILED", fmt.Sprintf("Logical_Router_Port command failed: %v", err))
	} else {
		logProbeOutput(logger, opts.IncludeProbeOutput, logicalRouterPortCommand, rawRouterPorts)
		parsedRouterPorts, normalized, parseErr := ParseLogicalRouterPorts(rawRouterPorts)
		if parseErr != nil {
			logger.Warn("OVN probe parser failed", "resource", "Logical_Router_Port", "error", parseErr)
			logProbeParseContext(logger, opts.IncludeProbeOutput, rawRouterPorts)
			appendWarning("PARSER_FAILED", fmt.Sprintf("Logical_Router_Port parse failed: %v", parseErr))
		} else {
			routerPorts = parsedRouterPorts
			if normalized {
				logger.Debug("OVN probe parser normalized input", "resource", "Logical_Router_Port")
				appendWarning("PARSER_NORMALIZED", "Input required normalization due to inconsistent OVN command output")
			}
		}
	}

	switches := []LogicalSwitch{}
	logger.Debug("running OVN probe command", "resource", "Logical_Switch", "command", strings.Join(logicalSwitchCommand, " "))
	rawSwitches, err := runner.Run(ctx, logicalSwitchCommand)
	if err != nil {
		logger.Warn("OVN probe command failed", "resource", "Logical_Switch", "error", err)
		appendWarning("COMMAND_FAILED", fmt.Sprintf("Logical_Switch command failed: %v", err))
	} else {
		logProbeOutput(logger, opts.IncludeProbeOutput, logicalSwitchCommand, rawSwitches)
		parsedSwitches, normalized, parseErr := ParseLogicalSwitches(rawSwitches)
		if parseErr != nil {
			logger.Warn("OVN probe parser failed", "resource", "Logical_Switch", "error", parseErr)
			logProbeParseContext(logger, opts.IncludeProbeOutput, rawSwitches)
			appendWarning("PARSER_FAILED", fmt.Sprintf("Logical_Switch parse failed: %v", parseErr))
		} else {
			switches = parsedSwitches
			if normalized {
				logger.Debug("OVN probe parser normalized input", "resource", "Logical_Switch")
				appendWarning("PARSER_NORMALIZED", "Input required normalization due to inconsistent OVN command output")
			}
		}
	}

	switchPorts := []LogicalSwitchPort{}
	logger.Debug("running OVN probe command", "resource", "Logical_Switch_Port", "command", strings.Join(logicalSwitchPortCommand, " "))
	rawSwitchPorts, err := runner.Run(ctx, logicalSwitchPortCommand)
	if err != nil {
		logger.Warn("OVN probe command failed", "resource", "Logical_Switch_Port", "error", err)
		appendWarning("COMMAND_FAILED", fmt.Sprintf("Logical_Switch_Port command failed: %v", err))
	} else {
		logProbeOutput(logger, opts.IncludeProbeOutput, logicalSwitchPortCommand, rawSwitchPorts)
		parsedSwitchPorts, normalized, parseErr := ParseLogicalSwitchPorts(rawSwitchPorts)
		if parseErr != nil {
			logger.Warn("OVN probe parser failed", "resource", "Logical_Switch_Port", "error", parseErr)
			logProbeParseContext(logger, opts.IncludeProbeOutput, rawSwitchPorts)
			appendWarning("PARSER_FAILED", fmt.Sprintf("Logical_Switch_Port parse failed: %v", parseErr))
		} else {
			switchPorts = parsedSwitchPorts
			if normalized {
				logger.Debug("OVN probe parser normalized input", "resource", "Logical_Switch_Port")
				appendWarning("PARSER_NORMALIZED", "Input required normalization due to inconsistent OVN command output")
			}
		}
	}

	return routers, routerPorts, switches, switchPorts, warnings, nil
}

func buildGraph(
	routers []LogicalRouter,
	routerPorts []LogicalRouterPort,
	switches []LogicalSwitch,
	switchPorts []LogicalSwitchPort,
) ([]snapshot.Node, []snapshot.Edge) {
	nodes := map[string]snapshot.Node{}
	edges := map[string]snapshot.Edge{}

	routerPortByUUID := map[string]LogicalRouterPort{}
	for _, port := range routerPorts {
		routerPortByUUID[port.UUID] = port
	}

	routerIDByRouterPortName := map[string]string{}
	for _, router := range routers {
		routerNodeID := routerNodeID(router)
		nodes[routerNodeID] = snapshot.Node{
			ID:    routerNodeID,
			Kind:  "logical_router",
			Label: labelOrID(router.Name, routerNodeID),
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
		switchNodeID := switchNodeID(logicalSwitch)
		nodes[switchNodeID] = snapshot.Node{
			ID:    switchNodeID,
			Kind:  "logical_switch",
			Label: labelOrID(logicalSwitch.Name, switchNodeID),
			Data: map[string]interface{}{
				"uuid": logicalSwitch.UUID,
			},
		}
		for _, portUUID := range logicalSwitch.PortUUIDs {
			switchIDByPortUUID[portUUID] = switchNodeID
		}
	}

	for _, port := range switchPorts {
		portNodeID := switchPortNodeID(port)
		nodes[portNodeID] = snapshot.Node{
			ID:    portNodeID,
			Kind:  "logical_switch_port",
			Label: labelOrID(port.Name, portNodeID),
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

func routerNodeID(router LogicalRouter) string {
	if strings.TrimSpace(router.UUID) != "" {
		return router.UUID
	}
	return strings.TrimSpace(router.Name)
}

func switchNodeID(logicalSwitch LogicalSwitch) string {
	if strings.TrimSpace(logicalSwitch.UUID) != "" {
		return logicalSwitch.UUID
	}
	return strings.TrimSpace(logicalSwitch.Name)
}

func switchPortNodeID(port LogicalSwitchPort) string {
	if strings.TrimSpace(port.UUID) != "" {
		return port.UUID
	}
	return strings.TrimSpace(port.Name)
}

func labelOrID(label, id string) string {
	if strings.TrimSpace(label) != "" {
		return label
	}
	return id
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
