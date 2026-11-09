# Research: Comprehensive Coverage of OVN Internals

Status: research, living document. Started 2026-09-04. Nothing here is decided
until it is recorded under *Decisions*; everything else is analysis and a
proposed shape. Epic: `ovn-recon-e2b`.

## 1. The question

The logical view draws the OVN-Kubernetes ladder (external switch, gateway
router, join/transit, cluster router, workload switch) and its drawer shows a
handful of fields per construct. OVN itself defines far more: a logical
switch port carries `port_security`, `up`, `enabled`, DHCP options and health
checks; a switch carries ACLs, QoS rules and load balancers; a router carries
policies and load balancer groups; and whole tables (`ACL`, `Port_Group`,
`Address_Set`, `Load_Balancer`, `Logical_Router_Policy`, ...) never reach the
plugin at all.

Three questions follow, and this document answers each in turn:

1. **What do we already know and collect?** (section 2)
2. **Is there an upstream definition of these structures we can adopt instead
   of hand-writing them?** (sections 3 and 4)
3. **How far should the representation go, and where does the detail live:
   the existing drawer, or a new drill-down per switch and router?**
   (sections 6 and 7)

## 2. What we already know and collect

### 2.1 Pipeline

`collector/internal/probe/collect.go` execs `ovn-nbctl --format=json list
<table>` in the `nbdb` container of the node's `ovnkube-node` pod, one exec
per table (six NB tables plus one `ovn-sbctl find Chassis` for bridge
mappings). `parser.go` decodes the OVSDB JSON value encoding (`["uuid",..]`,
`["set",[..]]`, `["map",[..]]`) and projects each row onto a hand-written Go
struct in `collector/internal/snapshot/types.go`. The same shape is mirrored
by hand in `src/types.ts` and `collector/api/logical-topology-snapshot.schema.json`
(schema version `"2"`, per `OVN_LOGICAL_PERSPECTIVE_PLAN.md` decision 2).

The frontend classifies rows into `{network, role, node, tier}` in
`logicalClassification.ts` (names plus `k8s.ovn.org/network|topology|role`
external IDs), builds the ladder in `logicalLadderModel.ts`, and renders a
three-tab drawer (`ConstructDrawerBody.tsx`: Overview, Relationships, Config).
`ovnKindRegistry.ts` is the declared seam for new kinds: "adding a kind is one
collector table command, one types row, and one entry here."

### 2.2 Column coverage today

| NB table | Columns collected | Columns skipped (upstream 7.19.0) |
|---|---|---|
| `Logical_Switch` | name, ports, acls, qos_rules (uuids), load_balancer, load_balancer_group (uuids, resolved by the `services` section), other_config, external_ids | dns_records, copp, forwarding_groups |
| `Logical_Switch_Port` | name, type, addresses, tag, port_security, up, enabled, dynamic_addresses, tag_request, parent_name, options, external_ids | peer, dhcpv4_options, dhcpv6_options, ha_chassis_group, mirror_rules, health_checks |
| `Logical_Router` | name, ports, nat, static_routes, enabled, policies, copp (uuids), load_balancer, load_balancer_group (uuids, resolved by the `services` section), options, external_ids | — |
| `Logical_Router_Port` | name, mac, networks, peer, enabled, gateway_chassis (resolved by `Gateway_Chassis`), status (`hosting-chassis`), options, external_ids | ipv6_ra_configs, ipv6_prefix, ha_chassis_group, dhcp_relay |
| `NAT` | type, external_ip, logical_ip, logical_port, external_mac, gateway_port, priority, match, external_port_range, options, external_ids | allowed_ext_ips, exempted_ext_ips |
| `Logical_Router_Static_Route` | ip_prefix, nexthop, policy, output_port, route_table, bfd, selection_fields, options, external_ids | — |
| `Gateway_Chassis` | name, chassis_name, priority, options, external_ids | — |
| `NB_Global` | name, nb_cfg, sb_cfg, hv_cfg, options (`northd_internal_version`), external_ids | connections, ssl, ipsec, *_timestamp |
| `Load_Balancer` (section `services`) | name, protocol, vips (as stored), options, selection_fields, health_check (uuids), ip_port_mappings, external_ids | — |
| `Load_Balancer_Group` (section `services`) | name, load_balancer (uuids) | — (the table has no external_ids) |
| SB `Chassis` | other_config:ovn-bridge-mappings (local chassis only) | everything else |

