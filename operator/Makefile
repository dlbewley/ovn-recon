# VERSION defines the project version for the bundle.
# Update this value when you upgrade the version of your project.
# To re-generate a bundle for another specific version without changing the standard setup, you can:
# - use the VERSION as arg of the bundle target (e.g make bundle VERSION=0.0.2)
# - use environment variables to overwrite this value (e.g export VERSION=0.0.2)
VERSION ?= 0.0.1

# CHANNELS define the bundle channels used in the bundle.
# Defaulted to the channels this operator actually publishes. Without a default,
# operator-sdk falls back to "alpha" and a local `make bundle` silently rewrites
# bundle/metadata/annotations.yaml, dropping stable,latest. CI passes these
# explicitly (CHANNELS=latest for prereleases); the defaults keep a local run
# producing the same annotations as a stable release.
# - use the CHANNELS as arg of the bundle target (e.g make bundle CHANNELS=candidate,fast,stable)
# - use environment variables to overwrite this value (e.g export CHANNELS="candidate,fast,stable")
# Prereleases (a hyphen in VERSION) publish to 'latest' only, matching the
# logic in .github/workflows/operator-release.yaml. A flat default would put a
# prerelease into 'stable'.
ifeq (,$(findstring -,$(VERSION)))
CHANNELS ?= stable,latest
else
CHANNELS ?= latest
endif
ifneq ($(origin CHANNELS), undefined)
BUNDLE_CHANNELS := --channels=$(CHANNELS)
endif

# DEFAULT_CHANNEL defines the default channel used in the bundle.
# See the CHANNELS note above: without a default the annotation is dropped entirely.
# - use the DEFAULT_CHANNEL as arg of the bundle target (e.g make bundle DEFAULT_CHANNEL=stable)
# - use environment variables to overwrite this value (e.g export DEFAULT_CHANNEL="stable")
ifeq (,$(findstring -,$(VERSION)))
DEFAULT_CHANNEL ?= stable
else
DEFAULT_CHANNEL ?= latest
endif
ifneq ($(origin DEFAULT_CHANNEL), undefined)
BUNDLE_DEFAULT_CHANNEL := --default-channel=$(DEFAULT_CHANNEL)
endif
BUNDLE_METADATA_OPTS ?= $(BUNDLE_CHANNELS) $(BUNDLE_DEFAULT_CHANNEL)

# IMAGE_TAG_BASE defines the docker.io namespace and part of the image name for remote images.
# This variable is used to construct full image tags for bundle and catalog images.
#
# For example, running 'make bundle-build bundle-push catalog-fbc-build catalog-push' will build and push both
# bewley.net/operator-bundle:$VERSION and bewley.net/operator-catalog:$VERSION.
IMAGE_TAG_BASE ?= bewley.net/operator

# BUNDLE_IMG defines the image:tag used for the bundle.
# You can use it as an arg. (E.g make bundle-build BUNDLE_IMG=<some-registry>/<project-name-bundle>:<tag>)
BUNDLE_IMG ?= $(IMAGE_TAG_BASE)-bundle:v$(VERSION)

# BUNDLE_GEN_FLAGS are the flags passed to the operator-sdk generate bundle command
BUNDLE_GEN_FLAGS ?= -q --overwrite --version $(VERSION) $(BUNDLE_METADATA_OPTS)

# USE_IMAGE_DIGESTS defines if images are resolved via tags or digests
# You can enable this value if you would like to use SHA Based Digests
# To enable set flag to true
USE_IMAGE_DIGESTS ?= false
ifeq ($(USE_IMAGE_DIGESTS), true)
	BUNDLE_GEN_FLAGS += --use-image-digests
endif

# Set the Operator SDK version to use. By default, what is installed on the system is used.
# This is useful for CI or a project to utilize a specific version of the operator-sdk toolkit.
OPERATOR_SDK_VERSION ?= v1.42.0
# Image URL to use all building/pushing image targets
IMG ?= ovn-recon-operator:latest

