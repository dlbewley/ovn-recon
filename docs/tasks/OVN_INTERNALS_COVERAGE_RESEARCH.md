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
| `Logical_Switch` | name, ports, other_config, external_ids | acls, qos_rules, load_balancer, load_balancer_group, dns_records, copp, forwarding_groups |
| `Logical_Switch_Port` | name, type, addresses, tag, options, external_ids | **port_security**, **up**, **enabled**, dynamic_addresses, parent_name, tag_request, peer, dhcpv4_options, dhcpv6_options, ha_chassis_group, mirror_rules, health_checks |
| `Logical_Router` | name, ports, nat, static_routes, options, external_ids | **policies**, enabled, load_balancer, load_balancer_group, copp |
| `Logical_Router_Port` | name, mac, networks, peer, gateway_chassis (uuids only), options, external_ids | **status** (`hosting-chassis`), enabled, ipv6_ra_configs, ipv6_prefix, ha_chassis_group, dhcp_relay |
| `NAT` | type, external_ip, logical_ip, logical_port, external_mac, options, external_ids | gateway_port, priority, match, external_port_range, allowed_ext_ips, exempted_ext_ips |
| `Logical_Router_Static_Route` | ip_prefix, nexthop, policy, output_port, options, external_ids | route_table, bfd, selection_fields |
| SB `Chassis` | other_config:ovn-bridge-mappings (local chassis only) | everything else |

Bold entries are the ones a user asking "what does OVN do to this port" hits
first. Of the 39 NB tables, six are transcribed.

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
| Load_Balancer | 257 | one per Service and protocol, `k8s.ovn.org/kind=Service`, `k8s.ovn.org/owner=ns/name` |
| Load_Balancer_Group | 12 | `clusterLBGroup` (235 LBs) attached to every workload switch and GR; per-UDN groups empty |
| ACL | 561 | owner types: NetworkPolicy 291, NetpolNamespace 244, MulticastCluster 12, NetpolDefault 6, NetpolNode 3, UDNIsolation 5 |
| Port_Group | 430 | owner types: NetworkPolicy 188, NetpolNamespace 122, Namespace 113, Cluster 6, UDNIsolation 1 |
| Address_Set | 37 | owner types: PodSelector 31, EgressIP 3, ClusterNodeIPs, UDNEnabledService, EgressService |
| QoS | 3 | EgressIP reply-traffic marks, one per network |
| Meter / Meter_Band | 10 / 2 | acl-logging, arp/icmp rate limiters |
| Copp | 1 | referenced by every router |
| Gateway_Chassis | 4 | one per distributed gateway port |
| Static_MAC_Binding | 5 | masquerade MAC pins on `rtoe-` ports |
| DHCP_Options, HA_Chassis_Group, DNS, Mirror, BFD, Sample_* | 0 | DHCP_Options is populated only on CNV clusters with VM leases |
| NB_Global | 1 | `options.name` = zone, `northd_internal_version`, `nb_cfg` |

Whole-database dump: 39 tables, about 800 KB of JSON, 0.17 s wall time for
one exec. ACL and Load_Balancer dominate the byte count.

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

None yet. Record each as a dated entry here, as
`OVN_LOGICAL_PERSPECTIVE_PLAN.md` does, rather than editing the analysis.

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

Dependencies recorded in beads: `.4` after `.3`; `.5`, `.6`, `.7`, `.9`
after `.1`; `.8` after `.4`.

## Appendix A: NB table inventory (schema 7.19.0) and disposition

| Table | Root | Collected | Lab rows | Disposition |
|---|---|---|---|---|
| ACL | | no | 561 | tier 2 |
| Address_Set | yes | no | 37 | tier 2 |
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
| Load_Balancer | yes | no | 257 | tier 3 |
| Load_Balancer_Group | yes | no | 12 | tier 3 |
| Load_Balancer_Health_Check | | no | 0 | tier 3 |
| Logical_Router | yes | partial | 7 | tier 1 columns |
| Logical_Router_Policy | | no | 17 | tier 4 |
| Logical_Router_Port | | partial | 33 | tier 1 columns |
| Logical_Router_Static_Route | | partial | 65 | tier 1 columns |
| Logical_Switch | yes | partial | 15 | tier 1 columns |
| Logical_Switch_Port | | partial | 59 | tier 1 columns |
| Logical_Switch_Port_Health_Check | | no | 0 | never |
| Meter / Meter_Band | yes | no | 10 / 2 | tier 4 |
| Mirror / Mirror_Rule | yes | no | 0 | collect if free |
| NAT | | partial | 24 | tier 1 columns |
| NB_Global | yes | no | 1 | status line |
| Network_Function* | yes | no | 0 | never (7.19.0) |
| Port_Group | yes | no | 430 | tier 2 |
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