Of the 39 NB tables, ten are transcribed. Tier 1 is complete: the router,
switch, NAT and route columns landed with `ovn-recon-e2b.3` and the
`Logical_Switch_Port` slice (the columns a user asking "what does OVN do to
this port" hits first) with `ovn-recon-e2b.4`, both on 2026-11-08. Tier 3
(the service plane) landed the same day with `ovn-recon-e2b.6`; its two
tables are collected on every pass and delivered only with
`?include=services`.

### 2.3 What the fixtures and a live cluster say is actually populated

Counts below are from a 10-chassis lab cluster running OVN 26.03 (NB schema
7.18.0) with the default network, two Layer2 primary UDN/CUDNs, one Layer3
UDN, and several Localnet CUDNs. One zone (one node's NB database):

| Table | Rows | Notes |
|---|---|---|
| Logical_Switch | 15 | ladder as classified today |
| Logical_Switch_Port | 59 | `port_security` set on 19 (every pod port); `up` set on all; `tag_request` on 4 localnet ports; `enabled`, `dynamic_addresses`, `dhcpv4_options`, `ha_chassis_group` empty |
| Logical_Router | 7 | `policies` 5 on the cluster router, 6 on each UDN transit router; `copp` on all; `load_balancer` 18 on the GR |
| Logical_Router_Port | 33 | `status.hosting-chassis` on the 4 distributed gateway ports; `gateway_chassis` refs resolve to `Gateway_Chassis` rows we do not fetch |
| Logical_Router_Static_Route | 65 | `route_table` always empty |
| Logical_Router_Policy | 17 | all EgressIP-owned (`k8s.ovn.org/owner-type=EgressIP`), incl. per-UDN copies |
| NAT | 24 | `external_port_range` always set (empty string), `match` on 2 |
| Load_Balancer | 345 | one per Service and protocol (328 Services), `k8s.ovn.org/kind=Service`, `k8s.ovn.org/owner=ns/name`; 319 cluster-scoped rows identical in every zone plus 26 to 35 node-scoped rows (`_node_router+switch_<node>` and friends) |
| Load_Balancer_Group | 12 | no `external_ids`; `clusterLBGroup` (319 LBs) attached to every node switch and GR; `clusterSwitchLBGroup`, `clusterRouterLBGroup` and the per-UDN triples empty |
| ACL | 665 | identical in every zone; owner types: NetworkPolicy 368, NetpolNamespace 268, MulticastCluster 12, NetpolDefault 6, UDNIsolation 6, NetpolNode 3, AdvertisedNetwork 2; 660 attached via `Port_Group.acls`, 5 via `Logical_Switch.acls`, none orphaned |
| Port_Group | 1296 | identical in every zone except `ports` (the zone's own LSPs); owner types: Namespace 933, NetworkPolicy 221, NetpolNamespace 134, Cluster 6, UDNIsolation 1, AdvertisedNetwork 1; 941 rows are empty Namespace groups (one per namespace per network controller) |
| Address_Set | 65 | owner types: PodSelector 57, EgressIP 4, ClusterNodeIPs, UDNEnabledService, EgressService, AdvertisedNetwork; all `ip-family=v4` |
| QoS | 3 | EgressIP reply-traffic marks, one per network |
| Meter / Meter_Band | 10 / 2 | acl-logging, arp/icmp rate limiters |
| Copp | 1 | referenced by every router |
| Gateway_Chassis | 4 | one per distributed gateway port |
| Static_MAC_Binding | 5 | masquerade MAC pins on `rtoe-` ports |
| DHCP_Options, HA_Chassis_Group, DNS, Mirror, BFD, Sample_* | 0 | DHCP_Options is populated only on CNV clusters with VM leases |
| NB_Global | 1 | `options.name` = zone, `northd_internal_version`, `nb_cfg` |

Whole-database dump: 39 tables, about 800 KB of JSON, 0.17 s wall time for
one exec. ACL and Load_Balancer dominate the byte count.

Recounted 2026-11-08 on two zones while refining tiers 2 and 3 (the five
policy and service rows above carry the new figures; the cluster had grown
to 133 namespaces, 221 NetworkPolicies, 381 Services and seven network
controllers). ACL, Port_Group and Address_Set are cluster-wide objects and
come out identical in every zone; a zone's `Port_Group.ports` holds only
its own LSPs. One transact of the eight collected tables plus the five
above is 1.80 MB of wire JSON on the largest zone (1.0 s wall from a
workstation), of which ACL is 589 KB and Port_Group 656 KB. See the
2026-11-08 decision for `.9` in section 11 for the projected sizes.

The v2 fixture corpus (`collector/fixtures/snapshots/*.json`) reflects only
the six collected tables; any expansion needs a corpus refresh
(`ovn-recon-kck.4` precedent).

## 3. Upstream sources of truth

| Source | What it gives us | Fetched |
|---|---|---|
| `ovn-org/ovn` `ovn-nb.ovsschema` | The authoritative table/column/type definition. Upstream main is 7.19.0; the lab cluster serves 7.18.0. | 2026-09-04 |
| `ovn-org/ovn` `ovn-nb.xml` | Column semantics rendered into `ovn-nb(5)`. Includes the documented option keys per table (38 for LSP, 29 for LS, 24 for LR, 27 for LRP). | 2026-09-04 |
| `ovn-org/ovn` `ovn-sb.ovsschema` | SB tables (21.13.0): Chassis, Encap, Port_Binding, Datapath_Binding, MAC_Binding, Service_Monitor, ... | 2026-09-04 |
| `ovn-org/ovn-kubernetes` `go-controller/pkg/nbdb/*.go` | libovsdb `modelgen` output: one Go struct per NB table with `ovsdb:"column"` tags. 41 files, generated, Apache-2.0. | 2026-09-04 |
| `ovn-org/ovn-kubernetes` `go-controller/pkg/libovsdb/ops/db_object_ids.go` and `db_object_types.go` | The `external_ids` ownership scheme: `k8s.ovn.org/owner-controller`, `owner-type`, `name`, `id`, and the registry of which owner types exist per table. | 2026-09-04 |
| `ovn-kubernetes/libovsdb` | The OVSDB client and model generator ovn-kubernetes uses (import path moved from `ovn-org/libovsdb`). | 2026-09-04 |

Copies of the fetched schema files are not committed; they are cheap to
re-fetch and pinning is a decision for `ovn-recon-e2b.2`.

### 3.1 Column semantics that matter for representation

From `ovn-nb.xml`, condensed:

- **`Logical_Switch_Port.port_security`**: the set of MAC (and optional IP)
  addresses the attached host may send from and receive to; empty means
  unrestricted. Also constrains ARP/ND inner source MACs. OVN-Kubernetes sets
  it equal to `addresses` on every pod port. Localnet, router and remote
  ports carry none, which is why the ladder never noticed it.
- **`Logical_Switch_Port.up`**: written by `ovn-northd`, true when the port is
  bound to a chassis in the SB `Port_Binding` table. This is the NB-only
  answer to "is this port actually attached", and the reason SB access is not
  needed for a binding indicator.
- **`Logical_Switch_Port.enabled` / `Logical_Router.enabled`**: administrative
  state; empty or true means enabled, false drops all traffic. A false value
  is a diagnostic-grade finding.
- **`Logical_Switch_Port.type`** enumerates `router`, `switch`, `localnet`,
  `localport`, `l2gateway`, `vtep`, `external`, `virtual`, `remote`, and the
  empty string for a VIF. The classification layer handles four; `virtual`
  (VIP failover between pods) and `localport` are the next likely to appear.
- **`Logical_Router_Port.status.hosting-chassis`**: which chassis currently
  hosts a distributed gateway port. Combined with `Gateway_Chassis` rows it
  says where the `rtos-`/`trtos-` port for a Layer2 network lives.
- **`ACL.tier`**: 0..3, evaluated in order; OVN-Kubernetes uses tier 2 for
  network policy and tier 0 for a few defaults. `ACL.match` references port
  groups as `@name` and address sets as `$name`, which is the join key back
  to `Port_Group.name` and `Address_Set.name`.
- **`Load_Balancer.vips`**: `vip[:port]` to comma-separated `backend[:port]`
  map. Attachment is via `Logical_Switch.load_balancer[_group]` and
  `Logical_Router.load_balancer[_group]`, not from the LB side.
- **`Logical_Router_Policy`**: priority, match, `allow|drop|reroute|jump`,
  `nexthops`; policy routing evaluated before static routes. Carries EgressIP
  reroutes and UDN traffic steering.

### 3.2 The ovn-kubernetes ownership scheme

Rows that ovn-kubernetes creates on behalf of a Kubernetes object carry:

```
k8s.ovn.org/owner-controller  = default-network-controller | <udn controller>
k8s.ovn.org/owner-type        = NetworkPolicy | NetpolNamespace | Namespace | EgressIP | ...
k8s.ovn.org/name              = <owner-specific, often ns:name or ns>
k8s.ovn.org/id                = <controller>:<owner-type>:<name>:<extra keys...>   (primary index)
```

plus owner-specific keys (`direction`, `gress-index`, `ip-block-index`,
`port-policy-protocol`, `ip-family`, `network`, `priority`). The registry in
`db_object_types.go` defines, per table, exactly which keys each owner type
uses. This is what lets a collected `ACL` row be attributed to
`NetworkPolicy openshift-foo/allow-bar, Ingress rule 0` without guessing.

Two tables predate the scheme and use their own keys: `Load_Balancer`
(`k8s.ovn.org/kind=Service`, `k8s.ovn.org/owner=<ns>/<name>`) and
`Logical_Switch_Port` for pods (`namespace`, `pod`). The classification layer
already relies on the latter.

Owner types observed or defined upstream, by table:

| Table | Owner types |
|---|---|
| ACL | NetworkPolicy, NetpolNamespace, NetpolDefault, NetpolNode, MulticastCluster, MulticastNS, AdminNetworkPolicy, BaselineAdminNetworkPolicy, EgressFirewall, UDNIsolation, AdvertisedNetwork, ClusterNetworkConnect, NetworkPolicyPortIndex |
| Port_Group | Namespace, NetpolNamespace, NetworkPolicy, AdminNetworkPolicy, BaselineAdminNetworkPolicy, Cluster, UDNIsolation, AdvertisedNetwork |
| Address_Set | PodSelector, Namespace, NetworkPolicy, EgressIP, EgressService, EgressFirewallDNS, EgressQoS, NetworkQoS, ClusterNodeIPs, UDNEnabledService, HybridNodeRoute, AdminNetworkPolicy, BaselineAdminNetworkPolicy, AdvertisedNetwork, ClusterNetworkConnect, Cluster (no-overlay SNAT exemption) |
| Logical_Router_Policy | EgressIP, ClusterNetworkConnect |
| NAT | EgressIP, NoOverlayClusterSubnetSNAT |
| QoS | EgressQoS, EgressIP, NetworkQoS |
| DHCP_Options | VirtualMachine |
| Logical_Router_Port / Static_Route | ClusterNetworkConnect |

## 4. Can we adopt upstream-defined structures?

Yes, and there are three ways to do it. Evaluated against the project's
constraints (collector is a transcriber; Go, TS and JSON schema move in
lockstep; no heavyweight dependencies):

**A. Import `ovn-kubernetes/go-controller/pkg/nbdb`.** Exact structs, zero
generation work. Rejected: the package lives inside the `ovn-kubernetes`
module, which requires Go 1.26 and drags the whole controller dependency
graph into the collector. There is no separately published module.

**B. Run libovsdb `modelgen` ourselves against a vendored
`ovn-nb.ovsschema`.** Produces the same generated structs under
`collector/internal/nbdb/`, from a schema file we pin and can diff on OVN
upgrades. Adds a build-time tool dependency only. Recommended for Go.

**C. Keep hand-written projection rows (today).** Fine at six tables;
becomes the bottleneck at twenty.

A companion decision is the wire format. Today the collector projects
`_uuid` to `uuid`, `external_ids` to `externalIds`, and drops columns. Two
options:

- **Full-fidelity rows** with a generator that emits `src/types.ts` and the
  JSON schema from the same `.ovsschema`. Every column travels; the frontend
  ignores what it does not need. Adding a table is a collector one-liner and
  a registry entry. Cost: larger payloads (section 8) and a schema version
  bump if the projection changes shape.
- **Projected rows, generated.** Same generator but with a per-table allow
  list of columns and camelCase names. Keeps payloads small and stays
  `schemaVersion: "2"`-compatible as long as additions are optional fields.

The recommendation is the second: generated projections with an explicit
allow list, so the fixture corpus and payload budgets stay under control and
adding a column is a one-line allow-list change instead of edits in three
files. `ovn-recon-e2b.2`.

## 5. Collector: one exec instead of seven

Verified on the lab cluster, inside the `nbdb` container:

```bash
ovsdb-client -f json dump unix:/var/run/ovn/ovnnb_db.sock OVN_Northbound
```

returns one JSON object per table (39 lines, `{"caption","headings","data"}`,
the same encoding `parser.go` already decodes), about 800 KB in 0.17 s.
Better still, a single transact with several `select` operations returns
one atomic result with per-table row arrays and per-op column selection:

```bash
ovsdb-client -f json transact unix:/var/run/ovn/ovnnb_db.sock \
  '["OVN_Northbound",
    {"op":"select","table":"Logical_Switch_Port","where":[]},
    {"op":"select","table":"Gateway_Chassis","where":[]},
    {"op":"select","table":"NB_Global","where":[],"columns":["nb_cfg","options"]}]'
```

Why it matters beyond speed:

- **Consistency.** Seven sequential `list` calls each read a different
  database state; a uuid referenced by a router row can be gone by the time
  the port table is read. One transaction resolves references consistently.
- **Extensibility.** Adding a table is one more `select` op; no new exec
  target, no new RBAC.
- **Column selection** keeps the payload small without post-filtering.

The Kubernetes exec path, target resolution and RBAC stay exactly as they
are; only the command changes. The OVSDB socket is not reachable from outside
the pod, so a direct libovsdb client connection is not an option without
changing the deployment model (a DaemonSet sidecar would be, and is out of
scope here). `ovn-recon-e2b.1`.

## 6. Gap analysis: what to represent, in tiers

Each tier lists the construct, the user question it answers, the K8s
attribution available, and the cost. Ordered by value per effort.

### Tier 1: columns we already skip on tables we already collect

No new UI surface; the drawer Overview and Config tabs grow.

| Column | User question | Cost |
|---|---|---|
| LSP `port_security` | Is this pod locked to its MAC/IP? Is a VM allowed its extra MACs? | parse only |
| LSP `up`, `enabled` | Is this port bound anywhere; was it administratively disabled? | parse only; `enabled=false` is a diagnostic (`ovn-recon-s3t.15` family) |
| LSP `dynamic_addresses`, `tag_request`, `parent_name` | Dynamic IPAM, VLAN requests on localnet ports, child ports | parse only |
| LRP `status.hosting-chassis` + `Gateway_Chassis` table | Which node hosts this network's gateway port right now? | one new table (4 rows) |
| LR `enabled`, `policies`, `load_balancer[_group]`, `copp` | Router admin state; counts for the routing and service planes | parse only, refs resolve once tiers 2..4 land |
| LS `acls`, `qos_rules`, `load_balancer[_group]` | Counts and refs for tiers 2..3 | parse only |
| NAT `gateway_port`, `priority`, `match`, `external_port_range` | Newer NAT semantics; `match` is used on 2 rows today | parse only |
| Static route `route_table`, `bfd`, `selection_fields` | ECMP and BFD-backed routes | parse only |
| NB_Global `options.name`, `northd_internal_version`, `nb_cfg` | Zone identity and OVN version for the status line | one row |

`ovn-recon-e2b.3`. This is the cheapest slice and the one Dale's LSP example
points at. It should go first regardless of how the later tiers are decided.
Done 2026-11-08 except the LSP row, which moved to `ovn-recon-e2b.4` (section
11).

### Tier 2: the policy plane (ACL, Port_Group, Address_Set)

User questions: "Which network policies touch this pod?" "Why is this
traffic dropped?" "What does UDN isolation actually install?"

Data model: `Port_Group.ports` (weak refs to LSPs) gives membership;
`Port_Group.acls` and `Logical_Switch.acls` give where an ACL applies;
`ACL.match` names port groups (`@`) and address sets (`$`). Attribution
through the ownership scheme in section 3.2 is exact for every owner type.

Scale is the problem: 561 ACLs and 430 port groups on a small cluster, and
port groups per namespace on a large one. This tier cannot live in the
drawer; it needs tables with filter and sort (section 7). The frontend
model needs an index `LSP uuid -> [Port_Group]` and `Port_Group name ->
[ACL]` built once per snapshot. `ovn-recon-e2b.5`.

### Tier 3: the service plane (Load_Balancer, Load_Balancer_Group)

User questions: "Which Service VIPs does this switch see?" "Which Service is
this VIP?" "Why does this pod not reach a ClusterIP?" (the per-UDN LB groups
being empty is itself informative).

Attribution is direct (`k8s.ovn.org/owner=ns/name`). 257 rows, each with a
`vips` map; the byte cost is the backend lists. Presentation is a table per
switch or router listing VIP, protocol, backends, Service link.
`ovn-recon-e2b.6`.

### Tier 4: routing-plane extras

| Table | Why | Notes |
|---|---|---|
| `Logical_Router_Policy` | EgressIP reroutes, UDN steering, `pkt.mark` handling | 17 rows; render with static routes on the router |
| `Static_MAC_Binding` | Masquerade MAC pins on `rtoe-` ports | 5 rows; explains the 169.254.0.x neighbor entries |
| `DHCP_Options` | CNV: per-VirtualMachine lease, the only NB trace of a VM's IP contract | 0 on the lab zone; important on CNV nodes |
| `QoS` | EgressIP marks, EgressQoS, NetworkQoS | 3 rows |
| `Meter`, `Meter_Band`, `Copp` | Control-plane protection, ACL log rate limits | 13 rows, cluster-wide |
| `BFD`, `Mirror`, `DNS`, `HA_Chassis_Group` | Defined upstream, unused by OVN-Kubernetes today | collect if free (transact), do not design UI for them |

`ovn-recon-e2b.7`.

### Tier 5: Southbound (revisiting `OVN_LOGICAL_PERSPECTIVE_PLAN.md` decision 4)

The decision to skip SB for placement still holds: LSP `up` reflects binding
without touching SB. Three SB items remain interesting:

- `Chassis` + `Encap`: the tunnel endpoint list (name, hostname, encap IP,
  `is-remote`). This is the logical/physical seam in data form and would let
  the transit switch's "tunnels to N nodes" become "tunnels to these IPs".
- `Port_Binding.chassis` / `requested_chassis` / `tunnel_key`: "bound where"
  for remote and chassisredirect ports; explains a wrong-node placement.
- `Service_Monitor`: LB health check state, once health checks are enabled.

Cost is one more exec in the `sbdb` container (the existing Chassis probe
already goes there). Deferred: `ovn-recon-e2b.10`.

### Never (or status-line only)

`SSL`, `Connection`, `Sampling_App`, `Sample_Collector`, `Network_Function*`
(new in 7.19.0, DPU service chaining), `Chassis_Template_Var`,
`Forwarding_Group`. `NB_Global` only for the status line.

## 7. Where the detail lives: drawer versus drill-down

The physical view's precedent is a drawer with three tabs, and the logical
drawer mirrors it deliberately (`ovn-recon-mow`). It handles a dozen fields
and a capped list. Tier 1 fits it. Tiers 2 and 3 do not: hundreds of rows
per construct, each needing sort, filter and a link, is a page, not a panel.

Proposed shape:

1. **Drawer stays the summary.** Overview gains the tier-1 fields and count
   chips ("561 ACLs via 3 port groups", "18 load balancers", "5 policies")
   that link into the detail page. Config keeps raw rows.
2. **Ports tab on switches** (`ovn-recon-e2b.4`): table of LSPs with type,
   addresses, `port_security`, `up`, `requested-chassis`, Pod/VM link.
   Selecting a row shows the port's own row plus its port groups. This is the
   incremental step and can land before the detail page exists.
3. **Construct detail page** (`ovn-recon-e2b.8`): `/ovn-recon/ovn/switch/:name`
   and `/ovn-recon/ovn/router/:name`, node-scoped by zone (query parameter or
   a nested segment; the cluster view links to the representative zone).
   Tabs: Ports, Policy (ACLs grouped by owner, port groups, address sets),
   Services (LBs), Routes and NAT (static routes, policies, NAT, MAC
   bindings), Config. PatternFly `Table` with toolbar filters; deep-linkable
   so a Pod page could one day link straight to its port.
4. **A port inspector is the eventual cross-cut**: LSP -> port groups ->
   ACLs -> address sets, plus LBs it backs. It is the "what does OVN do to
   this pod" answer and falls out of the indexes tier 2 builds. Not scoped
   as a bead until tier 2 exists.

The physical view's `nodeKindRegistry` / logical `ovnKindRegistry` pattern
extends naturally: each new NB table becomes a kind with `rawRows` for
Config and, new, a `detailTabs` contribution for the page.

## 8. Payload, cache and contract implications

- **Size.** Full NB is about 800 KB per zone on a 10-chassis cluster; the
  aggregate endpoint multiplies by node count. ACL and Load_Balancer are the
  bulk. Options: `?tables=` selection on the existing endpoints (ladder
  callers keep today's size), a separate `/api/v1/snapshots/:node/detail`
  endpoint fetched only by the detail page, or always-full with gzip. The
  disk cache (`ovn-recon-e18.17`) and warmer (`ovn-recon-kck.19`) need the
  same decision. `ovn-recon-e2b.9`.
- **Schema versioning.** Additive optional fields and tables stay at
  `schemaVersion: "2"`; the frontend already treats every table beyond the
  first six as optional (`bridgeMappings?` precedent). A move to generated
  full-fidelity rows would be `"3"`.
- **Schema drift.** The lab cluster is 7.18.0; upstream is 7.19.0; older
  OpenShift releases will be lower. Selecting by column name in the transact
  fails hard on a missing column, so the collector should request only the
  columns in its allow list and tolerate a rejected op per table (the
  existing per-table `COMMAND_FAILED` degradation already models this).
- **Sensitivity.** ACL matches and address sets enumerate pod IPs and
  namespace names, the same class of data the LSP table already carries.
  No new RBAC: the exec path and containers are unchanged.
- **Fixtures.** The v2 corpus must be recaptured with the wider column set
  (and, for tier 2, a cluster with NetworkPolicies, ANP and a UDN), then the
  `logicalSnapshotCorpus.test.ts` contract test extended.

## 9. Proposed sequencing

1. `ovn-recon-e2b.1` one-exec transact (pure collector win, unblocks all
   table additions).
2. `ovn-recon-e2b.3` tier-1 columns + Gateway_Chassis into the existing
   drawer.
3. `ovn-recon-e2b.4` Ports tab with per-port detail.
4. `ovn-recon-e2b.2` generated types (can run in parallel with 2 and 3; it
   pays off once more than two tables are added).
5. `ovn-recon-e2b.9` payload decision, then `ovn-recon-e2b.5` policy plane
   and `ovn-recon-e2b.8` detail page together (the policy plane is what
   forces the page).
6. `ovn-recon-e2b.6` service plane, `ovn-recon-e2b.7` routing extras.
7. `ovn-recon-e2b.10` SB revisit, only if a concrete diagnostic needs it.

## 10. Open questions

- Should the detail page be one route with a `kind` segment, or two routes?
  Two routes read better in the console breadcrumb; one route is less
  registration in `console-extensions.json`.
- Is per-UDN owner-controller attribution (`k8s.ovn.org/owner-controller`
  values other than `default-network-controller`) stable enough to key the
  network band color on, or do we keep `k8s.ovn.org/network`?
- Does the ACL/port-group volume on a large production cluster (thousands of
  namespaces) make tier 2 a detail-endpoint-only feature from day one?
- CNV: `DHCP_Options` and `virtual` LSPs are the VM-specific constructs; is
  that a distinct persona worth its own tier ordering?

## 11. Decisions

Record each as a dated entry here, as `OVN_LOGICAL_PERSPECTIVE_PLAN.md`
does, rather than editing the analysis.

### 2026-11-07: `ovn-recon-e2b.4` refined and unblocked

Made while refining the Ports tab bead; verified against a lab cluster
(interconnect mode, 10 chassis).

1. **The LSP column slice of tier 1 moves from `.3` to `.4`.** `ovn-nbctl list
   Logical_Switch_Port` already returns every column, so `port_security`,
   `up`, `enabled`, `dynamic_addresses`, `tag_request` and `parent_name` are
   parser and contract work whose first consumer is the Ports tab. `.3` keeps
   the LRP, LR, LS, NAT, static route, Gateway_Chassis and NB_Global columns.
   The `.4` after `.3` dependency is removed; the two can run in parallel.
   Section 9's ordering of `.3` before `.4` no longer applies.
2. **`requested-chassis` resolves through the Node annotation, not the SB.**
   The option's value is the SB `Chassis.name`, a UUID string, and it equals
   the hosting Node's `k8s.ovn.org/node-chassis-id` annotation. The plugin
   watches Nodes and maps chassis id to node name; the raw UUID is the
   fallback. Collecting SB `Chassis` stays with `.10`.
3. **Port selection is in-drawer.** The Ports tab is a PatternFly table with
   expandable rows; the expanded row shows the port's raw NB row and a
   placeholder for port groups until tier 2 lands. Ports do not become ladder
   constructs and do not move the ladder selection.
4. **The tab lists every LSP on the switch**, not only pod ports: vif, router,
   localnet, management and remote, distinguished by a type column. Routers
   do not get the tab; LRPs are not in scope.
5. **No paging.** A node switch is bounded by pods per node (250 default, 500
   cap) and transit switches by node count; a filtered table is enough.

### 2026-11-08: `ovn-recon-e2b.1` implemented

Re-verified on the lab cluster (OVN 26.03, ovsdb-client 3.5.2) before
starting: one transact for the six tables took 0.34 s against 2.07 s for six
`ovn-nbctl list` execs from the same workstation.

1. **One exec for the NB, the SB chassis query stays separate.** The bead's
   "seven" counted the `ovn-sbctl find Chassis` call, which reads a different
   database through a different socket and container; it is unchanged.
2. **All columns, no `columns` selection yet.** `ovn-nbctl list` already
   returned every column, so selecting all keeps the payload identical and
   lets `.3` and `.4` add fields without touching the command. Column
   selection stays available for `.9`.
3. **Per-op errors degrade one table; an exec failure falls back.**
   `ovsdb-server` reports a failed `select` in-band (exit code 0, an error
   object at that index, `null` for the aborted ops that follow), so the
   collector inspects the body and emits `COMMAND_FAILED` per table. If the
   transact exec itself fails it runs the old per-table `ovn-nbctl list`
   commands and adds `NB_TRANSACT_FAILED`, so a cluster whose `nbdb`
   container lacks `ovsdb-client` still gets a (non-atomic) snapshot.
4. **Parsers split into row mappers.** Each `ParseX(raw)` is now a wrapper
   over `xFromRows([]map[string]any)`; both probe paths feed the same mapper,
   so the column work in `.3` and `.4` lands in one place. The `.4` design
   note "no collector command changes" is superseded by this; its parser and
   contract plan is unaffected.

### 2026-11-08: `ovn-recon-e2b.3` implemented

Verified against the lab cluster (OVN 26.03.4, NB schema 7.1x, interconnect)
by running the collector out-of-cluster and capturing all three fixture
nodes.

1. **Two more tables in the transact, no new exec.** `Gateway_Chassis` and
   `NB_Global` are entries in `nbTables`; the per-table `ovn-nbctl list`
   fallback covers them too. Gateway_Chassis rows are tiny (one per
   distributed gateway port); NB_Global is one row.
2. **Columns map 1:1 onto the contract, camelCase, omitempty.** Optional
   booleans (`enabled`) become `*bool` / `boolean | undefined` so "unset"
   (OVN's default, enabled) is distinguishable from an explicit `false`.
   `NAT.priority` is an integer omitted when zero; `external_port_range` is
   carried as a string. Reference columns (`policies`, `acls`,
   `load_balancer`, `load_balancer_group`, `qos_rules`, `copp`, `bfd`) stay
   uuid lists until their tables land in tiers 2 to 4; the drawer shows them
   as counts labeled "rows not collected yet".
3. **Chassis names resolve through the Node annotation, as decided for
   `.4`.** `status:hosting-chassis` and `Gateway_Chassis.chassis_name` are SB
   chassis ids; `useChassisNodeNames` (`src/components/useChassisNodeNames.ts`)
   watches Nodes and maps `k8s.ovn.org/node-chassis-id` to node names. The
   Ports tab's `requested-chassis` column should reuse it. Unresolved ids
   render truncated with the full id in a tooltip.
4. **Drawer, not new surfaces.** Routers gain Admin state (only when the NB
   row sets `enabled`), Gateway ports (port, hosting node, candidates with
   priorities when there is more than one or the host is not the preferred
   candidate, "Not hosted" when northd has not placed it), Routing policies
   and Load balancers counts; switches gain ACLs, Load balancers and QoS
   rules counts. NAT rule text appends `match`, `priority` and the gateway
   port name; static route text appends `table`, `bfd` and `ecmp(fields)`.
   The Config tab includes the router's `Gateway_Chassis` rows.
5. **NB_Global feeds the status line.** `SnapshotStatusLine` shows
   `OVN <release> · zone <name>` (release = `northd_internal_version` up to
   the first `-`), a "Mixed OVN versions" label when zones disagree, and
   "Chassis behind NB config" when `hv_cfg < nb_cfg`. The cluster view
   summarizes across the zones on view.
6. **Fixtures were spliced, not recaptured.** The new columns and tables were
   merged into `cnv-1`, `cnv-2` and `ctrl-1` by matching rows semantically
   (names; NAT and route tuples), so existing UUIDs and pod lists that tests
   reference are unchanged. Gateway_Chassis UUIDs proved stable since the
   August capture. `default.json` stays empty.
7. **Cluster merge rules.** Reference counts take the max across zones (as
   NAT and route counts do); gateway placements union by port name;
   `enabled` is false if any zone says so.

### 2026-11-08: `ovn-recon-e2b.4` implemented

Verified against the lab cluster (OVN 26.03.4, interconnect, 10 chassis) by
running the collector out-of-cluster and capturing the three fixture nodes.
Observed per node switch: `up` true on every VIF, router, remote and
management port and false on every localnet port; `port_security` on every
pod port (equal to `addresses`); `tag_request` on the VLAN localnet ports;
`enabled`, `dynamic_addresses` and `parent_name` unset on every row.

1. **LSP columns in the contract, same conventions as `.3`.** `portSecurity`
   (string list), `up` and `enabled` (optional booleans, absent when the NB
   set is empty, so northd's "not yet bound" and an explicit `false` are
   distinguishable), `dynamicAddresses`, `tagRequest` and `parentName`
   (strings, omitempty). They land in `logicalSwitchPortsFromRows`, which
   both probe paths feed, so no collector command changed. The design's
   "`up bool` omitted when empty" became `*bool`: a plain bool with omitempty
   would have dropped `up=false`, the one value the tab needs to show.
2. **Fixtures spliced by port name, again.** Live rows were matched to the
   August captures by name; ports whose pod no longer exists got the values
   every live row of their type showed (pod ports: `portSecurity` =
   `addresses`, `up` true; localnet: `up` false, `tagRequest` = `tag`).
   UUIDs and pod lists the tests reference are unchanged.
3. **The model carries every LSP with its row.** `LadderConstruct.ports`
   (type `LadderPort`: a `ClassifiedPort` plus its `LogicalSwitchPortRow`)
   lists every port on the switch sorted by type then name; `podPorts` and
   `podPortCount` are untouched so the Overview chip is unchanged. Carrying
   the row is what lets the cluster view render per-port columns for ports
   from zones other than the representative one. The cluster merge unions
   `ports` by name and keeps the first zone's row, so `tstor-<node>` (a
   router port in its own zone, remote elsewhere) appears once.
4. **Ports tab, switches only, before Config.** `hasPortsTab` is a predicate
   on `ovnKindFor(construct).table === 'Logical_Switch'`; a `detailTabs`
   registry contribution waits for `.8`. The tab is a compact PatternFly
   `Table` with expandable rows (name or Pod link, type with empty rendered
   as `vif`, addresses, port security, Up/Down label plus a red Disabled
   label when `enabled` is false, requested chassis), a text filter over
   name, namespace/pod and addresses, and a native type select with counts.
   No paging. The expanded row shows the port's raw NB row in the read-only
   editor, taken from the representative node's database when it holds the
   port (the Config tab's rule) and from the model's carried row otherwise,
   plus a "Port groups: not collected yet" slot for `.5`.
5. **`requested-chassis` reuses `nodeForChassis`.** The pages already pass
   the resolver from `useChassisNodeNames` into the drawer for gateway
   ports; the Ports tab's column takes the same prop and the same
   `ChassisName` rendering (node name linking to the node's logical view,
   full id in the tooltip, truncated id when no Node claims it). No second
   Node watch.
6. **Tab state.** The stored tab survives a hop between switches; the Ports
   body is keyed by construct uuid so expanded rows and filters reset on
   every hop. On a router the strip omits Ports and the drawer shows Overview
   while keeping the stored choice, so hopping back to a switch returns to
   Ports.
7. **Overview keeps its capped workload list.** The design allowed replacing
   it with a count chip; it stays as-is for now since the Ports tab is one
   click away and the list still answers "which pods" at a glance.

### 2026-11-08: `ovn-recon-e2b.5`, `.6` and `.9` refined

Design-only pass; verified read-only on the lab cluster (OVN 26.03, NB
schema 7.18.0, interconnect, 10 zones) with one `ovsdb-client transact`
per zone selecting the eight collected tables plus `ACL`, `Port_Group`,
`Address_Set`, `Load_Balancer` and `Load_Balancer_Group`, on a
virtualization node and a control-plane node. Full text is in the beads;
the decisions that bind the other beads are recorded here.

1. **Payload (`.9`): one collect, one cache entry, projection on the way
   out.** The five tables join `nbTables` (still one exec, about 1.0 s per
   zone against 0.34 s today). The disk cache keeps the full snapshot (about
   1.5 MB per zone, 15 MB for ten against the 1Gi default PVC). Both
   endpoints take `?include=policy,services`; without it the response is
   today's. Sections not requested are omitted, so an absent key means "not
   requested" and `[]` means "collected and empty". Measured per zone:
   today's eight tables 189 KB projected; the policy tier adds 1.06 MB
   (ACL 500 KB, Port_Group 518 KB, Address_Set 43 KB; 138 KB gzipped); the
   service tier adds 201 KB (27 KB gzipped). `external_ids` is 44 % of ACL
   and 57 % of Port_Group bytes, `match` only 8 % of ACL, so column
   selection buys little; gzip buys 7 to 8x and the snapshot endpoints gain
   it. A separate `/:node/policy` path was rejected (new route, a second
   fetch helper and a client-side merge for the same bytes); table-granular
   `tables=` was rejected in favour of the two sections the UI consumes.
2. **The aggregate stays ladder-only.** Policy tables are identical in every
   zone, so the cluster endpoint would carry ten copies of the same megabyte.
   The cluster view loads sections from the representative zone's per-node
   snapshot, the rule the Config tab already follows.
3. **Policy plane (`.5`) is per-port and per-switch summary, not tables.**
   660 of 665 ACLs attach through `Port_Group.acls` and 5 through
   `Logical_Switch.acls`; `match` names groups as `@name` and address sets
   as `$name`, all resolvable by name. Every vif port sits in 1 to 7 groups
   with a few dozen applicable ACLs, which fits the Ports tab's expanded row
   (filling the `.4` placeholder) and the switch Overview count; the
   665-row table is `.8`'s. Ownership is read generically from the four
   `k8s.ovn.org/*` keys; only NetworkPolicy, Namespace and NetpolNamespace
   owners get console links. Empty Namespace port groups (941 of 1296, one
   per namespace per network controller) are transcribed, not filtered.
   AdminNetworkPolicy, BaselineAdminNetworkPolicy, EgressFirewall and
   EgressIP ACLs do not exist on the lab and stay unverified.
4. **Service plane (`.6`) attaches through groups, and gets a drawer tab.**
   `clusterLBGroup` holds every cluster-scoped LB (319) and is referenced by
   each node switch and gateway router alongside 22 node-scoped LBs set
   directly; the per-UDN groups exist and are empty. A construct's VIP set
   is the union of direct LBs and group members. `vips` stays the raw
   `"vip:port" -> "backend,backend"` map (empty string = no endpoints, 47 of
   576 on the lab); the Service link comes from `k8s.ovn.org/owner`. Unlike
   ports, Service count per node is unbounded, so the Services tab renders
   at most 200 filtered rows with a "narrow the filter" notice. Section 7's
   "tier 3 does not fit the drawer" is softened to this capped tab; the
   uncapped table remains `.8`'s.
5. **Ordering.** `.9` first (the include mechanism with zero sections), then
   `.5` and `.6` in either order; `.8` after `.5`. Dependencies recorded:
   `.5` and `.6` after `.9`, `.5` after `.4`, `.8` after `.5`.

### 2026-11-08: `ovn-recon-e2b.11` contract JSON formatting

Raised while reviewing `.3`: the JSON schema was hand-formatted in a compact
style that nothing enforced, so a serializer round-trip rewrote the whole
file and every editor had to match the style by hand.

1. **Canonical serializer form, not a style-preserving formatter.** The two
   schemas under `collector/api` and the fixture corpus under
   `collector/fixtures/snapshots` are exactly `JSON.stringify(value, null,
   2)` plus a trailing newline, keys in file order. Python's
   `json.dumps(indent=2, ensure_ascii=False)` yields the same bytes, so the
   splice scripts used for `.3` and `.4` fixtures are now churn-free by
   construction. A prettier-style formatter was rejected because it
   preserves the author's line breaks, so a scripted edit would still
   reformat the file.
2. **One formatter, two checks.** `scripts/format-contract-json.js`
   rewrites (`npm run format:contract`) or checks (`npm run
   check:contract`). The check runs as its own step in the Build and Test
   workflow and again inside the Jest suite
   (`src/contractJsonFormat.test.ts`), so a local `npm run test` catches a
   hand-formatted edit before CI does.
3. **One-time reformat.** The snapshot schema grew from 274 to 617 lines
   and the cluster schema from 38 to 65; no semantic change. Fixtures were
   already canonical.
4. **Relationship to `.2`.** A generator for the three contract artifacts
   would make the schemas tool-written outright; until then this keeps them
   tool-formatted. The Go contract test is unchanged (Go cannot preserve
   key order without an ordered-map dependency; the Node check covers it).

### 2026-11-08: `ovn-recon-e2b.9` implemented

Verified by running the collector out-of-cluster against the lab cluster
(interconnect, 10 zones) with a disk cache, and against the fixture corpus
next to a build of the previous commit.

1. **`.9` lands the mechanism; the tables and row shapes stay with `.5` and
   `.6`.** The `.9` design had it append the five tables to `nbTables`, while
   `.5` and `.6` each own the same append together with the row mappers, and
   the refinement entry above orders "`.9` first (the include mechanism with
   zero sections)". Appending without mappers would read and discard more than
   a megabyte per zone on every collect, so this bead adds no table. The five
   keys are declared in Go, TypeScript and the JSON schema as optional arrays
   of a placeholder row (`SectionRow`: any object) that `.5` and `.6`
   replace with typed rows when they append their tables, write their
   mappers and splice their fixtures. Until then no collector populates a
   section and a request with `include` returns the ladder payload. The
   tests exercise delivery with placeholder rows injected into the fixture
   corpus and into a counting collector.
2. **One registry, one projection.** `snapshot.ParseSections` validates
   `include` (comma-separated, repeatable, blanks ignored) against the
   section registry and `snapshot.Project` returns a copy of the snapshot
   without the sections that were not requested. Both handlers call it after
   `collectZone`, so the live path, the cache, the stale fallback and the
   file store all behave alike, and the cached or collected payload is never
   mutated. An unknown name is a 400 whose body lists the valid sections.
3. **Absent versus empty needed more than `omitempty`.** The design's "nil
   slice + omitempty" cannot express "collected and empty": `omitempty` drops
   a zero-length slice as well as a nil one. `LogicalDatabase.MarshalJSON`
   re-declares the five fields as pointers so nil is omitted and an empty
   table encodes as `[]`; a test proves every fixture still encodes to the
   same bytes as the plain struct. The collector module is on Go 1.23; with
   1.24 the method reduces to `omitzero` on the five fields.
4. **Three states for the client, two on the wire.** A present array is the
   table; an absent key is "not requested or not collected" and keeps the
   drawer's existing not-collected rendering. A cache entry written before a
   collector learned a section reads as not collected until its TTL lapses.
5. **gzip on the two snapshot routes only.** 200 responses are compressed
   when `Accept-Encoding` allows gzip (q-values and `*` honoured); errors
   and the health probes stay plain; `Vary: Accept-Encoding` is set on every
   snapshot response. Compressors are pooled. Measured on today's ladder
   payload: 221 KB to 45 KB for the largest zone, 96 KB to 18 KB for a
   control-plane zone, 1.38 MB to 267 KB for the ten-zone aggregate, about
   5x; the 7 to 8x figure for the policy tables is from the refinement
   capture. Whether the console's plugin proxy passes `Content-Encoding`
   through was not checked in a browser: that needs a deployed image, and if
   the proxy strips it the plugin still works with larger responses.
6. **Plugin.** `fetchCollectorSnapshot(node, { include })` and
   `fetchClusterTopology({ include })` append `?include=` with the sections
   deduplicated and sorted; without the option the URL is unchanged, and no
   page passes it. `useOptionalSections(nodeName, sections, refreshKey?)`
   performs the second fetch for the views that will render a section,
   fetches nothing for an empty list, keeps the last good database across a
   refresh or a failure, and drops it when the node changes. The third
   argument is an addition to the design so a drawer can refetch in step
   with the ladder's polling.
7. **Compatibility checked two ways.** A build of the previous commit and
   this one served the fixture corpus side by side: every per-node body was
   byte-identical, and the aggregate identical apart from its own
   timestamp. Against the cluster, warm-up collected each zone once and the
   requests that followed (with and without `include`, with and without
   gzip, per node and aggregate) triggered no further collection.

### 2026-11-08: `ovn-recon-e2b.6` implemented

Verified by running the collector out-of-cluster against the lab cluster
(OVN 26.03.4, interconnect, 10 zones) next to a build of the previous
commit, on a virtualization node and a control-plane node, and against the
fixture corpus.

1. **Two tables appended to `nbTables`, last.** `Load_Balancer` and
   `Load_Balancer_Group` ride the same transact (and the same per-table
   fallback). They sit at the end so an NB schema that lacks one fails its
   own select without aborting the ladder tables before it. The collector's
   row counts equal `ovn-nbctl list` on both nodes (345 and 354
   `Load_Balancer`, 12 `Load_Balancer_Group`).
2. **Rows as stored.** `LoadBalancerRow` is uuid, name, protocol (optional),
   vips, options, selectionFields, healthCheck, ipPortMappings, externalIds;
   `LoadBalancerGroupRow` is uuid, name, loadBalancers. `vips` keeps the NB
   map verbatim: `"vip:port"` to the comma-separated backend list, with an
   empty string for a VIP without endpoints. The plugin splits it
   (`splitBackends`).
3. **A table that could not be read is absent, not empty.** The `.9` note
   asked for non-nil slices so an empty table encodes as `[]`. That holds for
   a table that was read; a section table whose select failed (or was aborted
   behind another failure) now stays nil, so the key is absent and the drawer
   says "not collected" instead of "0 load balancers". `collectTable` reports
   whether it read the table and a failed transact op leaves no entry; the
   ladder mappers still turn that into `[]` for their required arrays.
4. **The plugin treats the section as present only with both tables.**
   `serviceIndex.ts` (pure, cached per database object) builds `lbByUuid`,
   `groupByUuid` and `vipIndex`, and resolves a switch or router's refs with
   `loadBalancersFor` (by uuid, then by name for the merged cluster view).
   `vipIndex` maps a vips key to a list, not to one entry as designed: the
   cluster DNS VIP alone is carried by four rows on a node (TCP and UDP, each
   in a `node_router` and a `node_switch` variant). `scopeOf` parses only the
   name's suffix, so a network-prefixed name still resolves, and returns
   `unknown` for anything else.
5. **Services tab: one row per VIP, capped at 200.** Shown on a switch or
   router that attaches a load balancer or a group (even an empty one) once
   the section is loading or loaded, and not at all when the collector does
   not deliver it. Columns: Service (a link when the owner kind is Service),
   protocol, VIP, backends (a count, or a "No endpoints" label), scope
   (cluster or node-local, the exact scope and node in a tooltip) and source
   (direct or the group name). The expanded row lists the backends, the
   load balancer's name and its session affinity timeout. A text filter
   covers Service, VIP and backend; past 200 matches the tab says how many
   matched and asks for a narrower filter. A construct whose groups are all
   empty gets the sentence instead of a table.
6. **Overview line.** "22 direct · 319 via clusterLBGroup · 0 via
   clusterSwitchLBGroup": every attached group is listed, empty ones
   included, then "N VIPs without endpoints" when there are any. With
   nothing programmed it reads "0 load balancers; groups A and B are empty".
   Without the section the `.3` counts and "rows not collected yet" remain.
7. **The drawer fetches the section itself.** `ConstructDrawerBody` calls
   `useOptionalSections(databaseNode, ['services'], generatedAt)` only while
   the selected construct attaches load balancers and the database it was
   given does not already carry the section; the ladder pages' own request
   is unchanged. The section list is one constant, so `.5` adds `policy` to
   the same request. On the cluster view the node is the representative zone
   the Config tab already uses. The Config tab gains the direct
   `Load_Balancer` rows and the attached `Load_Balancer_Group` rows (members
   left as uuids).
8. **Fixtures carry the whole section on all three nodes.** The existing
   switch and router rows already reference 22 direct load balancers and the
   cluster group, and every one of those uuids still resolved live, so the
   two tables were added as captured without touching an existing row; a
   subset would have meant editing those refs. Rows are sorted by name. The
   three groups of a network the fixtures do not carry were dropped. Each
   fixture grew by about 250 KB.
9. **Two findings differ from the refinement capture.** No live row has an
   IPv6 VIP (the lab's service network is IPv4 only; the refinement's count
   of 35 could not be reproduced), so the fixtures carry one synthetic
   dual-stack row, `Service_ovn-recon-fixture/dual-stack-echo_TCP_cluster`,
   added to `clusterLBGroup`; it is the only row not captured. And 12 of 541
   VIPs had no endpoints at capture, against 47 of 576 earlier the same day.
10. **Measured.** Virtualization node: default response 216 KB (44 KB
    gzipped), the same byte count as the previous commit's build;
    `?include=services` 394 KB (70 KB gzipped). Control-plane node: 140 KB
    (27 KB) and 322 KB (54 KB). The section therefore costs about 180 KB, or
    26 KB gzipped, per request. The disk cache for ten zones grew from 1.4 MB
    to 3.1 MB. Per-zone collect time during a ten-zone warm-up was 0.6 to
    1.8 s against 0.6 to 1.4 s for the previous build warming at the same
    moment. Served from the fixture corpus, the default response of each
    node is byte-identical to the previous commit's.
11. **Not verified in a browser.** The tab and the Overview line are covered
    by jsdom tests over the fixtures; they have not been looked at in a
    running console, and whether the console's plugin proxy passes
    `Content-Encoding` through is still open from `.9`.

## Initial Beads Backlog Mapping

| Bead | Title | Section |
|---|---|---|
| `ovn-recon-e2b` | Research: comprehensive OVN internals coverage beyond the ladder (epic) | all |
| `ovn-recon-e2b.1` | Collector: one-exec whole-NB snapshot via ovsdb-client transact | 5 |
| `ovn-recon-e2b.2` | Contract: generate NB row types from the pinned ovn-nb.ovsschema | 4 |
| `ovn-recon-e2b.3` | Enrich existing rows with the columns we already skip | 6, tier 1 |
| `ovn-recon-e2b.4` | Drawer: Ports tab with per-port detail | 7 |
| `ovn-recon-e2b.5` | Policy plane: ACL, Port_Group, Address_Set with K8s attribution | 6, tier 2 |
| `ovn-recon-e2b.6` | Service plane: Load_Balancer and Load_Balancer_Group | 6, tier 3 |
| `ovn-recon-e2b.7` | Routing plane extras: LR policy, static MAC binding, DHCP, QoS, meters | 6, tier 4 |
| `ovn-recon-e2b.8` | Construct detail page drill-down for switches and routers | 7 |
| `ovn-recon-e2b.9` | Payload budgeting: table selection, endpoints, cache | 8 |
| `ovn-recon-e2b.10` | Revisit kck.1 decision 4: SB bindings and chassis | 6, tier 5 |
| `ovn-recon-e2b.11` | Contract: canonical JSON formatting for schemas and fixtures | 11 |

Dependencies recorded in beads: `.5`, `.6`, `.7`, `.9` after `.1`; `.8`
after `.4`; since 2026-11-08 also `.5` and `.6` after `.9`, `.5` after `.4`,
and `.8` after `.5`. (`.4` after `.3` was removed on 2026-11-07, see
section 11.)

## Appendix A: NB table inventory (schema 7.19.0) and disposition

| Table | Root | Collected | Lab rows | Disposition |
|---|---|---|---|---|
| ACL | | no | 665 | tier 2 |
| Address_Set | yes | no | 65 | tier 2 |
| BFD | yes | no | 0 | collect if free |
| Chassis_Template_Var | yes | no | 0 | never |
| Connection | | no | | never |
| Copp | yes | no | 1 | tier 4 |
| DHCP_Options | yes | no | 0 | tier 4 (CNV) |
| DHCP_Relay | yes | no | 0 | never |
| DNS | yes | no | 0 | collect if free |
| Forwarding_Group | | no | 0 | never |
| Gateway_Chassis | | no | 4 | tier 1 |
| HA_Chassis / HA_Chassis_Group | | no | 0 | collect if free |
| Load_Balancer | yes | yes | 345 | tier 3 landed (`.6`) |
| Load_Balancer_Group | yes | yes | 12 | tier 3 landed (`.6`) |
| Load_Balancer_Health_Check | | no | 0 | tier 3 |
| Logical_Router | yes | partial | 7 | tier 1 columns |
| Logical_Router_Policy | | no | 17 | tier 4 |
| Logical_Router_Port | | partial | 33 | tier 1 columns |
| Logical_Router_Static_Route | | partial | 65 | tier 1 columns |
| Logical_Switch | yes | partial | 15 | tier 1 columns |
| Logical_Switch_Port | | partial | 59 | tier 1 landed (`.4`) |
| Logical_Switch_Port_Health_Check | | no | 0 | never |
| Meter / Meter_Band | yes | no | 10 / 2 | tier 4 |
| Mirror / Mirror_Rule | yes | no | 0 | collect if free |
| NAT | | partial | 24 | tier 1 columns |
| NB_Global | yes | no | 1 | status line |
| Network_Function* | yes | no | 0 | never (7.19.0) |
| Port_Group | yes | no | 1296 | tier 2 |
| QoS | | no | 3 | tier 4 |
| Sample / Sample_Collector / Sampling_App | | no | 0 | never |
| SSL | | no | | never |
| Static_MAC_Binding | yes | no | 5 | tier 4 |

## Appendix B: how the research was gathered

- Upstream files fetched raw from GitHub `ovn-org/ovn` (main) and
  `ovn-org/ovn-kubernetes` (master) on 2026-09-04; schema summaries produced
  by a throwaway script over `ovn-nb.ovsschema` and `ovn-nb.xml`.
- Live counts and column censuses taken read-only with `ovn-nbctl
  --format=json list` and `ovn-sbctl` in one node's `nbdb`/`sbdb` containers
  on a lab cluster; identifying details omitted by policy.
- Existing coverage read from `collector/internal/snapshot/types.go`,
  `collector/internal/probe/{collect,parser}.go`, `src/types.ts`,
  `src/components/{logicalClassification,logicalLadderModel,ovnKindRegistry}.ts`
  and `ConstructDrawerBody.tsx`, plus the plan documents in this directory.
