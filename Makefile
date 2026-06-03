# Makefile for OpenShift Console Plugin

# Variables
CONTAINER_ENGINE ?= podman
IMAGE_REGISTRY ?= quay.io
IMAGE_USER ?= dbewley
IMAGE_NAME ?= ovn-recon
IMAGE_TAG ?= latest
IMAGE_PLATFORMS ?= linux/amd64,linux/arm64
IMAGE_PLATFORM ?= linux/amd64
IMAGE_PLATFORM_AMD64 ?= linux/amd64
IMAGE_PLATFORM_ARM64 ?= linux/arm64
BUILD_ARGS ?=

# Derived Variables
REMOTE_IMAGE ?= $(IMAGE_REGISTRY)/$(IMAGE_USER)/$(IMAGE_NAME):$(IMAGE_TAG)
IMAGE_MANIFEST_WORK ?= localhost/$(IMAGE_NAME):$(IMAGE_TAG)-multiarch
IMAGE_AMD64_WORK ?= localhost/$(IMAGE_NAME):$(IMAGE_TAG)-amd64
IMAGE_ARM64_WORK ?= localhost/$(IMAGE_NAME):$(IMAGE_TAG)-arm64

.PHONY: help install build dev clean lint test image push deploy

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Targets:'
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install dependencies
	npm install

build: ## Build the plugin for production
	npm run build

dev: ## Start the development server
	npm run start:dev

clean: ## Clean build artifacts
	npm run clean

clean-all: ## Clean all build artifacts including node_modules
	rm -rf dist node_modules package-lock.json

lint: ## Lint the source code
	npm run lint

test: ## Run tests
	npm run test

image: ## Build a local single-platform container image
	$(CONTAINER_ENGINE) build --platform $(IMAGE_PLATFORM) -t $(IMAGE_NAME):$(IMAGE_TAG) .

push: ## Build and push a multi-arch image manifest to the registry
	@echo "Building and pushing $(REMOTE_IMAGE) for $(IMAGE_PLATFORMS)"
ifeq ($(CONTAINER_ENGINE),podman)
	- $(CONTAINER_ENGINE) manifest rm $(IMAGE_MANIFEST_WORK)
	$(CONTAINER_ENGINE) build --platform=$(IMAGE_PLATFORM_AMD64) -t $(IMAGE_AMD64_WORK) $(BUILD_ARGS) .
	$(CONTAINER_ENGINE) build --platform=$(IMAGE_PLATFORM_ARM64) -t $(IMAGE_ARM64_WORK) $(BUILD_ARGS) .
	$(CONTAINER_ENGINE) manifest create $(IMAGE_MANIFEST_WORK)
	$(CONTAINER_ENGINE) manifest add $(IMAGE_MANIFEST_WORK) $(IMAGE_AMD64_WORK)
	$(CONTAINER_ENGINE) manifest add $(IMAGE_MANIFEST_WORK) $(IMAGE_ARM64_WORK)
	$(CONTAINER_ENGINE) manifest push --all $(IMAGE_MANIFEST_WORK) $(REMOTE_IMAGE)
else
	$(CONTAINER_ENGINE) buildx build --push --platform=$(IMAGE_PLATFORMS) $(BUILD_ARGS) -t $(REMOTE_IMAGE) .
endif

deploy: ## Apply manifests to the cluster (requires logged in session)
	oc apply -k manifests/
