# Makefile for OpenShift Console Plugin

# Variables
CONTAINER_ENGINE ?= podman
IMAGE_REGISTRY ?= quay.io
IMAGE_USER ?= dbewley
IMAGE_NAME ?= ovn-recon
IMAGE_TAG ?= latest

# Derived Variables
REMOTE_IMAGE ?= $(IMAGE_REGISTRY)/$(IMAGE_USER)/$(IMAGE_NAME):$(IMAGE_TAG)

.PHONY: help install build dev clean lint test image deploy

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

image: ## Build the container image
	$(CONTAINER_ENGINE) build --platform linux/amd64 -t $(IMAGE_NAME):$(IMAGE_TAG) .

push: image ## Tag and push the image to the registry
	@echo "Pushing to $(REMOTE_IMAGE)"
	$(CONTAINER_ENGINE) tag $(IMAGE_NAME):$(IMAGE_TAG) $(REMOTE_IMAGE)
	$(CONTAINER_ENGINE) push $(REMOTE_IMAGE)

deploy: ## Apply manifests to the cluster (requires logged in session)
	oc apply -k manifests/