# Get the currently used golang install path (in GOPATH/bin, unless GOBIN is set)
ifeq (,$(shell go env GOBIN))
GOBIN=$(shell go env GOPATH)/bin
else
GOBIN=$(shell go env GOBIN)
endif

# CONTAINER_TOOL defines the container tool used for image builds and for opm
# (--container-tool). Default: docker if on PATH, else podman (common on macOS
# without Docker Desktop). Override explicitly when needed, e.g.
#   make catalog-fbc-build-multiarch CONTAINER_TOOL=podman ...
CONTAINER_TOOL ?= $(shell if command -v docker >/dev/null 2>&1; then echo docker; elif command -v podman >/dev/null 2>&1; then echo podman; else echo docker; fi)

# Setting SHELL to bash allows bash commands to be executed by recipes.
# Options are set to exit when a recipe line exits non-zero or a piped command fails.
SHELL = /usr/bin/env bash -o pipefail
.SHELLFLAGS = -ec

.PHONY: all
all: build

##@ General

# The help target prints out all targets with their descriptions organized
# beneath their categories. The categories are represented by '##@' and the
# target descriptions by '##'. The awk command is responsible for reading the
# entire set of makefiles included in this invocation, looking for lines of the
# file as xyz: ## something, and then pretty-format the target and help. Then,
# if there's a line with ##@ something, that gets pretty-printed as a category.
# More info on the usage of ANSI control characters for terminal formatting:
# https://en.wikipedia.org/wiki/ANSI_escape_code#SGR_parameters
# More info on the awk command:
# http://linuxcommand.org/lc3_adv_awk.php

.PHONY: help
help: ## Display this help.
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} /^[a-zA-Z_0-9-]+:.*?##/ { printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } ' $(MAKEFILE_LIST)

##@ Development

.PHONY: manifests
manifests: controller-gen ## Generate WebhookConfiguration, ClusterRole and CustomResourceDefinition objects.
	$(CONTROLLER_GEN) rbac:roleName=manager-role crd webhook paths="./..." output:crd:artifacts:config=config/crd/bases

.PHONY: generate
generate: controller-gen ## Generate code containing DeepCopy, DeepCopyInto, and DeepCopyObject method implementations.
	$(CONTROLLER_GEN) object:headerFile="hack/boilerplate.go.txt" paths="./..."

.PHONY: fmt
fmt: ## Run go fmt against code.
	go fmt ./...

.PHONY: vet
vet: ## Run go vet against code.
	go vet ./... 2>&1 | grep -v "k8s.io/kube-openapi" || true

.PHONY: test
test: manifests generate fmt vet setup-envtest ## Run tests.
	KUBEBUILDER_ASSETS="$(shell $(ENVTEST) use $(ENVTEST_K8S_VERSION) --bin-dir $(LOCALBIN) -p path)" go test $$(go list ./... | grep -v /e2e) -coverprofile cover.out

# TODO(user): To use a different vendor for e2e tests, modify the setup under 'tests/e2e'.
# The default setup assumes Kind is pre-installed and builds/loads the Manager Docker image locally.
# CertManager is installed by default; skip with:
# - CERT_MANAGER_INSTALL_SKIP=true
KIND_CLUSTER ?= operator-test-e2e

.PHONY: setup-test-e2e
setup-test-e2e: ## Set up a Kind cluster for e2e tests if it does not exist
	@command -v $(KIND) >/dev/null 2>&1 || { \
		echo "Kind is not installed. Please install Kind manually."; \
		exit 1; \
	}
	@case "$$($(KIND) get clusters)" in \
		*"$(KIND_CLUSTER)"*) \
			echo "Kind cluster '$(KIND_CLUSTER)' already exists. Skipping creation." ;; \
		*) \
			echo "Creating Kind cluster '$(KIND_CLUSTER)'..."; \
			$(KIND) create cluster --name $(KIND_CLUSTER) ;; \
	esac

