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

Jest ignores `<rootDir>/.claude/` so the primary clone does not scan session worktrees. Inside a
worktree the suite runs normally; if `npx jest` ever reports "No tests found", check that the
ignore pattern is still anchored to `<rootDir>` rather than a bare `/.claude/`.

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
npm version patch|minor|major   # bumps package.json + consolePlugin.version, creates git tag
git push --follow-tags           # triggers CI to build, push image, create GitHub Release
```

Prereleases containing `-` in the tag (e.g. `v1.0.1-beta.1`) do **not** update the `latest` image tag.

## Architecture

### Plugin (`src/`)

The plugin registers six route-based modules in `console-extensions.json`, reached from a single *Networking → OVN Recon* entry:

| Route | Module | Purpose |
|---|---|---|
| `/ovn-recon` (also `/ovn-recon/node-network-state`) | `OvnReconOverview` | Overview: cluster-wide search (`?q=`), findings summary, networks table, node table, collector status line |
| `/ovn-recon/node-network-state/:name` | `NodeNetworkStateDetails` | Physical topology per node |
| `/ovn-recon/ovn` | `ClusterLogicalTopologyDetails` | Logical OVN topology merged across node zones (collector-gated) |
| `/ovn-recon/ovn/:name` | `NodeLogicalTopologyDetails` | Logical OVN topology of one node's zone (collector-gated) |
| `/ovn-recon/ovn/:node/:kind/:name` | `ConstructDetails` | One logical switch or router from one node's zone: tabbed, full-width tables; `?tab=`, `?q=`, `?port=` (collector-gated) |
| `/ovn-recon/networks` | `NetworkDetails` | Every CUDN, UDN and NAD-only network, with nodes wired |
| `/ovn-recon/networks/cudn/:name`, `/ovn-recon/networks/udn/:namespace/:name`, `/ovn-recon/networks/nad/:namespace/:name` | `NetworkDetails` | One network: spec summary, network-scope findings, per-node placement matrix (`networkPageModel.ts`) |

Every logical route is `exact: true`, so the node ladder route cannot claim the construct page's longer path. Both ladder pages take `?select=KIND:NAME` (`useSelectParam.ts`); the construct page's breadcrumbs and the drawer's "Open full page" links (`constructDetailLinks.ts`, one label: `OPEN_FULL_PAGE`) use it and the page route.

**Console integration** (`ovn-recon-zdt`): the plugin also contributes to console pages it does not own, an "OVN Recon" `console.tab/horizontalNav` (href `ovn-recon`) and an "Open in OVN Recon" `console.action/resource-provider` on Node, CUDN, UDN and NAD. None of it is unconditional: each requires `OVN_RECON_RESOURCE_TABS` or `OVN_RECON_RESOURCE_ACTIONS`, which a `console.flag/hookProvider` (`useConsoleIntegrationFlags.ts`) sets from the primary `OvnRecon`'s `status.effective.consolePlugin.integration`, failing closed. Both default off (`spec.consolePlugin.integration.resourceTabs|resourceActions`). `src/consoleExtensions.guard.test.ts` fails if a tab or action is added without its flag. The tabs render the routed pages' own bodies (`NodeNetworkStateBody`, `NetworkBody`); keep each routed page a thin wrapper rather than forking them.

**Physical topology pipeline** (`NodeNetworkStateDetails` → `NodeVisualization`):

1. `useK8sWatchResource` watches live K8s resources: `NodeNetworkState`, `ClusterUserDefinedNetwork`, `UserDefinedNetwork`, `NetworkAttachmentDefinition`, `RouteAdvertisements`, `NodeNetworkConfigurationEnactment`, `VTEP` (EVPN; absent on clusters without it), and the viewed node's own `Node` (for its `k8s.ovn.org/vteps` annotation only)
2. `nodeVisualizationSelectors.ts` — pure functions that extract relationships from raw resource data (VRF routes, CUDN/NAD associations, LLDP neighbors, route advertisement lookups)
3. `nodeVisualizationModel.ts` — builds a graph model: nodes typed as `interface | ovn-mapping | cudn | udn | attachment | nad | vrf | lldp-neighbor | other`, and edges between them
4. `nodeVisualizationLayout.ts` — assigns grid positions using gravity-based column sorting (no external graph library)
5. `NodeVisualization.tsx` — renders the graph as an SVG/HTML grid using PatternFly components

**Logical topology** (`NodeLogicalTopologyDetails`): Fetches JSON snapshots from the collector service at `/api/v1/snapshots/:nodeName`. Feature-gated by `useOvnCollectorFeatureGate`, which watches the `OvnRecon` CR for `spec.collector.enabled`.

**Cluster search** (`ClusterSearch` on the overview): merges the collector's `/api/v1/lookup/{ip|mac|cidr|name}/{value}` hits with browser-side hits from the NodeNetworkStates the overview already watches. `clusterSearchModel.ts` is the pure part (input detection, merging, folding of covering routes, link building); result links use the `?select=` deep links of the three graph pages.

**Links out to the console** (`src/linkOut/`, `ovn-recon-zdt.4`): a link to an object OVN Recon does not own is a `LinkTarget` resolved by the pure `registry.ts` against `ConsoleCapabilities`, and rendered by `ConsoleLink` / `SecondaryLinks` (`LinkOut.tsx`) as an in-app react-router link, or as plain text when no page is there. `useConsoleCapabilities` detects other plugins from the `pluginName` of navigation extensions (never page extensions, which would download the page) and CRDs from the `OVN_RECON_CRD_*` `console.flag/model` flags; `registry.test.ts` keeps those flags equal to `CRD_FLAGS`. Both drawers use it; add a destination as a `LinkOutProvider` in `registry.ts` instead of building a path at the call site. Network Observability's "View traffic" (`ovn-recon-vqd.1`) is such a provider: a secondary link on a Node, CUDN, UDN or Service target, offered only when `capabilities.netobserv` (the plugin's `NETOBSERV_LOKI_ENABLED` flag plus the `cluster` FlowCollector, read only once the plugin is seen) says the page would have data; the header comment of `registry.ts` records what was read from the netobserv source. Jest replaces the hook with "nothing loaded" (`jest.setup.js`) because the SDK does not load under jest.

**All UI components use PatternFly v6** to stay consistent with OpenShift 4.20+.

### Collector (`collector/`)

Go HTTP server at port 8090. Attempts live OVN interrogation via pod exec into `openshift-ovn-kubernetes` / `openshift-frr-k8s` namespaces. Falls back to static fixture files under `fixtures/snapshots/` on failure (adds `LIVE_PROBE_FAILED` warning in response).

Canonical type contract shared across Go and TypeScript:
- Go types: `collector/internal/snapshot/types.go`
- TypeScript types: `src/types.ts` (`LogicalTopologySnapshot` and related interfaces)
- JSON schema: `collector/api/logical-topology-snapshot.schema.json`

### Operator (`operator/`)

Kubebuilder-generated operator. Reconciles `OvnRecon` CRs (`recon.bewley.net/v1beta1`) into `Deployment`, `Service`, and `ConsolePlugin` resources. The primary instance (oldest CR) owns cluster-scoped resources. OLM bundle lives in `operator/bundle/`.

## Task Tracking

This project uses **bd** (beads) for issue tracking. The canonical store is an
embedded Dolt database under `.beads/`; it is not committed as ordinary files, and
there is no `bd sync` command. Cross-machine sync rides the code's Git remote under
`refs/dolt/data`:

```bash
bd prime              # Workflow context + memories (hooks run this on session start)
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress
bd close <id>
bd dolt push          # Publish Dolt history to origin at session end
bd dolt pull          # Fetch Dolt history from origin (new clone: bd bootstrap)
```

Do not treat any committed JSONL as the source of truth. See `.beads/README.md`.

Planning documents in `docs/tasks/` should include an `Initial Beads Backlog Mapping` section with a table of bead IDs.

## PR Notes

When creating PRs with `gh pr create`, use `--body-file <path>` for multiline bodies — avoid backticks in inline `--body` strings.
