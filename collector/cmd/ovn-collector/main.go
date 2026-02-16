package main

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"slices"
	"strings"

	"github.com/dlbewley/ovn-recon/collector/internal/probe"
	"github.com/dlbewley/ovn-recon/collector/internal/server"
	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

func main() {
	port := envOrDefault("PORT", "8090")
	snapshotDir := envOrDefault("SNAPSHOT_DIR", "./fixtures/snapshots")
	targetNamespaces := parseCSV(envOrDefault("COLLECTOR_TARGET_NAMESPACES", "openshift-ovn-kubernetes,openshift-frr-k8s"))
	logLevel := parseLogLevel(envOrDefault("COLLECTOR_LOG_LEVEL", "info"))
	includeProbeOutput := parseBool(envOrDefault("COLLECTOR_INCLUDE_PROBE_OUTPUT", "false"))

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel}))
	slog.SetDefault(logger)
	probe.SetDefaultCollectOptions(probe.CollectOptions{
		Logger:             logger.With("component", "probe"),
		IncludeProbeOutput: includeProbeOutput,
	})

	store := snapshot.NewFileStore(snapshotDir, "default.json")
	srv := server.New(store)
	liveCollector, err := buildLiveCollector(targetNamespaces, logger, includeProbeOutput)
	if err != nil {
		logger.Warn("live OVN probing disabled; serving file snapshots only", "error", err)
	} else {
		srv = server.NewWithLiveCollector(store, liveCollector)
		logger.Info("live OVN probing enabled", "targetNamespaces", targetNamespaces)
	}
	addr := ":" + port

	logger.Info("starting ovn-collector",
		"addr", addr,
		"snapshotDir", snapshotDir,
		"targetNamespaces", targetNamespaces,
		"logLevel", logLevel.String(),
		"includeProbeOutput", includeProbeOutput,
	)
	if err := http.ListenAndServe(addr, srv.Handler()); err != nil {
		logger.Error("collector server failed", "error", err)
		os.Exit(1)
	}
}

func buildLiveCollector(targetNamespaces []string, logger *slog.Logger, includeProbeOutput bool) (*probe.SnapshotCollector, error) {
	if len(targetNamespaces) == 0 {
		return nil, fmt.Errorf("at least one target namespace is required")
	}

	restConfig, err := rest.InClusterConfig()
	if err != nil {
		return nil, fmt.Errorf("load in-cluster config: %w", err)
	}

	clientset, err := kubernetes.NewForConfig(restConfig)
	if err != nil {
		return nil, fmt.Errorf("create kubernetes client: %w", err)
	}

	runnerFactory := probe.NewKubernetesExecRunnerFactory(clientset, restConfig, targetNamespaces, logger.With("component", "runner"))
	return probe.NewSnapshotCollector(runnerFactory, logger.With("component", "collector"), includeProbeOutput), nil
}

func envOrDefault(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func parseCSV(raw string) []string {
	parts := strings.Split(raw, ",")
	values := make([]string, 0, len(parts))
	for _, part := range parts {
		value := strings.TrimSpace(part)
		if value == "" || slices.Contains(values, value) {
			continue
		}
		values = append(values, value)
	}
	return values
}

func parseLogLevel(raw string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "error":
		return slog.LevelError
	case "warn":
		return slog.LevelWarn
	case "debug":
		return slog.LevelDebug
	case "trace":
		// Go's slog doesn't provide a native trace level; map to debug.
		return slog.LevelDebug
	case "info":
		fallthrough
	default:
		return slog.LevelInfo
	}
}

func parseBool(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "t", "true", "y", "yes", "on":
		return true
	default:
		return false
	}
}