.PHONY: test-e2e
test-e2e: setup-test-e2e manifests generate fmt vet ## Run the e2e tests. Expected an isolated environment using Kind.
	KIND_CLUSTER=$(KIND_CLUSTER) go test ./test/e2e/ -v -ginkgo.v
	$(MAKE) cleanup-test-e2e

.PHONY: cleanup-test-e2e
cleanup-test-e2e: ## Tear down the Kind cluster used for e2e tests
	@$(KIND) delete cluster --name $(KIND_CLUSTER)

.PHONY: lint
lint: golangci-lint ## Run golangci-lint linter
	$(GOLANGCI_LINT) run

.PHONY: lint-fix
lint-fix: golangci-lint ## Run golangci-lint linter and perform fixes
	$(GOLANGCI_LINT) run --fix

.PHONY: lint-config
lint-config: golangci-lint ## Verify golangci-lint linter configuration
	$(GOLANGCI_LINT) config verify

##@ Build

.PHONY: build
build: manifests generate fmt vet ## Build manager binary.
	go build -o bin/manager cmd/main.go 2>&1 | grep -v "k8s.io/kube-openapi" || go build -o bin/manager cmd/main.go

.PHONY: run
run: manifests generate fmt vet ## Run a controller from your host.
	go run ./cmd/main.go 2>&1 | grep -v "k8s.io/kube-openapi" || go run ./cmd/main.go

# If you wish to build the manager image targeting other platforms you can use the --platform flag.
# (i.e. docker build --platform linux/arm64). However, you must enable docker buildKit for it.
# More info: https://docs.docker.com/develop/develop-images/build_enhancements/
.PHONY: docker-build
docker-build: ## Build docker image with the manager.
	$(CONTAINER_TOOL) build $(BUILD_ARGS) -t ${IMG} .

.PHONY: docker-push
docker-push: ## Push docker image with the manager.
	$(CONTAINER_TOOL) push ${IMG}

# PLATFORMS defines the target platforms for the manager image be built to provide support to multiple
# architectures. (i.e. make docker-buildx IMG=myregistry/mypoperator:0.0.1). To use this option you need to:
# - be able to use docker buildx. More info: https://docs.docker.com/build/buildx/
# - have enabled BuildKit. More info: https://docs.docker.com/develop/develop-images/build_enhancements/
# - be able to push the image to your registry (i.e. if you do not set a valid value via IMG=<myregistry/image:<tag>> then the export will fail)
# To adequately provide solutions that are compatible with multiple platforms, you should consider using this option.
#
# Default PLATFORMS includes s390x/ppc64le for upstream kubebuilder parity. For
# OVN Recon Quay releases, CI overrides to linux/amd64,linux/arm64 only. When
# migrating from amd64-only images, always verify the pushed tag is a manifest
# list (e.g. docker buildx imagetools inspect <image> --raw | jq .manifests).
PLATFORMS ?= linux/arm64,linux/amd64,linux/s390x,linux/ppc64le
# Optional second tag for the same manifest list (e.g. :latest on stable releases).
IMAGE_EXTRA_TAG ?=
# Set DOCKER_BUILDX_NO_ISOLATED_BUILDER=1 when CI already ran docker/setup-buildx-action (avoid extra named builder).
DOCKER_BUILDX_NO_ISOLATED_BUILDER ?=

.PHONY: docker-buildx
docker-buildx: ## Build and push docker image for the manager for cross-platform support
	# copy existing Dockerfile and insert --platform=${BUILDPLATFORM} into Dockerfile.cross, and preserve the original Dockerfile
	sed -e '1 s/\(^FROM\)/FROM --platform=\$$\{BUILDPLATFORM\}/; t' -e ' 1,// s//FROM --platform=\$$\{BUILDPLATFORM\}/' Dockerfile > Dockerfile.cross
