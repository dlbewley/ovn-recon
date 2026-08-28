# Plan: OVN Perspective — Cluster and Per-Node Logical Topology Views

## Intent

Add an **OVN perspective**: a view of the logical OVN constructs bound on the
cluster (logical switches, routers, ports, and their relationships), with both
a **cluster-scoped view** and a **per-node view**, mirroring how the physical
node visualization has a per-node entry point.

This supersedes the Phase 2 MVP renderer (`ovn-recon-e18`). That work proved
the pipeline — route, feature gate, collector, operator wiring, RBAC — and all
of that infrastructure is retained. The *display* itself (generic force-free
circles/lines in `NodeLogicalTopologyDetails.tsx` + `logicalTopologyModel.ts`)
is a placeholder and is not worth preserving; it will be replaced wholesale.

Decision context: `ovn-recon-s3t.32` records that the logical view is a
separate display from the physical lane view, with pointers across the seam
(`ovn-recon-s3t.31`). This document is the planning that bead asked for.

## What OVN-Kubernetes actually builds (the shapes we must draw)

Per network, OVN-Kubernetes constructs a repeating "ladder" between the
outside world (north) and workloads (south):

```
north  ─  external switch (ext_<node>)          ← bridged to br-ex / physnet
          gateway router (GR_<node>)            ← per node, does SNAT
          join switch (join)                    ─┐
          transit switch (per-zone, OVN-IC)     ─┤ east-west waist
          cluster router (ovn_cluster_router)   ─┘
          workload switch (<node>, per subnet)
south  ─  logical switch ports (one per pod)
```

Topology variants bend the ladder but keep the axis:

- **Default cluster network (Layer3)**: per-node workload switch, one
  distributed cluster router, per-node GRs, join + transit switches.
- **UDN/CUDN Layer3**: same ladder replicated per network, distinct GRs and
  cluster router per network.
- **UDN/CUDN Layer2**: one cluster-wide workload switch; per-node GRs; the
  "cluster router" is a transit router (per-node instances stitched by
  tunnels).
- **CUDN Localnet**: no routers at all — one switch bridged directly to a
  provider network via a bridge mapping. The ladder degenerates to a single
  rung, and that is fine; it should render as such.

Two consequences drive the design:

1. **OVN-IC means per-node NB databases (zones).** The per-node snapshot the
   collector already serves *is* the node's zone. A cluster view must be
   assembled from per-node zones, deduplicating the constructs that appear in
   every zone (transit switches, per-network cluster routers with per-zone
   instances).
2. **Subnets are not unique across networks** (NAT disambiguates overlapping
   UDN subnets). Association must come from **names and `external_ids`**,
   never subnet containment alone.

## Layout concept: tiered ladder, not lanes

The physical view's left-to-right lane model does not fit; this view gets its
own geometry, still deterministic and library-free like the physical layout.

- **Vertical axis = traffic direction.** North (external/underlay) at top,
  workloads at bottom. Fixed tiers: `external-switch`, `gateway-router`,
  `join/transit` (the east-west waist), `cluster-router`, `workload-switch`,
  `workload-ports`.
- **Horizontal axis = network.** One tinted vertical band per network: the
  default cluster network first, then each UDN/CUDN. Each network gets a
  stable color (hash of name), used for its band, its constructs, and its
  cross-view affordances. This is the visual answer to "which constructs did
  *my* UDN create?" — the primary user question.
- **Position is a pure function of (network, tier, node-ordinal).** No force
  layout, no external graph library — consistent with `nodeVisualizationLayout.ts`
  philosophy.
- **Node-replicated constructs** (GRs, node switches, external switches)
  stack horizontally within their tier cell in the cluster view; beyond a
  threshold they collapse to an aggregate chip ("6 gateway routers", expand
  on demand).
- **Pod-scale LSPs never render individually by default.** A workload switch
  shows a port-count badge; the drawer lists and filters ports; selecting a
  pod port from the drawer highlights it. Router ports render as attachment
  points on edges, with addresses as edge labels (mirroring how the reference
  mermaid diagram annotates 100.64/16, 100.88/16, masquerade addresses).

### The two views

- **Cluster view** (`/ovn-recon/ovn`): network-major. All networks' ladders
  side by side, transit switches as the east-west spine. Entry from the OVN
  Recon nav. Click a network band header → filter to that network; click a
  node-replicated construct → jump to that node's view.
- **Per-node view** (`/ovn-recon/ovn/:name`): the node's zone. Same tiers,
  same network bands, but only that node's instances. The transit switch
  renders as an explicit seam with a peer count ("tunnels to 5 nodes"),
  linking back to the cluster view. Cross-link to/from the physical view of
  the same node at the ingress/egress points (external switch ↔ br-ex bridge
  mapping), per `ovn-recon-s3t.31`/`.32`.

### Semantic classification layer

Raw NB rows carry generated names (`GR_worker-1`, `ext_worker-1`,
`rtos-worker-1`, `cluster_udn_blue_...`). A pure classification module maps
each row to `{network, role, node}` using OVN-Kubernetes naming conventions
plus `external_ids` (`k8s.ovn.org/topology`, `k8s.ovn.org/network`, etc.),
falling back to `other` rather than guessing. This is the keystone of the
whole view and gets fixture-driven tests per topology variant.

## Collector re-evaluation (prerequisite, per s3t.32)

Today's probe collects names only. The view needs a **snapshot contract v2**:

