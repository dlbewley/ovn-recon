# Makefile for OVN collector

CONTAINER_ENGINE ?= podman
IMAGE_REGISTRY ?= quay.io
IMAGE_USER ?= dbewley
IMAGE_NAME ?= ovn-collector
IMAGE_TAG ?= latest

IMG ?= $(IMAGE_REGISTRY)/$(IMAGE_USER)/$(IMAGE_NAME):$(IMAGE_TAG)

.PHONY: help fmt vet test build run image push clean

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Targets:'
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

fmt: ## Run go fmt
	go fmt ./...

vet: ## Run go vet
	go vet ./...

test: ## Run unit tests
	go test ./...

build: fmt vet test ## Build collector binary
	mkdir -p bin
	go build -o bin/ovn-collector ./cmd/ovn-collector

run: ## Run collector locally
	go run ./cmd/ovn-collector

image: ## Build collector container image
	$(CONTAINER_ENGINE) build --platform linux/amd64 -t $(IMG) .

push: image ## Push collector container image
	$(CONTAINER_ENGINE) push $(IMG)

clean: ## Remove build artifacts
	rm -rf bin