ifeq ($(DOCKER_BUILDX_NO_ISOLATED_BUILDER),1)
	$(CONTAINER_TOOL) buildx build --push --platform=$(PLATFORMS) --tag ${IMG} $(if $(IMAGE_EXTRA_TAG),--tag $(IMAGE_EXTRA_TAG),) -f Dockerfile.cross .
else
	- $(CONTAINER_TOOL) buildx create --name operator-builder
	$(CONTAINER_TOOL) buildx use operator-builder
	- $(CONTAINER_TOOL) buildx build --push --platform=$(PLATFORMS) --tag ${IMG} $(if $(IMAGE_EXTRA_TAG),--tag $(IMAGE_EXTRA_TAG),) -f Dockerfile.cross .
	- $(CONTAINER_TOOL) buildx rm operator-builder
endif
	rm -f Dockerfile.cross

.PHONY: build-installer
build-installer: manifests generate kustomize ## Generate a consolidated YAML with CRDs and deployment.
	mkdir -p dist
	cd config/manager && $(KUSTOMIZE) edit set image controller=${IMG}
	$(KUSTOMIZE) build config/default > dist/install.yaml

##@ Deployment

ifndef ignore-not-found
  ignore-not-found = false
endif

.PHONY: install
install: manifests kustomize ## Install CRDs into the K8s cluster specified in ~/.kube/config.
	$(KUSTOMIZE) build config/crd | $(KUBECTL) apply -f -

.PHONY: uninstall
uninstall: manifests kustomize ## Uninstall CRDs from the K8s cluster specified in ~/.kube/config. Call with ignore-not-found=true to ignore resource not found errors during deletion.
	$(KUSTOMIZE) build config/crd | $(KUBECTL) delete --ignore-not-found=$(ignore-not-found) -f -

.PHONY: deploy
deploy: manifests kustomize ## Deploy controller to the K8s cluster specified in ~/.kube/config.
	cd config/manager && $(KUSTOMIZE) edit set image controller=${IMG}
	$(KUSTOMIZE) build config/default | $(KUBECTL) apply -f -

.PHONY: undeploy
undeploy: kustomize ## Undeploy controller from the K8s cluster specified in ~/.kube/config. Call with ignore-not-found=true to ignore resource not found errors during deletion.
	$(KUSTOMIZE) build config/default | $(KUBECTL) delete --ignore-not-found=$(ignore-not-found) -f -

##@ Dependencies

## Location to install dependencies to
LOCALBIN ?= $(shell pwd)/bin
$(LOCALBIN):
	mkdir -p $(LOCALBIN)

## Tool Binaries
KUBECTL ?= kubectl
KIND ?= kind
KUSTOMIZE ?= $(LOCALBIN)/kustomize
CONTROLLER_GEN ?= $(LOCALBIN)/controller-gen
ENVTEST ?= $(LOCALBIN)/setup-envtest
GOLANGCI_LINT = $(LOCALBIN)/golangci-lint

## Tool Versions
KUSTOMIZE_VERSION ?= v5.6.0
CONTROLLER_TOOLS_VERSION ?= v0.18.0
#ENVTEST_VERSION is the version of controller-runtime release branch to fetch the envtest setup script (i.e. release-0.20)
ENVTEST_VERSION ?= $(shell go list -m -f "{{ .Version }}" sigs.k8s.io/controller-runtime | awk -F'[v.]' '{printf "release-%d.%d", $$2, $$3}')
#ENVTEST_K8S_VERSION is the version of Kubernetes to use for setting up ENVTEST binaries (i.e. 1.31)
ENVTEST_K8S_VERSION ?= $(shell go list -m -f "{{ .Version }}" k8s.io/api | awk -F'[v.]' '{printf "1.%d", $$3}')
GOLANGCI_LINT_VERSION ?= v2.1.0

