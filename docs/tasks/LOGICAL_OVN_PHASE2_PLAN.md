# Phase 2 Plan: Logical OVN Topology View

## Intent
Phase 2 introduces a new **logical topology** view that complements (not replaces) the existing Phase 1 physical/topology view.

- Phase 1 remains the current per-node physical and bridge/mapping-focused visualization.
- Phase 2 adds an alternative logical OVN view focused on OVN constructs and relationships.
- The Phase 2 entry point must be linked from the initial node list screen.

## Assessment Update (2026-02-13)
After reviewing the `ovn-explorer` spike copied into:
- `/Users/dale/src/ovn-recon/collector/_spike/ovn-explorer-samples/src/ovn/models.py`
- `/Users/dale/src/ovn-recon/collector/_spike/ovn-explorer-samples/src/ovn/connection.py`

The project direction is updated as follows:
- The Python spike is a **good discovery artifact** for resource coverage, field mapping, and edge-case output handling.
- The Python implementation should **not** be promoted directly to production collector runtime for ovn-recon.
- Phase 2 should use a **Go collector service** in a separate container image under `/Users/dale/src/ovn-recon/collector/`.

### Why the direction changed
- OVN command output normalization in the spike is intentionally defensive but regex-heavy and brittle for long-term server-side operation.
- The spike architecture is desktop-oriented (kubeconfig/local cache assumptions) while Phase 2 requires in-cluster, ServiceAccount-based runtime.
- The current repo already has significant Go operational surface (`/Users/dale/src/ovn-recon/operator/`), making Go a better fit for image build, deployment, and maintenance consistency.

## Implementation Update (2026-02-13)

### Completed so far
- Collector scaffold exists and builds:
  - `/Users/dale/src/ovn-recon/collector/go.mod`
  - `/Users/dale/src/ovn-recon/collector/Makefile`
  - `/Users/dale/src/ovn-recon/collector/Dockerfile`
  - `/Users/dale/src/ovn-recon/collector/cmd/ovn-collector/main.go`
- File-backed HTTP snapshot serving is implemented:
  - `GET /api/v1/snapshots/:nodeName`
  - fallback to `default.json` when node snapshot is absent
- Canonical contract artifacts are in place:
  - Go types in `/Users/dale/src/ovn-recon/collector/internal/snapshot/types.go`
  - JSON schema in `/Users/dale/src/ovn-recon/collector/api/logical-topology-snapshot.schema.json`
  - TypeScript types in `/Users/dale/src/ovn-recon/src/types.ts`
- Fixture corpus exists for baseline/dense/parser-edge scenarios under:
  - `/Users/dale/src/ovn-recon/collector/fixtures/snapshots/`
- Node-scoped logical route and list entry are implemented and feature-gated:
  - route: `/ovn-recon/ovn/:name`
  - list column is conditional on `ovn-collector` gate
- Operator API/schema and behavior now include:
  - `spec.featureGates.ovn-collector`
  - `spec.collectorImage.{repository,tag,pullPolicy}`
  - collector Deployment+Service reconciliation behind feature gate
  - collector tag/pullPolicy inheritance from plugin image defaults
- Collector CI workflow is added:
  - `/Users/dale/src/ovn-recon/.github/workflows/collector-release.yaml`
  - follows existing `v*` tag semantics and prerelease expiry label pattern

### Learned revisions
- Repository name normalized to `quay.io/dbewley/ovn-collector` (not `ocn-collector`).
- Feature-gated UI is practical and necessary; route and list link should remain hidden unless enabled.
- Local full operator test suites require envtest binaries and Docker; focused package tests remain useful for iteration.

## Product Scope

### In Scope
- Add a new route and page for logical topology visualization.
- Add clear navigation from `NodeNetworkStateList` to the new logical view.
- Define and use a canonical `LogicalTopologySnapshot` model for rendering.
- Build a server-side Go collector that probes OVN resources and emits snapshot data for the UI.
- Render the logical graph with grouping/collapse and filtering for scale.
- Keep Phase 1 and Phase 2 views independently maintainable.

### Out of Scope (initial Phase 2 delivery)
- Removing or redesigning the current Phase 1 visualization.
- Full historical replay/time-travel of topology states.
- Advanced root-cause analysis workflows beyond baseline inspect/drill-down.
- Shipping the Python spike as a production service.

## UX Model

### View Positioning
- **Physical View (Phase 1):** How host/network interface configuration is wired into OVN.
- **Logical View (Phase 2):** OVN logical constructs (switches, routers, ports, NAT/LB policies, and attachments) and their relationships.

### Navigation
- Keep existing `/ovn-recon/node-network-state/:name` unchanged.
- Add a node-scoped Phase 2 route to support OVN-IC view differences per host.
  - Proposed route: `/ovn-recon/ovn/:name`
- Add a per-row link from `/ovn-recon/node-network-state` list screen to open the logical view for that host (likely a third table column).

## Technical Approach

