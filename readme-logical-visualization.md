# Logical OVN Visualization

This document explains the **logical OVN topology views**: the cluster view at
`/ovn-recon/ovn` and the per-node view at `/ovn-recon/ovn/:name`. It is the
logical-view counterpart of [readme-visualization.md](readme-visualization.md),
which covers the physical per-node view.

The two views split along a precise boundary: the physical view shows what
**nmstate** reports (interfaces, bridges, bonds, VRFs — things configured via
NNCP), while the logical view shows what **OVN-Kubernetes builds inside the
OVN northbound database** (logical switches, routers, ports — things created
by the Kubernetes API through UDN/CUDN CRs and the cluster network itself).

Data comes from the optional **ovn-collector** service, which transcribes six
NB tables per node (`Logical_Switch`, `Logical_Switch_Port`, `Logical_Router`,
`Logical_Router_Port`, `NAT`, `Logical_Router_Static_Route`) into a
[versioned snapshot contract](collector/api/logical-topology-snapshot.schema.json).
The collector is a faithful transcriber; all interpretation described below
happens in the frontend.

## Zones: why there is a per-node view at all

Modern OVN-Kubernetes runs in **interconnect (IC) mode**: every node hosts its
own OVN northbound database — its **zone** — containing that node's slice of
the logical network plus stitching to the other zones. The per-node view
renders exactly one zone. The cluster view fetches every zone in one request
(`GET /api/v1/snapshots`) and merges them: constructs that appear in every
zone under the same name (the transit switch, distributed routers, a Layer2
network's cluster-wide switch) collapse into a single instance that remembers
which zones it came from, while node-bound constructs stay distinct.

## The ladder layout

The view is **not** lane-based like the physical view. It is a **ladder**:

- **Vertical axis = traffic direction.** North (external networks) at the
  top, workloads at the bottom, in fixed tiers:

  | Tier | Constructs |
  |---|---|
  | External | external switches (`ext_*`) — bridged to `br-ex`/physnet |
  | Gateway routers | per-node gateway routers (`GR_*`) — where SNAT happens |
  | Join / Transit | the `join` switch (router-to-router traffic inside a zone) and the `transit_switch` (Geneve tunnels between zones) |
  | Cluster routing | the distributed `ovn_cluster_router` and per-network transit/cluster routers |
  | Workload switches | node switches, Layer2 cluster switches, Localnet switches |

- **Horizontal axis = network.** One tinted vertical band per network: the
  default cluster network always leftmost in neutral gray, then each
  UDN/CUDN in a stable color hashed from its name. The band answers the
  primary question — *which constructs did my network create?* — at a glance.

- **Positions are deterministic.** A construct's place is a pure function of
  (network, tier, node ordinal). No force layout; the same data always draws
  the same picture.

In the cluster view, node-replicated constructs (gateway routers, node
switches, external switches) stack side by side within their tier. Past four
instances the group collapses into an **aggregate chip** ("10 × Gateway
router"); click it to expand. Click a band header to filter to that network.

## How each topology variant draws

- **Default cluster network (Layer3)**: the full ladder — per-node external
  switch, gateway router, `join` + `transit_switch` waist, one distributed
  `ovn_cluster_router`, and a per-node workload switch named after the node,
  carrying the node's host subnet (`other_config:subnet`).
- **Layer2 UDN/CUDN (primary)**: per-node gateway routers and external
  switches, a per-network **transit router** (per-zone instances stitched by
  tunnels), and **one cluster-wide workload switch** shared by all nodes.
- **Layer3 UDN/CUDN**: the default network's shape replicated per network —
  its own cluster router, gateway routers, and per-node switches.
- **Localnet CUDN**: a single rung — one switch bridged straight to a
  provider network through a localnet port. No routers; the ladder
  degenerates deliberately.

## Node and edge kinds

**Constructs (cards):**

| Role | OVN reality |
|---|---|
| Cluster router | `ovn_cluster_router` or `<net>_ovn_cluster_router` — distributed router doing east-west routing |
| Gateway router | `GR_<node>` / `GR_<net>_<node>` — per-node router doing NAT to the outside |
| Transit router | `<net>_transit_router` — Layer2 networks' per-zone router stitched across nodes |
| Join switch | `join` / `<net>_join` — connects gateway routers to the cluster router within a zone |
| Transit switch | `transit_switch` / a Layer2 network's interconnect switch — Geneve tunnels between zones |
| Node switch | per-node workload switch (default and Layer3 networks) |
| Layer 2 switch | `<net>_ovn_layer2_switch` — cluster-wide workload switch |
| Localnet switch | `<net>_ovn_localnet_switch` — bridged to a physical network |
| External switch | `ext_<node>` / `ext_<net>_<node>` — the seam to `br-ex` |

Cards carry their stats inline: subnet, workload (pod) port count, NAT rule
count, tunnel peer count (`⇄ N nodes`), and a `physnet` marker on switches
with localnet ports. Individual pod ports never render as graph nodes — a
node switch can hold a hundred of them; they live in the drawer instead.

**Edges:**

- **Solid lines** are router links: a switch port of type `router` patched to
  a logical router port. The label leads with the leg's function, decoded
  from OVN-Kubernetes port naming, followed by the router port's addresses:
  `join · 100.64.0.5/16` (rtoj-, router-to-router traffic inside the node),
  `external · 192.168.4.x/24` (rtoe-, the gateway's outward leg — UDN
  gateways also carry the `169.254.0.x/17` masquerade address here),
  `gateway · 10.131.0.1/23` (rtos-, the workload subnet's gateway address),
  and `tunnel · 100.88.0.x/16` (rtots-, the Geneve transit address).
- **Dashed lines** are peered router ports (`interconnect`): two routers
  connected back-to-back without a switch, as a UDN gateway router peers
  with its network's transit router. Each address is annotated with its
  function — `router 100.65.0.x/16` (the router's address on the network's
  join subnet) and `p2p 100.88.0.x/31` (the point-to-point pair carrying
  the tunnel between the two router instances).

## Classification: how raw rows become semantics

OVN names are generated (`GR_worker-1`, `rtos-…`, `cluster_udn_blue_…`). A
pure classification layer maps every row to `{network, role, node, tier}`
using the naming conventions above **corroborated by `external_ids`**
(`k8s.ovn.org/network`, `k8s.ovn.org/topology`, `k8s.ovn.org/role`). Two
rules are load-bearing:

1. **Names, never subnets.** UDN subnets may overlap (NAT disambiguates
   them at runtime), so subnet containment is never used for association.
2. **No guessing.** A row that matches no convention classifies as an
   explicit `other` role rather than being force-fitted.

One quirk worth knowing: OVN-Kubernetes mangles network names into OVN object
names by replacing dashes with dots — CUDN `example-p-cudn` appears in
construct names as `example.p.cudn`.

## The drawer

Selecting any card opens a drawer with the construct's full detail: role,
network (linked to the owning `ClusterUserDefinedNetwork` /
`UserDefinedNetwork` CR), node (linked to that node's logical view from the
cluster page), zone provenance, subnet, NAT rules
(`snat 192.168.4.72 ⇄ 10.131.0.6`), static routes
(`0.0.0.0/0 → 192.168.4.1`), tunnel peers, and a filterable list of workload
ports where each pod port links to its Pod.

## Freshness and fallback

Snapshots carry `generatedAt`; the banner turns warning at 2 minutes and
critical at 10. The collector caches zone snapshots on disk
(`spec.collector.cache`: TTL ≥ 30s, default 120s, EmptyDir or PVC backed),
serving cached zones while fresh and recollecting on expiry — this is what
keeps the cluster view's all-zones request fast. If live probing fails, a
stale cache entry is served with `LIVE_PROBE_FAILED` + `SNAPSHOT_STALE`
warnings; with no cache entry the collector serves fixture snapshots flagged
`SNAPSHOT_DEFAULT`. A zone that fails during cluster aggregation appears as a
`ZONE_COLLECTION_FAILED` warning rather than failing the whole view. A
snapshot without the v2 `database` payload renders a collector-upgrade
callout instead of a graph.
