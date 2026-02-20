# Node Visualization LLDP Neighbor Column Plan

## Overview
Link Layer Discovery Protocol (LLDP) provides layer-2 neighbor discovery data that helps operators understand what each host interface is physically connected to (switch identity, remote port, chassis ID, and capabilities). In the OVN Recon topology view, exposing LLDP as an optional column adds physical adjacency context next to interface wiring without changing the default graph density, which improves troubleshooting of cabling, uplink mapping, and host-to-switch reachability when LLDP is available.

## Intent
Add LLDP neighbor visibility to the physical topology graph in `src/components/NodeVisualization.tsx` without changing default behavior for clusters that do not report LLDP data.

## Requirements
- Show LLDP neighbors in a dedicated column to the left of `Physical Interfaces`.
- Keep the LLDP column hidden by default.
- Offer a toggle in the existing top control row only when both of these are true across interfaces:
  - at least one interface has `lldp.enabled: true`
  - at least one interface has `lldp.neighbors[]` data
- Do not show the LLDP toggle when no LLDP data is available for the selected host.

## Current Baseline
- Column rendering is driven by `columns` and `visibleColumns` in `src/components/NodeVisualization.tsx`.
- Existing toggles:
  - `Show Net Attach Defs` (`showNads`)
  - `Show hidden columns` (`showHiddenColumns`)
- Graph connectors and path traversal are based on `topologyEdges` from `buildTopologyEdges(...)` in `src/components/nodeVisualizationModel.ts`.

## LLDP Data Shape (Fixture-Backed)
Reference fixture: `test/fixtures/nns/host-lldp.json`

Observed interface structure:
- `interfaces[*].lldp.enabled: boolean`
- `interfaces[*].lldp.neighbors: Array<Array<Record<string, unknown>>>`

Example TLV payload keys in each neighbor block:
- `system-name`
- `system-description`
- `system-capabilities`
- `chassis-id`
- `port-id`

Notes:
- LLDP neighbors are attached to local interface records (not top-level).
- The fixture shows LLDP only on ethernet interfaces (`enp44s0`, `enp45s0`).

## Proposed Model Additions
Add LLDP selector helpers in `src/components/nodeVisualizationSelectors.ts`:

- `extractLldpNeighbors(interfaces: Interface[]): LldpNeighborNode[]`
- `hasLldpNeighbors(interfaces: Interface[]): boolean`

Proposed view model:
- `id: string` (example: `lldp-enp44s0-0`)
- `localInterface: string`
- `neighborIndex: number`
- `systemName?: string`
- `portId?: string`
- `chassisId?: string`
- `systemDescription?: string`
- `capabilities: string[]`
- `rawTlvs: Record<string, unknown>[]`

Parsing rules:
- Treat each outer `neighbors[]` entry as one remote neighbor.
- Fold TLV objects into a normalized summary by known keys.
- Display label precedence:
  1. `system-name`
  2. `chassis-id`
  3. `LLDP Neighbor <n>`

## UI and Interaction Design

### Toggle Behavior
- Add state: `showLldpNeighbors` (default `false`).
- Compute `hasLldpData` from LLDP-enabled presence plus neighbor payload presence.
- Render toggle only when `hasLldpData === true`.
- Toggle placement: alongside existing switches at the top (`Flex` row).
- Suggested label: `Show LLDP neighbors`.

### Column Behavior
- Add column definition:
  - key: `lldp`
  - name: `LLDP Neighbors`
  - data: extracted LLDP neighbor nodes
- Insert `lldp` column before `eth`.
- Column visible only when `showLldpNeighbors` is enabled.
- Default remains hidden even if LLDP data exists.

### Node and Edge Behavior
- Render one LLDP graph node per discovered LLDP neighbor.
- Add edges from each LLDP node to its local physical interface node.
- Integrate LLDP edges into `topologyEdges` so:
  - connector rendering remains centralized
  - highlight traversal can include LLDP nodes

### Drawer Behavior
- Add `NodeKind` value `lldp-neighbor`.
- Add registry entry for LLDP details:
  - Local interface
  - System name
  - Port ID
  - Chassis ID
  - Capabilities
  - System description

## Layout Impact
- LLDP column shifts existing columns one slot right only when enabled.
- When LLDP is disabled, layout is unchanged from current behavior.
- Node positions for LLDP should be deterministic by:
  1. local interface gravity
  2. neighbor index (stable tie-break)

## Implementation Plan

### Phase 1: LLDP Selector and Parsing
- Add LLDP extraction helpers in `nodeVisualizationSelectors.ts`.
- Add fixture-backed tests in `src/components/nodeVisualizationSelectors.test.ts` using `host-lldp.json`.

### Phase 2: Graph Column and Toggle Wiring
- Add `showLldpNeighbors` and `hasLldpData` in `NodeVisualization.tsx`.
- Add conditional LLDP toggle in top controls.
- Add LLDP column rendering and node positioning.

### Phase 3: Edge/Drawer Integration
- Extend `buildTopologyEdges(...)` to accept LLDP nodes and emit LLDP->interface edges.
- Add LLDP node kind rendering and drawer details.
- Add/extend tests in `src/components/nodeVisualizationModel.test.ts` for LLDP edge creation.

## Initial Beads Backlog Mapping
Current LLDP visualization bead status:

| Work Item | Type | Issue ID | Status |
|---|---|---|---|
| Show LLDP neighbors column in NodeVisualization | task | `ovn-recon-eez` | `OPEN` |

## Test Plan
- Selector tests:
  - Extracts expected neighbors from `host-lldp.json`.
  - Returns false/no nodes when LLDP neighbor lists are absent.
- Model tests:
  - LLDP edges point to correct local interface.
  - Edge dedupe still holds.
- Manual UI checks:
  - Host with LLDP data: toggle is visible, default off.
  - Enable toggle: LLDP column appears left of Physical Interfaces.
  - Disable toggle: LLDP column disappears, remaining layout returns to baseline.
  - Host without LLDP data: no LLDP toggle.

## Out of Scope
- LLDP polling intervals or refresh behavior changes.
- Non-graph LLDP reporting views.
- Collector-side LLDP normalization changes.

## Acceptance Criteria
- LLDP toggle is shown only when LLDP neighbor data exists.
- LLDP column is hidden by default and appears only when toggled on.
- LLDP column renders to the left of Physical Interfaces.
- LLDP nodes connect to corresponding physical interfaces.
- Existing visualization behavior remains unchanged when LLDP toggle is off.

## References
- [Containerization of LLDP for OpenShift](https://schmaustech.blogspot.com/2025/11/containerization-of-lldp-for-openshift.html)
- [Nmstate LLDP feature documentation](https://nmstate.io/features/lldp.html)
- [IEEE 802.1AB LLDP overview](https://en.wikipedia.org/wiki/Link_Layer_Discovery_Protocol)