### 1. Canonical Data Contract
Define a versioned model in Go + TypeScript:
- `LogicalTopologySnapshot`
- `nodes[]`, `edges[]`, `groups[]`, `warnings[]`
- `metadata` (schema version, generated-at timestamp, source health)

The UI should only consume this model, not raw heterogeneous resources directly.

### 2. Data Collection/Assembly
Deliver in two increments:
- Increment A: Fixture-backed and/or mocked snapshot to build UI behavior.
- Increment B: Real data assembly path from a Go collector image (API endpoint or CR-backed snapshot) feeding the same contract.

Collector placement and boundaries:
- Collector code root: `/Users/dale/src/ovn-recon/collector/`
- Python spike remains in `/Users/dale/src/ovn-recon/collector/_spike/` for reference fixtures and parser edge-case examples only.
- Collector responsibilities:
  - probe OVN resources in-cluster using ServiceAccount credentials
  - normalize resource data into `LogicalTopologySnapshot`
  - publish snapshot + health/freshness metadata to consumers
- UI responsibilities:
  - render and interact with topology
  - avoid direct `ovn-*ctl` command execution/parsing

### 2.1 Collector Build and Release Requirements
- Add collector build targets (`Makefile`) under `/Users/dale/src/ovn-recon/collector/`.
- Add collector container build definition (`Dockerfile`) under `/Users/dale/src/ovn-recon/collector/`.
- Add GitHub Actions workflow in `/Users/dale/src/ovn-recon/.github/workflows/` for collector image build/push.
- Configure collector image destination to `quay.io/dbewley/ovn-collector` (repository to be created).

### 3. Rendering Stack
- Preferred renderer: `@patternfly/react-topology` for OpenShift/PatternFly consistency.
- Layout strategy: start with hierarchical/grouped layout; evaluate ELK for dense graphs.
- Interaction baseline: zoom/pan, search, kind filters, collapse/expand groups, selection drawer.

### 4. Scale and Resilience
- Default collapsed group states by logical domains.
- Optional edge simplification/bundling for high edge count.
- Explicit stale/error states in UI based on snapshot metadata.

## Delivery Plan

### Milestone 0: Architecture and Contract
- Draft `LogicalTopologySnapshot` schema.
- Define boundaries between data collection and rendering.
- Capture acceptance criteria and fixtures, including fixtures derived from Python spike outputs.
Status: completed.

### Milestone 1: Collector Skeleton (Go)
- Scaffold `/Users/dale/src/ovn-recon/collector/` module and container build.
- Implement initial probe pipeline for a minimal OVN resource subset.
- Emit snapshot contract from Go code path (file or API/CR producer).
- Add collector `Makefile` and `Dockerfile` to support local and CI image builds.
Status: completed for scaffold + file-backed snapshot serving; live OVN probing remains pending.

### Milestone 1.5: CI Build and Operator Wiring
- Create collector-focused GitHub workflow for build/test/image push.
- Update operator deployment flow so collector image is part of managed resources.
- Start with collector as standalone Deployment and preserve path to optional DaemonSet mode for per-node OVN-IC collection.
- Add `OvnRecon` feature gate to enable/disable Phase 2 logical topology features.
- Update `/Users/dale/src/ovn-recon/OPERATOR.md` with collector image, deployment model, and operational notes.
- Ensure repository CI covers collector and operator integration paths.
Status: mostly completed; follow-up controller/manifests work continues in remaining operator tasks.

### Milestone 2: Alternate View Scaffold
- Add new node-scoped route/page and navigation entry from node list.
- Implement placeholder logical topology page shell with PatternFly layout.
Status: completed and feature-gated behind `ovn-collector`.

### Milestone 3: Graph Rendering MVP
- Implement renderer integration using snapshot fixtures.
- Add core interactions (pan/zoom/search/filter/select).
- Add drawer for logical node details.

### Milestone 4: Real Data Integration
- Integrate live snapshot producer path from Go collector.
- Wire UI page to live snapshot and stale/error metadata.

### Milestone 5: Scale Hardening and Validation
- Validate medium/large topology performance.
- Tune grouping/collapse/layout strategies.
- Add tests and fixture coverage for regressions.

## Parallel-Track Execution
This Phase 2 work runs in parallel with ongoing Phase 1 improvements:
- No Phase 1 behavior regression accepted.
- Shared selector/model helpers are allowed only when contract is clear.
- UI entry points should let users choose physical vs logical without ambiguity.

## Pre-Implementation Checklist

### 1. Security and RBAC
- Define collector RBAC for:
  - read access to required resources
  - pod `exec` access in:
    - `openshift-ovn-kubernetes`
    - `openshift-frr-k8s`
- Keep namespace targets configurable for future expansion.
- Document ServiceAccount, Roles/ClusterRoles, and bindings used by collector runtime.

### 2. Snapshot Transport and Contract Discipline
- Choose and document snapshot delivery mechanism (API endpoint, CR, or other).
- Define payload limits and behavior for dense topologies.
- Define schema versioning and compatibility expectations between collector and UI.
  - Day-1 decision: serve cached snapshot JSON over HTTP from collector.

