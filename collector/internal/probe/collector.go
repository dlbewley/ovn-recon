package probe

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
)

// RunnerFactory resolves a runner for a specific node target.
type RunnerFactory interface {
	RunnerForNode(nodeName string) (Runner, error)
}

// StaticRunnerFactory always returns the same runner.
type StaticRunnerFactory struct {
	Runner Runner
}

// RunnerForNode implements RunnerFactory.
func (f StaticRunnerFactory) RunnerForNode(_ string) (Runner, error) {
	if f.Runner == nil {
		return nil, fmt.Errorf("runner is nil")
	}
	return f.Runner, nil
}

// SnapshotCollector executes live probe collection for a requested node.
type SnapshotCollector struct {
	runnerFactory      RunnerFactory
	logger             *slog.Logger
	includeProbeOutput bool
	now                func() time.Time
}

// NewSnapshotCollector constructs a live snapshot collector.
func NewSnapshotCollector(factory RunnerFactory, logger *slog.Logger, includeProbeOutput bool) *SnapshotCollector {
	if logger == nil {
		logger = slog.Default()
	}
	return &SnapshotCollector{
		runnerFactory:      factory,
		logger:             logger,
		includeProbeOutput: includeProbeOutput,
		now:                time.Now,
	}
}

// Collect builds a snapshot for a specific node by running probe commands.
func (c *SnapshotCollector) Collect(ctx context.Context, nodeName string) (snapshot.LogicalTopologySnapshot, error) {
	runner, err := c.runnerFactory.RunnerForNode(nodeName)
	if err != nil {
		return snapshot.LogicalTopologySnapshot{}, fmt.Errorf("resolve probe runner: %w", err)
	}

	start := time.Now()
	logger := c.logger.With("node", nodeName)
	logger.Info("collecting logical topology snapshot")
	payload, err := CollectSnapshotWithOptions(ctx, runner, nodeName, c.now(), CollectOptions{
		Logger:             logger.With("subcomponent", "probe"),
		IncludeProbeOutput: c.includeProbeOutput,
	})
	durationMs := time.Since(start).Milliseconds()
	if err != nil {
		logger.Error("live probe collection failed", "durationMs", durationMs, "error", err)
		return snapshot.LogicalTopologySnapshot{}, err
	}

	logger.Info(
		"logical topology snapshot collected",
		"durationMs", durationMs,
		"nodeCount", len(payload.Nodes),
		"edgeCount", len(payload.Edges),
		"warningCount", len(payload.Warnings),
		"sourceHealth", payload.Metadata.SourceHealth,
	)
	return payload, nil
}
