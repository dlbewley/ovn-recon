package main

import (
	"log"
	"net/http"
	"os"

	"github.com/dlbewley/ovn-recon/collector/internal/server"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8090"
	}

	srv := server.New()
	addr := ":" + port

	log.Printf("starting ovn-collector on %s", addr)
	if err := http.ListenAndServe(addr, srv.Handler()); err != nil {
		log.Fatalf("collector server failed: %v", err)
	}
}
