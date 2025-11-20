# Makefile for OpenShift Console Plugin

# Variables
CONTAINER_ENGINE ?= podman
IMAGE_NAME ?= ocp-console-plugin
IMAGE_TAG ?= latest

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

lint: ## Lint the source code
	npm run lint

test: ## Run tests
	npm run test

image: ## Build the container image
	$(CONTAINER_ENGINE) build -t $(IMAGE_NAME):$(IMAGE_TAG) .

deploy: ## Apply manifests to the cluster (requires logged in session)
	oc apply -k manifests/