- Additional fields on existing tables: `external_ids`, `other_config`
  (subnets), LRP `networks`/`mac`/`gateway_chassis`, LSP `addresses`/`type`/
  `options` (router-port linkage lives in `options:router-port`).
- Additional tables: `NAT`, `Logical_Router_Static_Route` (these expose the
  UDN NAT/masquerade structure that authoritatively disambiguates overlapping
  subnets); load balancers deferred.
- Typed, semantic node/edge kinds in the payload rather than
  `map[string]any` blobs — but classification stays in the frontend so the
  collector remains a faithful transcriber (raw-ish v2 payload, semantics in
  TS). Go types, TS types, and JSON schema move in lockstep as today.
- A **cluster assembly** answer: either a collector endpoint that merges all
  zones, or the frontend fanning out over per-node snapshots and merging
  client-side. Decide in the design bead; the dedup rules (transit switch,
  per-network router identity across zones) are the same either way.
- Fixture corpus v2 captured from a real cluster (hub) covering: default
  network, Layer2 primary UDN, Layer3 CUDN, Localnet CUDN.

## Staging

- **Stage A — foundations**: design spec, contract v2, probe expansion,
  fixtures, classification layer.
- **Stage B — per-node view**: ladder layout engine + node view replacing the
  placeholder renderer. First user-visible payoff.
- **Stage C — cluster view**: zone assembly + cluster route + aggregation.
- **Stage D — correlation & polish**: K8s resource links (UDN/CUDN CRs, Pods),
  NAT/route detail in drawer, physical↔logical seam links, docs, scale tests.

## Decisions (ovn-recon-kck.1, 2026-08-28)

Formerly the open-questions section. Recorded here so they are not
re-litigated; revisit only with a new decision entry, not by silent drift.

1. **Cluster assembly: aggregate transport, semantic merge client-side.**
   The collector gains one aggregate endpoint, `GET /api/v1/snapshots`,
   returning every node's zone snapshot in a single payload (one fetch,
   cache-friendly, composes with the `ovn-recon-e18.17` cache). The collector
   does **not** merge zones — dedup rules (transit switch identity,
   per-network router identity across zones) are semantic, name-based
   judgments, and semantics live in the frontend classification layer. The
   collector stays a transcriber.
2. **Snapshot contract v2 is table-oriented, not graph-oriented.** v1 made
   the collector invent graph nodes/edges, which forced semantics into the
   transcriber. v2 replaces `nodes`/`edges`/`groups` with a `database` object
   of typed NB tables (`logicalRouters`, `logicalRouterPorts`,
   `logicalSwitches`, `logicalSwitchPorts`, `nats`, `staticRoutes`), each row
   carrying the columns the view needs (`external_ids`, `other_config`,
   addresses, options, …). `metadata.schemaVersion` becomes `"2"`. The
   frontend renders only v2; a v1 payload (no `database`) produces a
   "collector needs upgrade" empty state, not a best-effort render. v1
   fixtures are migrated, not dual-supported.
3. **Rendering substrate: custom SVG**, consistent with the physical view.
   PatternFly Topology rejected: force/dagre layouts fight the deterministic
   tier×band geometry that is the whole point, and it would be the project's
   first graph-library dependency.
4. **SB `Port_Binding` is out of MVP.** Zone membership already yields
   placement; classification never needs the SB DB. Revisit only if a
   concrete construct proves unplaceable from NB + zone.
5. **Machine-network context is minimal.** Each node's ladder column gets a
   slim node chip at the north edge (name only, linking to the physical
   view). No VIPs, no machine-subnet rendering — the machine network belongs
   to the physical view.
6. **Aggregation threshold**: node-replicated constructs stack up to 4 nodes;
   5+ collapse to an aggregate chip with count, expandable per network band.
7. **Network band colors**: stable hash of network name into a fixed
   palette; the default cluster network always uses the neutral first slot
   and always renders as the leftmost band.

## Initial Beads Backlog Mapping

| Bead | Title | Stage |
|---|---|---|
| ovn-recon-kck | OVN perspective: cluster and per-node logical topology views (epic) | — |
| ovn-recon-kck.1 | Design spec: layout, interaction, and contract decisions | A |
| ovn-recon-kck.2 | Snapshot contract v2 (Go + TS + JSON schema) | A |
| ovn-recon-kck.3 | Expand collector probe to v2 field/table coverage | A |
| ovn-recon-kck.4 | Capture fixture corpus v2 from real cluster | A |
| ovn-recon-kck.5 | Semantic classification layer (name/external_ids → network/role/node) | A |
| ovn-recon-kck.6 | Ladder layout engine (tier × network-band geometry) | B |
| ovn-recon-kck.7 | Per-node OVN view replacing placeholder renderer | B |
| ovn-recon-kck.8 | Cluster zone assembly and dedup | C |
| ovn-recon-kck.9 | Cluster-scoped OVN view route and navigation | C |
| ovn-recon-kck.10 | Drawer semantics and K8s resource cross-links | D |
| ovn-recon-kck.11 | Physical↔logical seam cross-links | D |
| ovn-recon-kck.12 | Concepts documentation for the logical view | D |

Dependency spine: `.1 → .2 → .3 → .4`; `.5` after `.2`; `.6` after `.1`+`.5`;
`.7` after `.6`+`.4`; `.8` after `.1`+`.4`; `.9` after `.7`+`.8`; `.10`–`.12`
after `.7`. `ovn-recon-s3t.32` closed pointing at this plan.