.PHONY: kustomize
kustomize: $(KUSTOMIZE) ## Download kustomize locally if necessary.
$(KUSTOMIZE): $(LOCALBIN)
	$(call go-install-tool,$(KUSTOMIZE),sigs.k8s.io/kustomize/kustomize/v5,$(KUSTOMIZE_VERSION))

.PHONY: controller-gen
controller-gen: $(CONTROLLER_GEN) ## Download controller-gen locally if necessary.
$(CONTROLLER_GEN): $(LOCALBIN)
	$(call go-install-tool,$(CONTROLLER_GEN),sigs.k8s.io/controller-tools/cmd/controller-gen,$(CONTROLLER_TOOLS_VERSION))

.PHONY: setup-envtest
setup-envtest: envtest ## Download the binaries required for ENVTEST in the local bin directory.
	@echo "Setting up envtest binaries for Kubernetes version $(ENVTEST_K8S_VERSION)..."
	@$(ENVTEST) use $(ENVTEST_K8S_VERSION) --bin-dir $(LOCALBIN) -p path || { \
		echo "Error: Failed to set up envtest binaries for version $(ENVTEST_K8S_VERSION)."; \
		exit 1; \
	}

.PHONY: envtest
envtest: $(ENVTEST) ## Download setup-envtest locally if necessary.
$(ENVTEST): $(LOCALBIN)
	$(call go-install-tool,$(ENVTEST),sigs.k8s.io/controller-runtime/tools/setup-envtest,$(ENVTEST_VERSION))

.PHONY: golangci-lint
golangci-lint: $(GOLANGCI_LINT) ## Download golangci-lint locally if necessary.
$(GOLANGCI_LINT): $(LOCALBIN)
	$(call go-install-tool,$(GOLANGCI_LINT),github.com/golangci/golangci-lint/v2/cmd/golangci-lint,$(GOLANGCI_LINT_VERSION))

# go-install-tool will 'go install' any package with custom target and name of binary, if it doesn't exist
# $1 - target path with name of binary
# $2 - package url which can be installed
# $3 - specific version of package
define go-install-tool
@[ -f "$(1)-$(3)" ] || { \
set -e; \
package=$(2)@$(3) ;\
echo "Downloading $${package}" ;\
rm -f $(1) || true ;\
GOBIN=$(LOCALBIN) go install $${package} ;\
mv $(1) $(1)-$(3) ;\
} ;\
ln -sf $(1)-$(3) $(1)
endef

.PHONY: operator-sdk
OPERATOR_SDK ?= $(LOCALBIN)/operator-sdk
operator-sdk: ## Download operator-sdk at OPERATOR_SDK_VERSION into bin/ (always; a PATH operator-sdk of a different version rewrites bundle annotations).
ifeq (,$(wildcard $(OPERATOR_SDK)))
	@{ \
	set -e ;\
	mkdir -p $(dir $(OPERATOR_SDK)) ;\
	OS=$(shell go env GOOS) && ARCH=$(shell go env GOARCH) && \
	curl -sSLo $(OPERATOR_SDK) https://github.com/operator-framework/operator-sdk/releases/download/$(OPERATOR_SDK_VERSION)/operator-sdk_$${OS}_$${ARCH} ;\
	chmod +x $(OPERATOR_SDK) ;\
	}
endif

