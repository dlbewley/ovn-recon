package main

import (
	"log/slog"
	"net/http"
	"os"
	"strings"

	"github.com/dlbewley/ovn-recon/collector/internal/probe"
	"github.com/dlbewley/ovn-recon/collector/internal/server"
	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
)

func main() {
	port := envOrDefault("PORT", "8090")
	snapshotDir := envOrDefault("SNAPSHOT_DIR", "./fixtures/snapshots")
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
	addr := ":" + port

	logger.Info("starting ovn-collector",
		"addr", addr,
		"snapshotDir", snapshotDir,
		"logLevel", logLevel.String(),
		"includeProbeOutput", includeProbeOutput,
	)
	if err := http.ListenAndServe(addr, srv.Handler()); err != nil {
		logger.Error("collector server failed", "error", err)
		os.Exit(1)
	}
}

func envOrDefault(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
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
