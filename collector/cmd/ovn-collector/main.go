package main

import (
	"log"
	"net/http"
	"os"

	"github.com/dlbewley/ovn-recon/collector/internal/server"
	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
)

func main() {
	port := envOrDefault("PORT", "8090")
	snapshotDir := envOrDefault("SNAPSHOT_DIR", "./fixtures/snapshots")

	store := snapshot.NewFileStore(snapshotDir, "default.json")
	srv := server.New(store)
	addr := ":" + port

	log.Printf("starting ovn-collector on %s (snapshot dir: %s)", addr, snapshotDir)
	if err := http.ListenAndServe(addr, srv.Handler()); err != nil {
		log.Fatalf("collector server failed: %v", err)
	}
}

func envOrDefault(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}