.PHONY: bundle
bundle: manifests kustomize operator-sdk ## Generate bundle manifests and metadata, then validate generated files.
	$(OPERATOR_SDK) generate kustomize manifests -q
	cd config/manager && $(KUSTOMIZE) edit set image controller=$(IMG)
	rm -f bundle/manifests/*.clusterserviceversion.yaml
	$(KUSTOMIZE) build config/manifests | $(OPERATOR_SDK) generate bundle $(BUNDLE_GEN_FLAGS) || \
		($(KUSTOMIZE) build config/manifests | $(OPERATOR_SDK) generate bundle $(BUNDLE_GEN_FLAGS) < /dev/stdin)
	$(OPERATOR_SDK) bundle validate ./bundle
	@csv_count=$$(ls bundle/manifests/*.clusterserviceversion.yaml 2>/dev/null | wc -l | tr -d '[:space:]'); \
	if [ "$$csv_count" -ne 1 ]; then \
		echo "Error: expected exactly 1 CSV in bundle/manifests, found $$csv_count"; \
		ls -1 bundle/manifests/*.clusterserviceversion.yaml 2>/dev/null || true; \
		exit 1; \
	fi
	if rg -n --no-messages '"tag": "latest"' bundle/manifests/*.clusterserviceversion.yaml; then \
		echo "Error: bundle alm-examples must not pin image tag to latest"; \
		exit 1; \
	fi

.PHONY: render
render: ## Render YAML for the sample OvnRecon resource.
	@go run ./cmd/render -f config/samples/recon_v1beta1_ovnrecon.yaml

.PHONY: bundle-build
bundle-build: ## Build the bundle image.
	$(CONTAINER_TOOL) build $(BUILD_ARGS) -f bundle.Dockerfile -t $(BUNDLE_IMG) .

# Platforms for bundle/catalog release images (manifest list).
BUNDLE_PLATFORMS ?= linux/amd64,linux/arm64
BUNDLE_EXTRA_IMG ?=

.PHONY: bundle-buildx
bundle-buildx: ## Build and push multi-arch bundle image (requires registry login and buildx).
	$(CONTAINER_TOOL) buildx build --push --platform=$(BUNDLE_PLATFORMS) $(BUILD_ARGS) -f bundle.Dockerfile \
		-t $(BUNDLE_IMG) $(if $(BUNDLE_EXTRA_IMG),-t $(BUNDLE_EXTRA_IMG),) .

.PHONY: bundle-push
bundle-push: ## Push the bundle image.
	$(MAKE) docker-push IMG=$(BUNDLE_IMG)

.PHONY: opm
OPM = $(LOCALBIN)/opm
opm: ## Download opm from operator-registry releases into bin/ (always; avoids mistaken PATH opm, e.g. symlink to oc).
ifeq (,$(wildcard $(OPM)))
	@{ \
	set -e ;\
	mkdir -p $(dir $(OPM)) ;\
	OS=$(shell go env GOOS) && ARCH=$(shell go env GOARCH) && \
	curl -sSLo $(OPM) https://github.com/operator-framework/operator-registry/releases/download/v1.55.0/$${OS}-$${ARCH}-opm ;\
	chmod +x $(OPM) ;\
	}
endif


# The image tag given to the resulting catalog image
# (e.g. make catalog-fbc-build CATALOG_IMG=example.com/operator-catalog:v0.2.0).
CATALOG_IMG ?= $(IMAGE_TAG_BASE)-catalog:v$(VERSION)

# Platforms for the multi-arch catalog image.
CATALOG_PLATFORMS ?= linux/amd64,linux/arm64
# Additional tags for the same manifest list, space separated
# (e.g. ":latest :v4.20" on a prerelease, plus ":stable" on a stable release).
CATALOG_EXTRA_IMG ?=
# Podman: "podman buildx build --push" is not supported, so the podman path
# builds a local manifest list here and pushes it with "manifest push --all".
CATALOG_MANIFEST_WORK ?= localhost/ovn-recon/catalog-multiarch:work

##@ Catalog (File-Based Catalog)

# FBC is the supported catalog format. The deprecated sqlite index path
# ('opm index add') was removed once FBC was proven in production.
# Catalog source of truth lives in git under $(CATALOG_DIR) and is rendered by
# `opm render`, not inferred from version ordering. See docs/tasks/fbc-migration.md.
CATALOG_DIR ?= catalog
CATALOG_PKG ?= ovn-recon-operator
CATALOG_FBC ?= $(CATALOG_DIR)/$(CATALOG_PKG)/catalog.json
CATALOG_DOCKERFILE ?= catalog.Dockerfile
# Multi-arch base for the catalog runtime, PINNED BY DIGEST.
#
# This image is what consumers actually run: it serves the catalog over gRPC in
# their cluster. An unpinned :latest means that runtime can change under us
# between releases with no corresponding change in this repo, so a catalog that
# worked yesterday can behave differently today for reasons invisible in git.
#
# Verified manifest list (linux/amd64, arm64, ppc64le, s390x) as of 2026-08-18.
# To update: confirm the new digest is still a manifest list, then bump here.
#   curl -sH 'Accept: application/vnd.oci.image.index.v1+json' \
#     https://quay.io/v2/operator-framework/opm/manifests/latest -D - -o /dev/null | grep -i docker-content-digest
OPM_IMAGE ?= quay.io/operator-framework/opm@sha256:e5a6220603fb4504d58c6e3e488386b817e3695c906a62ee0370b5faedc3799a

.PHONY: catalog-fbc-validate
catalog-fbc-validate: opm ## Validate the file-based catalog tree.
	$(OPM) validate $(CATALOG_DIR)
	@echo "FBC valid: $(CATALOG_DIR)"

# CATALOG_REF is the published catalog to diff against. Defaults to the tag
# stable consumers track, so `make catalog-fbc-verify` answers the question that
# actually matters: "would publishing this break anyone already installed?"
CATALOG_REF ?= quay.io/dbewley/bewley-operator-catalog:latest

.PHONY: catalog-fbc-verify
catalog-fbc-verify: opm ## Verify catalog integrity, and that changes vs CATALOG_REF are additive. Set CATALOG_REF= to skip the published diff.
	python3 ./hack/catalog-verify.py --opm "$(OPM)" --fbc "$(CATALOG_FBC)" \
		$(if $(strip $(CATALOG_REF)),--ref "$(CATALOG_REF)",)

.PHONY: catalog-fbc-prune-dangling
catalog-fbc-prune-dangling: ## Report prerelease catalog entries whose images are gone. Set APPLY=1 to remove them.
	python3 ./hack/catalog-prune-dangling.py --fbc "$(CATALOG_FBC)" $(if $(APPLY),--apply,)

# Operand image refs stamped into manager.yaml (and thus into the CSV's
# relatedImages) for a release. CI does this with sed; release-prep does it here
# so a locally prepared catalog entry carries the same values instead of ':dev'.
PLUGIN_IMAGE_BASE ?= quay.io/dbewley/ovn-recon
COLLECTOR_IMAGE_BASE ?= quay.io/dbewley/ovn-collector

.PHONY: release-prep
release-prep: opm ## Prepare a release: stamp operand images, generate the bundle, and add it to the catalog. Requires VERSION.
	@test -n "$(VERSION)" || { echo "VERSION is required, e.g. make release-prep VERSION=1.0.0"; exit 1; }
	@test "$(VERSION)" != "0.0.1" || { echo "VERSION looks like the scaffold default; pass the real release version"; exit 1; }
	@echo ">> stamping operand images for v$(VERSION)"
	@python3 -c "import sys;p='config/manager/manager.yaml';s=open(p).read();\
s=s.replace('value: dev','value: v$(VERSION)');\
s=s.replace('$(PLUGIN_IMAGE_BASE):dev','$(PLUGIN_IMAGE_BASE):v$(VERSION)');\
s=s.replace('$(COLLECTOR_IMAGE_BASE):dev','$(COLLECTOR_IMAGE_BASE):v$(VERSION)');\
open(p,'w').write(s)"
	@echo ">> generating bundle"
	@$(MAKE) bundle VERSION=$(VERSION) IMG=$(PLUGIN_IMAGE_BASE)-operator:v$(VERSION) >/dev/null
	@echo ">> restoring manager.yaml (generated artifact; CI stamps it itself)"
	@git checkout -- config/manager/manager.yaml config/manager/kustomization.yaml
	@echo ">> adding to the catalog"
	@$(MAKE) catalog-fbc-add BUNDLE_IMG=$(PLUGIN_IMAGE_BASE)-operator-bundle:v$(VERSION) BUNDLE_SRC=bundle
	@echo ""
	@echo "Prepared v$(VERSION). Commit operator/catalog/ (and the plugin version bump), then tag with -a."

.PHONY: catalog-fbc-add
# BUNDLE_SRC is what gets RENDERED; BUNDLE_IMG is what gets RECORDED in the
# catalog. They differ during release prep: the bundle image for an unreleased
# version does not exist yet, so render the local ./bundle directory and stamp
# the ref CI will publish it under.
#   make catalog-fbc-add BUNDLE_IMG=...:v1.0.0 BUNDLE_SRC=bundle
BUNDLE_SRC ?= $(BUNDLE_IMG)

catalog-fbc-add: opm ## Add a bundle to the FBC. BUNDLE_IMG is the ref recorded; BUNDLE_SRC is what is rendered (default: BUNDLE_IMG; use "bundle" for an unpublished release). CHANNELS defaults to stable,latest.
	@test -n "$(BUNDLE_IMG)" || { echo "BUNDLE_IMG is required, e.g. make catalog-fbc-add BUNDLE_IMG=quay.io/dbewley/ovn-recon-operator-bundle:v1.0.0"; exit 1; }
	python3 ./hack/catalog-add-bundle.py \
		--opm "$(OPM)" \
		--fbc "$(CATALOG_FBC)" \
		--package "$(CATALOG_PKG)" \
		--bundle "$(BUNDLE_SRC)" \
		--image "$(BUNDLE_IMG)" \
		--channels "$(if $(CHANNELS),$(CHANNELS),stable,latest)"
	$(MAKE) catalog-fbc-validate

.PHONY: catalog-fbc-build
catalog-fbc-build: catalog-fbc-validate ## Build the FBC catalog image for the local platform.
	$(CONTAINER_TOOL) build -f $(CATALOG_DOCKERFILE) --build-arg OPM_IMAGE=$(OPM_IMAGE) -t $(CATALOG_IMG) .

.PHONY: catalog-fbc-build-multiarch
catalog-fbc-build-multiarch: catalog-fbc-validate ## Build and push the multi-arch FBC catalog image (docker buildx or podman manifest workflow).
ifeq ($(CONTAINER_TOOL),podman)
	-$(CONTAINER_TOOL) rmi -f $(CATALOG_MANIFEST_WORK) 2>/dev/null || true
	$(CONTAINER_TOOL) build --platform=$(CATALOG_PLATFORMS) --manifest $(CATALOG_MANIFEST_WORK) $(BUILD_ARGS) \
		--build-arg OPM_IMAGE=$(OPM_IMAGE) -f $(CATALOG_DOCKERFILE) .
	$(CONTAINER_TOOL) manifest push --all $(CATALOG_MANIFEST_WORK) $(CATALOG_IMG)
	$(foreach t,$(CATALOG_EXTRA_IMG),$(CONTAINER_TOOL) manifest push --all $(CATALOG_MANIFEST_WORK) $(t);)
	-$(CONTAINER_TOOL) rmi -f $(CATALOG_MANIFEST_WORK) 2>/dev/null || true
else
	$(CONTAINER_TOOL) buildx build --push --platform=$(CATALOG_PLATFORMS) $(BUILD_ARGS) \
		--build-arg OPM_IMAGE=$(OPM_IMAGE) -f $(CATALOG_DOCKERFILE) \
		-t $(CATALOG_IMG) $(foreach t,$(CATALOG_EXTRA_IMG),-t $(t)) .
endif


# Push the catalog image.
.PHONY: catalog-push
catalog-push: ## Push a catalog image.
	$(MAKE) docker-push IMG=$(CATALOG_IMG)

	$(MAKE) docker-push IMG=$(CATALOG_IMG)
