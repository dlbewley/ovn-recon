# Node Visualization: Current Implementation and Refactor Assessment

## Scope
This document describes how `NodeVisualization` currently works and evaluates whether a refactor would improve maintainability, with emphasis on making drawer tabs easier to customize per node type.

Primary files reviewed:
- `src/components/NodeVisualization.tsx`
- `src/components/NodeNetworkStateDetails.tsx`
- `src/types.ts`

## Current Implementation

### High-level flow
1. `NodeNetworkStateDetails` watches and loads five resources (`NodeNetworkState`, `CUDN`, `UDN`, `NAD`, `RouteAdvertisements`) and passes all to `NodeVisualization` (`src/components/NodeNetworkStateDetails.tsx`).
2. `NodeVisualization` performs all of the following inside one component (`src/components/NodeVisualization.tsx`, 2254 lines):
- Domain shaping and ID conventions
- Relationship derivation
- Layout, gravity sorting, and positioning
- SVG rendering and edge rendering
- Interaction state (selection, highlight, pan/zoom)
- Drawer UI and tab content rendering

### Data model layers

#### API resource types
`src/types.ts` defines API-facing types (`Interface`, `NodeNetworkState`, `ClusterUserDefinedNetwork`, `UserDefinedNetwork`, `NetworkAttachmentDefinition`, `RouteAdvertisements`).

#### View model inside component
`NodeVisualization` defines local view-model types (`NodeKind`, `NodeViewModel`, `NodeKindDefinition`) and converts resource objects into view nodes in `buildNodeViewModel` (`src/components/NodeVisualization.tsx:1585`).

#### Registry pattern (partially applied)
A local `nodeKindRegistry` (`src/components/NodeVisualization.tsx:124`) centralizes some kind-specific behavior:
- `renderDetails`
- optional `buildBadges`
- optional `buildLinks`

This is useful, but only for part of the drawer behavior (mostly the "Details" tab).

### Overlay (drawer) tabs today
Tabs are fixed and global for every node:
- `Summary`, `Details`, `Links`, `YAML` (`src/components/NodeVisualization.tsx:1809-1812`)

Tab content is rendered via a chain of conditionals (`src/components/NodeVisualization.tsx:1816-1929`).
- "Details" delegates partly to the registry via `renderDetails`.
- Other tabs are hardcoded in component-level JSX.

Result: changing tab structure by type (for example, VRF-specific tabs or hiding links for synthetic nodes) currently requires editing shared conditional UI logic.

### Relationship and graph methodology
There are effectively multiple relationship pipelines:
1. `connectionGraph` for gravity/path ranking (`src/components/NodeVisualization.tsx:771`)
2. `graph` memo for path highlight traversal (`src/components/NodeVisualization.tsx:1192`)
3. connector rendering loops in SVG (`src/components/NodeVisualization.tsx:1999`)

These pipelines repeat similar rules (NAD/CUDN/UDN and VRF->CUDN matching) in separate places, which increases drift risk.

### Layout methodology
Layout is deterministic column stacking plus gravity sorting and special-case boosts:
- column definitions (`src/components/NodeVisualization.tsx:664`)
- gravity computation over longest paths (`src/components/NodeVisualization.tsx:890` onward)
- manual position assignment per column (`src/components/NodeVisualization.tsx:1100` onward)

This works functionally, but the policy and rendering logic are tightly coupled in one file.

## Assessment: Is a refactor beneficial?
Yes. A targeted refactor would significantly improve maintainability.

### Why
1. The component is too broad in responsibility.
2. Relationship rules are duplicated in three locations.
3. Type customization is only partially registry-driven.
4. Drawer tab composition is not type-driven.
5. `any`-heavy local modeling weakens compile-time safety.

### Most relevant pain point for your goal
Your goal is easier tab customization by type. The current fixed tab shell and global conditional blocks are the primary blockers. The existing registry is a good start, but it does not own tab definitions.

## Suggested Refactor Direction

### 1. Introduce a canonical topology model builder
Create a pure model layer (no React, no JSX) that produces:
- normalized nodes
- normalized edges
- lookup indexes (by node id, kind, resource ref)
- derived relationships (including VRF/RA/CUDN matches)

Suggested location:
- `src/components/node-visualization/model/buildTopologyModel.ts`

This single model should be reused by:
- edge drawing
- highlight traversal
- details/inspector computations
- sort/gravity policies

### 2. Make drawer tabs type-configurable
Extend the registry concept from `renderDetails` to full tab specs.

Example shape:

```ts
export type DrawerTabId = 'summary' | 'details' | 'links' | 'yaml' | string;

export interface DrawerTabSpec {
  id: DrawerTabId;
  title: string;
  isVisible?: (node: NodeViewModel, ctx: DrawerContext) => boolean;
  render: (node: NodeViewModel, ctx: DrawerContext) => React.ReactNode;
}

export interface NodePresentation {
  kind: NodeKind;
  tabs: (ctx: DrawerContext) => DrawerTabSpec[];
  buildNode: (raw: unknown, ctx: ModelContext) => NodeViewModel;
}
```

Then each kind can declare its own tabs:
- `interface`: `summary`, `details`, `yaml`
- `attachment` (synthetic): maybe `summary`, `links` only if meaningful
- `vrf`: `summary`, `routes`, `yaml`

### 3. Resolve active tab per node kind safely
Keep active tab state as `activeTabByKind` or validate selection on node change:
- if prior tab not available for new kind, fallback to the first visible tab

This removes fragile global assumptions about tab availability.

### 4. Split component responsibilities
Suggested module boundary:
- `model/` for derivation and selectors
- `layout/` for gravity and positioning
- `render/` for SVG nodes/edges
- `drawer/` for tab container + tab panels

`NodeVisualization` becomes orchestration only.

### 5. Improve typing incrementally
- Replace `raw?: any` and `buildNodeViewModel(iface: any, type: string)` with discriminated unions.
- Keep `raw` but narrow by `kind` in per-kind builders.

## Proposed methodology (phased)

### Phase 1: Documentation + extraction scaffolding
- Capture current behaviors as explicit selectors/helpers.
- Extract duplicate matching logic (RA selects CUDN, NAD upstream IDs, CUDN matching).
- No visual behavior change.

### Phase 2: Topology model unification
- Build one canonical `edges` list and derive both `graph` and connector rendering from it.
- Replace duplicated loops with shared edge list.

### Phase 3: Drawer tab registry
- Introduce tab spec API and migrate existing four tabs as defaults.
- Move kind-specific tab decisions into the registry.

### Phase 4: Layout extraction
- Move gravity and position logic into pure functions.
- Add tests for deterministic ordering and regression safety.

## Risks and mitigations

### Risks
1. Subtle visual regressions in connector placement and ordering.
2. Behavioral drift in heuristics (VRF-RA name truncation, NAD-CUDN matching).
3. Drawer tab state bugs when switching node kinds.

### Mitigations
1. Snapshot fixture tests for `edges`, `nodePositions`, and `tabs(kind)`.
2. Golden test data for key scenarios (`br-ex`, localnet, UDN-backed NAD).
3. Keep first refactor behavior-preserving; feature changes only after extraction.

## Recommendation
Proceed with refactor, but keep it incremental and model-first.

If your immediate priority is tab customization, start with Phase 3 on top of small helper extraction from Phase 1:
- create a tab registry API,
- map current hardcoded tabs into that API,
- then allow per-kind tab sets without touching core layout/render logic yet.

That gives fast maintainability gains with low blast radius, and sets up deeper cleanup afterward.
