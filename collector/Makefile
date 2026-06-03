# Makefile for OVN collector (release tags v* at repo root trigger collector-release when collector/** changes)

CONTAINER_ENGINE ?= podman
IMAGE_REGISTRY ?= quay.io
IMAGE_USER ?= dbewley
IMAGE_NAME ?= ovn-collector
IMAGE_TAG ?= latest
IMAGE_PLATFORMS ?= linux/amd64,linux/arm64
IMAGE_PLATFORM ?= linux/amd64
IMAGE_PLATFORM_AMD64 ?= linux/amd64
IMAGE_PLATFORM_ARM64 ?= linux/arm64
BUILD_ARGS ?=

IMG ?= $(IMAGE_REGISTRY)/$(IMAGE_USER)/$(IMAGE_NAME):$(IMAGE_TAG)
IMAGE_MANIFEST_WORK ?= localhost/$(IMAGE_NAME):$(IMAGE_TAG)-multiarch
IMAGE_AMD64_WORK ?= localhost/$(IMAGE_NAME):$(IMAGE_TAG)-amd64
IMAGE_ARM64_WORK ?= localhost/$(IMAGE_NAME):$(IMAGE_TAG)-arm64

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

image: ## Build a local single-platform collector container image
	$(CONTAINER_ENGINE) build --platform $(IMAGE_PLATFORM) -t $(IMG) .

push: ## Build and push a multi-arch collector image manifest
	@echo "Building and pushing $(IMG) for $(IMAGE_PLATFORMS)"
ifeq ($(CONTAINER_ENGINE),podman)
	- $(CONTAINER_ENGINE) manifest rm $(IMAGE_MANIFEST_WORK)
	$(CONTAINER_ENGINE) build --platform=$(IMAGE_PLATFORM_AMD64) -t $(IMAGE_AMD64_WORK) $(BUILD_ARGS) .
	$(CONTAINER_ENGINE) build --platform=$(IMAGE_PLATFORM_ARM64) -t $(IMAGE_ARM64_WORK) $(BUILD_ARGS) .
	$(CONTAINER_ENGINE) manifest create $(IMAGE_MANIFEST_WORK)
	$(CONTAINER_ENGINE) manifest add $(IMAGE_MANIFEST_WORK) $(IMAGE_AMD64_WORK)
	$(CONTAINER_ENGINE) manifest add $(IMAGE_MANIFEST_WORK) $(IMAGE_ARM64_WORK)
	$(CONTAINER_ENGINE) manifest push --all $(IMAGE_MANIFEST_WORK) $(IMG)
else
	$(CONTAINER_ENGINE) buildx build --push --platform=$(IMAGE_PLATFORMS) $(BUILD_ARGS) -t $(IMG) .
endif

clean: ## Remove build artifacts
	rm -rf bin
