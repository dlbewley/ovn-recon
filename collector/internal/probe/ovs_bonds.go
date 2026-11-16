package probe

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
)

// ovsBondShowCommand prints every bond on the node: bond/show with no
// argument covers them all, so one exec answers a request (ovn-recon-1tw.7).
// --timeout bounds the wait on ovs-vswitchd's control socket inside the
// pod, which the exec's own context cannot reach.
var ovsBondShowCommand = []string{"ovs-appctl", "--timeout=10", "bond/show"}

// NodeLocalRunnerFactory resolves a runner that executes only on the named
// node. A host-level command must not fall back to another node's pod.
type NodeLocalRunnerFactory interface {
	NodeLocalRunnerForNode(nodeName string) (Runner, error)
}

// OVSBondCollector reads a node's OVS bond runtime state live.
type OVSBondCollector struct {
	runnerFactory      NodeLocalRunnerFactory
	logger             *slog.Logger
	includeProbeOutput bool
}

// NewOVSBondCollector constructs a live OVS bond collector.
func NewOVSBondCollector(factory NodeLocalRunnerFactory, logger *slog.Logger, includeProbeOutput bool) *OVSBondCollector {
	if logger == nil {
		logger = slog.Default()
	}
	return &OVSBondCollector{runnerFactory: factory, logger: logger, includeProbeOutput: includeProbeOutput}
}

// CollectOVSBonds runs bond/show in the node's ovnkube-node pod (the
// ovn-controller container first, see orderTargetsForCommand) and parses
// it. A node without OVS bonds returns an empty list and no error.
func (c *OVSBondCollector) CollectOVSBonds(ctx context.Context, nodeName string) ([]snapshot.OVSBond, error) {
	runner, err := c.runnerFactory.NodeLocalRunnerForNode(nodeName)
	if err != nil {
		return nil, fmt.Errorf("resolve probe runner: %w", err)
	}
	return CollectOVSBonds(ctx, runner, CollectOptions{
		Logger:             c.logger.With("node", nodeName),
		IncludeProbeOutput: c.includeProbeOutput,
	})
}

// CollectOVSBonds runs bond/show through runner and parses it.
func CollectOVSBonds(ctx context.Context, runner Runner, opts CollectOptions) ([]snapshot.OVSBond, error) {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	start := time.Now()
	raw, err := runner.Run(ctx, ovsBondShowCommand)
	if err != nil {
		logger.Warn("OVS bond probe failed", "durationMs", time.Since(start).Milliseconds(), "error", err)
		return nil, fmt.Errorf("ovs-appctl bond/show: %w", err)
	}
	logProbeOutput(logger, opts.IncludeProbeOutput, ovsBondShowCommand, raw)
	bonds := ParseOVSBondShow(raw)
	logger.Debug("OVS bonds collected", "durationMs", time.Since(start).Milliseconds(), "bondCount", len(bonds))
	return bonds, nil
}
