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

### Milestone 1: Collector Skeleton (Go)
- Scaffold `/Users/dale/src/ovn-recon/collector/` module and container build.
- Implement initial probe pipeline for a minimal OVN resource subset.
- Emit snapshot contract from Go code path (file or API/CR producer).
- Add collector `Makefile` and `Dockerfile` to support local and CI image builds.

### Milestone 1.5: CI Build and Operator Wiring
- Create collector-focused GitHub workflow for build/test/image push.
- Update operator deployment flow so collector image is part of managed resources.
- Update `/Users/dale/src/ovn-recon/OPERATOR.md` with collector image, deployment model, and operational notes.
- Ensure repository CI covers collector and operator integration paths.

### Milestone 2: Alternate View Scaffold
- Add new node-scoped route/page and navigation entry from node list.
- Implement placeholder logical topology page shell with PatternFly layout.

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

## Initial Beads Backlog Mapping
Created bead issues:

| Work Item | Proposed Type | Planned Issue ID |
|---|---|---|
| Phase 2 epic: Logical OVN topology alternative view | epic | `ovn-recon-e18` |
| Define snapshot schema and fixture pack | task | `ovn-recon-e18.1` |
| Add route and node-list entry point for logical view | task | `ovn-recon-e18.2` |
| Implement logical topology renderer MVP | task | `ovn-recon-e18.3` |
| Build real data snapshot integration path | task | `ovn-recon-e18.4` |
| Scale/perf hardening and regression test coverage | task | `ovn-recon-e18.5` |
| Scaffold Go collector component and container image | task | `ovn-recon-e18.6` |
| Port spike resource modeling/parsing into typed Go pipelines | task | `ovn-recon-e18.8` |
| Add collector CI workflow for build/push | task | `ovn-recon-e18.9` |
| Integrate collector image into operator deployment and docs | task | `ovn-recon-e18.10` |

## Acceptance Criteria (Phase 2 initial release)
- Node list screen exposes a per-node entry to logical topology view (for example, a third table column).
- Existing physical node visualization path remains intact and functional.
- Logical route is node-scoped (for example `/ovn-recon/ovn/:name`) to account for OVN-IC host perspective differences.
- Logical view renders from `LogicalTopologySnapshot` contract.
- Logical view handles larger graphs better than the current strict columnar strategy.
- Documentation includes architecture, test fixtures, and known limits.
- Collector has repository-local build assets (`Makefile`, `Dockerfile`) and CI workflow.
- Operator deployment flow and `OPERATOR.md` include collector image integration details.
