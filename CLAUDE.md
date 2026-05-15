# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OVN Recon is an OpenShift Console Plugin that visualizes Virtual and Node Network topology in an OpenShift cluster. It has three sub-projects:

- **Plugin** (`src/`, root): TypeScript/React frontend — the console plugin itself
- **Operator** (`operator/`): Go/Kubebuilder operator that manages the plugin's lifecycle via the `OvnRecon` CRD
- **Collector** (`collector/`): Go HTTP service that provides live logical OVN topology snapshots

## Commands

### Plugin (root)

```bash
npm install          # Install dependencies
npm run build        # Production build → dist/
npm run start:dev    # Webpack dev server
npm run lint         # ESLint with auto-fix
npm run test         # Jest tests
```

Run a single test file:
```bash
npx jest src/components/nodeVisualizationModel.test.ts
```

### Operator (`operator/`)

```bash
make help            # Show all targets
make build           # Build Go binary
make test            # Run Go tests
make docker-build docker-push IMG=<registry>/operator:tag
make install         # Install CRDs into cluster (requires KUBECONFIG)
make deploy IMG=...  # Deploy controller to cluster
make render          # Inspect rendered manifests locally
```

### Collector (`collector/`)

```bash
make build           # Build Go binary
make run             # Run locally (serves fixtures by default)
make image IMAGE_TAG=dev
```

### Build and Deploy to Cluster

Source `setup_env.sh` before any cluster commands:

```bash
source setup_env.sh
```

Full rebuild and redeploy:

```bash
source setup_env.sh && \
  make build push && \
  make -C collector build push && \
  oc rollout restart deployment/$APP_NAME -n "$APP_NAMESPACE" && \
  oc wait --for=condition=ready pod -l "$APP_SELECTOR" -n "$APP_NAMESPACE" --timeout=60s
```

> **Release images on Quay** (`ovn-recon`, `ovn-collector`, operator/bundle/catalog) are published as **multi-arch** manifest lists (**linux/amd64** and **linux/arm64**) from GitHub Actions. For local `make image` in `collector/`, the default is still **`linux/amd64`** unless you override **`IMAGE_PLATFORM`**.

### Releasing

```bash
npm version patch|minor|major   # bumps package.json, Chart.yaml, creates git tag
git push --follow-tags           # triggers CI to build, push image, create GitHub Release
```

Prereleases containing `-` in the tag (e.g. `v1.0.1-beta.1`) do **not** update the `latest` image tag.

## Architecture

### Plugin (`src/`)

The plugin registers three route-based modules in `console-extensions.json`:

| Route | Module | Purpose |
|---|---|---|
| `/ovn-recon/node-network-state` | `NodeNetworkStateList` | Node list |
| `/ovn-recon/node-network-state/:name` | `NodeNetworkStateDetails` | Physical topology per node |
| `/ovn-recon/ovn/:name` | `NodeLogicalTopologyDetails` | Logical OVN topology (collector-gated) |

**Physical topology pipeline** (`NodeNetworkStateDetails` → `NodeVisualization`):

1. `useK8sWatchResource` watches live K8s resources: `NodeNetworkState`, `ClusterUserDefinedNetwork`, `UserDefinedNetwork`, `NetworkAttachmentDefinition`, `RouteAdvertisements`
2. `nodeVisualizationSelectors.ts` — pure functions that extract relationships from raw resource data (VRF routes, CUDN/NAD associations, LLDP neighbors, route advertisement lookups)
3. `nodeVisualizationModel.ts` — builds a graph model: nodes typed as `interface | ovn-mapping | cudn | udn | attachment | nad | vrf | lldp-neighbor | other`, and edges between them
4. `nodeVisualizationLayout.ts` — assigns grid positions using gravity-based column sorting (no external graph library)
5. `NodeVisualization.tsx` — renders the graph as an SVG/HTML grid using PatternFly components

**Logical topology** (`NodeLogicalTopologyDetails`): Fetches JSON snapshots from the collector service at `/api/v1/snapshots/:nodeName`. Feature-gated by `useOvnCollectorFeatureGate`, which watches the `OvnRecon` CR for `spec.collector.enabled`.

**All UI components use PatternFly v6** to stay consistent with OpenShift 4.20+.

### Collector (`collector/`)

Go HTTP server at port 8090. Attempts live OVN interrogation via pod exec into `openshift-ovn-kubernetes` / `openshift-frr-k8s` namespaces. Falls back to static fixture files under `fixtures/snapshots/` on failure (adds `LIVE_PROBE_FAILED` warning in response).

Canonical type contract shared across Go and TypeScript:
- Go types: `collector/internal/snapshot/types.go`
- TypeScript types: `src/types.ts` (`LogicalTopologySnapshot` and related interfaces)
- JSON schema: `collector/api/logical-topology-snapshot.schema.json`

### Operator (`operator/`)

Kubebuilder-generated operator. Reconciles `OvnRecon` CRs (`recon.bewley.net/v1alpha1`) into `Deployment`, `Service`, and `ConsolePlugin` resources. The primary instance (oldest CR) owns cluster-scoped resources. OLM bundle lives in `operator/bundle/`.

## Task Tracking

This project uses **bd** (beads) for issue tracking:

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress
bd close <id>
bd sync               # Sync with git at session end
```

Planning documents in `docs/tasks/` should include an `Initial Beads Backlog Mapping` section with a table of bead IDs.

## PR Notes

When creating PRs with `gh pr create`, use `--body-file <path>` for multiline bodies — avoid backticks in inline `--body` strings.
