# Phase 2 Plan: Logical OVN Topology View

## Intent
Phase 2 introduces a new **logical topology** view that complements (not replaces) the existing Phase 1 physical/topology view.

- Phase 1 remains the current per-node physical and bridge/mapping-focused visualization.
- Phase 2 adds an alternative logical OVN view focused on OVN constructs and relationships.
- The Phase 2 entry point must be linked from the initial node list screen.

## Product Scope

### In Scope
- Add a new route and page for logical topology visualization.
- Add clear navigation from `NodeNetworkStateList` to the new logical view.
- Define and use a canonical `LogicalTopologySnapshot` model for rendering.
- Render the logical graph with grouping/collapse and filtering for scale.
- Keep Phase 1 and Phase 2 views independently maintainable.

### Out of Scope (initial Phase 2 delivery)
- Removing or redesigning the current Phase 1 visualization.
- Full historical replay/time-travel of topology states.
- Advanced root-cause analysis workflows beyond baseline inspect/drill-down.

## UX Model

### View Positioning
- **Physical View (Phase 1):** How host/network interface configuration is wired into OVN.
- **Logical View (Phase 2):** OVN logical constructs (switches, routers, ports, NAT/LB policies, and attachments) and their relationships.

### Navigation
- Keep existing `/ovn-recon/node-network-state/:name` unchanged.
- Add a new Phase 2 route (proposed: `/ovn-recon/logical-topology`).
- Add link(s) from `/ovn-recon/node-network-state` list screen to open the logical view.

## Technical Approach

### 1. Canonical Data Contract
Define a versioned model in TypeScript:
- `LogicalTopologySnapshot`
- `nodes[]`, `edges[]`, `groups[]`, `warnings[]`
- `metadata` (schema version, generated-at timestamp, source health)

The UI should only consume this model, not raw heterogeneous resources directly.

### 2. Data Collection/Assembly
Deliver in two increments:
- Increment A: Fixture-backed and/or mocked snapshot to build UI behavior.
- Increment B: Real data assembly path (collector/controller endpoint or CR-backed snapshot) feeding the same contract.

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
- Capture acceptance criteria and fixtures.

### Milestone 1: Alternate View Scaffold
- Add new route/page and navigation entry from node list.
- Implement placeholder logical topology page shell with PatternFly layout.

### Milestone 2: Graph Rendering MVP
- Implement renderer integration using snapshot fixtures.
- Add core interactions (pan/zoom/search/filter/select).
- Add drawer for logical node details.

### Milestone 3: Real Data Integration
- Implement real snapshot producer path.
- Wire UI page to live snapshot and stale/error metadata.

### Milestone 4: Scale Hardening and Validation
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

## Acceptance Criteria (Phase 2 initial release)
- Node list screen exposes a clear entry to logical topology view.
- Existing physical node visualization path remains intact and functional.
- Logical view renders from `LogicalTopologySnapshot` contract.
- Logical view handles larger graphs better than the current strict columnar strategy.
- Documentation includes architecture, test fixtures, and known limits.