### 3. Freshness and Failure Semantics
- Define probe interval and timeout budgets.
- Define staleness thresholds surfaced in UI.
- Define degraded-mode behavior for partial probe failures.

### 4. Performance Budgets
- Establish target topology sizes (nodes, routers, switches, ports, edges).
- Set collector resource budgets (CPU/memory requests/limits).
- Set UI render interaction budget for large graphs.

### 5. Operator Integration Shape
- Preferred deployment model: collector as its own deployment (not sidecar).
- Keep design open for daemonset evolution (likely for per-node OVN-IC perspective collection).
- Add `OvnRecon` feature gate to optionally enable Phase 2 logical topology features.
  - Day-1 decision: collector namespace matches console plugin namespace (`spec.targetNamespace`).

### 6. Observability and Diagnostics
- Define collector metrics and key error counters.
- Add structured logging fields (node/source/snapshot identifiers).
- Define health/readiness behavior and minimal diagnostics endpoint.

### 7. Test and Release Gates
- Add fixture/golden tests for parser and snapshot stability.
- Add CI checks for collector build and operator integration.
- Reuse existing Phase 1 tag/release conventions for collector image release flow.

### 8. Rollout and Rollback
- Define staged rollout plan for enabling Phase 2 in clusters.
- Define rollback path that preserves Phase 1 behavior.
- Add a Phase 1 regression checklist as a release gate for Phase 2 changes.

## Day-1 Decisions (Locked)

### Snapshot Serving Path
- Initial implementation serves cached `LogicalTopologySnapshot` JSON over HTTP from the collector.
- UI consumes this HTTP endpoint for `/ovn-recon/ovn/:name` rendering.
- Alternative transport options (CR/API aggregation) remain future enhancements.

### Initial OvnRecon Phase 2 Config Shape
- Add Phase 2 feature gate under `OvnRecon` to enable/disable logical topology features.
- Add collector image config under `OvnRecon`:
  - `repository`: `quay.io/dbewley/ovn-collector`
  - `tag`: default to same value used for console plugin image tag
  - `pullPolicy`: default to same value used for console plugin image pullPolicy
- Collector deployment namespace defaults to `spec.targetNamespace` (same namespace as console plugin deployment).
- Deployment mode starts as standalone Deployment, with explicit future path to DaemonSet mode.

### Node Perspective Resolution
- `/ovn-recon/ovn/:name` is treated as node-scoped logical perspective input.
- Collector and UI contracts must include explicit behavior for:
  - missing node
  - unreachable probe target
  - stale snapshot for a specific node

### Probe Command Matrix
- Before implementation, define and commit an MVP probe matrix listing:
  - commands run
  - namespace/pod/container target
  - output parser path
  - required RBAC verb/resource bindings

## Initial Beads Backlog Mapping
Current Phase 2 bead status:

| Work Item | Type | Issue ID | Status |
|---|---|---|---|
| Phase 2 epic: Logical OVN topology alternative view | epic | `ovn-recon-e18` | `OPEN` |
| Define snapshot schema and fixture pack | task | `ovn-recon-e18.1` | `CLOSED` |
| Add route and node-list entry point for logical view | task | `ovn-recon-e18.2` | `CLOSED` |
| Implement logical topology renderer MVP | task | `ovn-recon-e18.3` | `OPEN` |
| Build real data snapshot integration path | task | `ovn-recon-e18.4` | `OPEN` |
| Scale/perf hardening and regression test coverage | task | `ovn-recon-e18.5` | `OPEN` |
| Scaffold Go collector component and container image | task | `ovn-recon-e18.6` | `CLOSED` |
| Port spike resource modeling/parsing into typed Go pipelines | task | `ovn-recon-e18.8` | `OPEN` |
| Add collector CI workflow for build/push | task | `ovn-recon-e18.9` | `CLOSED` |
| Integrate collector image into operator deployment and docs | task | `ovn-recon-e18.10` | `CLOSED` |
| Specify snapshot transport, freshness semantics, and performance budgets | task | `ovn-recon-e18.13` | `OPEN` |
| Define collector RBAC and configurable target namespaces | task | `ovn-recon-e18.14` | `OPEN` |
| Add Phase 2 feature gate to OvnRecon API and operator behavior | task | `ovn-recon-e18.15` | `CLOSED` |
| Define MVP node probe command matrix and error semantics | task | `ovn-recon-e18.16` | `OPEN` |

## Acceptance Criteria (Phase 2 initial release)
- Node list screen exposes a per-node entry to logical topology view (for example, a third table column).
- Existing physical node visualization path remains intact and functional.
- Logical route is node-scoped (for example `/ovn-recon/ovn/:name`) to account for OVN-IC host perspective differences.
- Logical view renders from `LogicalTopologySnapshot` contract.
- Logical view handles larger graphs better than the current strict columnar strategy.
- Documentation includes architecture, test fixtures, and known limits.
- Collector has repository-local build assets (`Makefile`, `Dockerfile`) and CI workflow.
- Operator deployment flow and `OPERATOR.md` include collector image integration details.
