# Insights: the findings engine

Pure modules that look at what the plugin already watches and say what looks broken
(epic `ovn-recon-7i6`). No React, no hooks, no fetches: a rule is a function from a
context to a list of findings. The surfaces that show them (drawer section, graph
badges, overview card) are a separate bead, `ovn-recon-7i6.1`.

A diagnostic that cries wolf is worse than none. Every rule here was confirmed before
it was built (`ovn-recon-7i6.2` for the physical side, `ovn-recon-7i6.3` for the
logical side), and each one is quiet when its data is missing.

## Severity

| Severity | Means | Never |
|---|---|---|
| `warning` | Looks broken: investigate. | For something that works. |
| `info` | Works, but current guidance differs (a dated practice). | Drawn as a warning triangle. |

Every rule that ships today is a `warning`, but for two masquerade findings (`ovn-recon-2n6.5`):
`masquerade-address-mismatch` is always `info`, because the per-network offsets it checks are an upstream
implementation detail, and `masquerade-subnet-too-small` is `info` while no primary network needs a pair yet.
Two Cluster Network Operator findings (`ovn-recon-n7r.3`) are `info` too: `cno-unsupported-overrides`
(the cluster may work, outside support) and `cno-migration-in-progress`.
`info` also exists for the practice notes of `ovn-recon-s3t.35`.

## The model (`types.ts`)

- **Finding**: `ruleId`, `severity`, `subject`, `scope`, a one-sentence `summary`
  naming the object, `evidence`, a `remedy`, an optional `docsUrl`, and a stable `key`.
- **Subject**: a node on one node's physical graph (`graph-node`, by the canonical id
  from `src/topology/ids.ts`), a logical construct (`construct`, kind plus name, as in
  `?select=KIND:NAME`), or a Kubernetes object (`k8s`).
- **Evidence**: one fact, the objects it was read from and the field. When the fact
  rests on a naming convention or a default rather than on a field that states it,
  `inferred` says so in words, and the surfaces must show it.
- **Remedy**: what to change, with a reference to the object to edit (a CUDN, a
  NodeNetworkConfigurationPolicy, a NAD), and the field when one field is the fix.
- **Contexts**: `PhysicalContext` is one node's `GraphContext` (from
  `buildGraphContext`) plus the cluster's CUDNs, UDNs, NADs and every node's
  NodeNetworkState. `LogicalContext` is one zone's collector snapshot, plus the
  node's pods, the cluster's NADs and MultiNetworkPolicies, and the evaluation time,
  each optional: a rule that needs a missing one reports nothing.

## Using it

```ts
import { evaluatePhysical, findingsForGraphNode, countBySeverity } from '../insights';

const findings = evaluatePhysical({ domain: 'physical', node: graphContext, cluster });
const onThisNode = findingsForGraphNode(findings, nodeName, 'iface:bond0');
const { warning, info } = countBySeverity(findings);
```

`evaluatePhysical.cluster(cluster, graphContexts)` evaluates the whole cluster for the
overview: network rules once, node rules per node. Results are memoised by object
identity, so build the contexts in a `useMemo` and pass the same objects back.

`ClusterNetworkInputs` also carries, optionally, the cluster's Nodes and the zone databases
the tab already holds (`zoneDatabases`, live snapshots only, read through
`rememberedCollectorSnapshot` by `useHeldZoneDatabases`; never fetched for the findings).
Only the explorer shell passes them; a rule needing one is quiet without it.

It also carries, optionally, the cluster network configuration (`networkConfig`: the sources
`useNetworkConfigSources` watches and the `CnoConfigModel` the Network config tab draws, built once in
`useExplorerData`). The `cno-*` rules read the model's capability checklist for a prerequisite rather
than reading the spec again (`cno.ts`: `prerequisite`, `unmetPrerequisites`). The cluster network MTU
(`clusterMtuOf`) reaches the node rules on each node's `GraphContext.clusterMtu`, for
`mtu-exceeds-uplink`. A finding whose subject is the operator or cluster `Network` or the network
ClusterOperator links to the Network config tab.

Network-scope rules read `ctx.cluster` only; node and node-network rules read
`ctx.node` only. The evaluator enforces this, which is what lets a node page and the
overview share the network findings.

For the logical side, `evaluateLogical(ctx)` gives one zone's findings, and
`evaluateLogical.sections(database, node)` runs only the rules that read an optional
snapshot section (`Rule.section`), over a database that carries it. The same contract
split holds: the network rule reads `ctx.cluster` only, zone rules never do, and
section rules read `ctx.snapshot.database` and `ctx.nodeName` only.

## Surfaces (`ovn-recon-7i6.1`)

The React side lives in `ui/`, apart from the pure engine:

- `ui/useFindings.ts`: `useNodeFindings` (node page) and `useClusterFindings` (the explorer shell, once for every scope)
  evaluate in a `useMemo` off the contexts the pages already build, never in graph
  layout; `FindingsEvaluatorContext` lets a test supply an evaluator with extra rules;
  `useHideInfoFindings` is the one "Hide info findings" toggle, kept in `localStorage`
  with every read and write in try/catch.
- `ui/FindingsViews.tsx`: severity icons (PatternFly status colours, info subdued), the
  drawer's Findings section, the graph decorator and the toggle.
- `ui/FindingsPanel.tsx`: the explorer's Findings tab, at cluster or node scope, as a list grouped by rule.
- `links.ts`: console paths for a `K8sRef`, and the `?select=` link to a finding's subject.

The logical surfaces (`ovn-recon-7i6.3`):

- `ui/useLogicalInputs.ts`: `useNodePods` (a watch on `spec.nodeName`, not a
  cluster-wide pod list) and `useLogicalClusterInputs` (NADs and MultiNetworkPolicies,
  watched only when the console reports both CRDs). It is the only logical file that
  imports the console SDK.
- `ui/useLogicalFindings.ts`: `useLogicalFindings` evaluates a zone in a `useMemo` off
  the snapshot the page holds; `useSectionFindings` runs the section rules over a
  section the drawer or detail page loaded; `LogicalFindingsEvaluatorContext` lets a
  test supply rules.
- A node's logical page badges each ladder card (`LogicalLadderView`'s `findingsFor`;
  a card folded into an aggregate chip lends it its findings), lists the findings on
  no one construct (subject a Node: the zone's collection, an orphaned row) above the
  ladder, and opens the drawer's Overview with the construct's findings
  (`ConstructDrawerBody`'s `findings`). The construct detail page lists the same above
  its tabs. The cluster view passes no findings and shows none.
- `match-ref-unresolved` reads the `policy` section, which the ladder's snapshot does
  not carry, so it shows in the drawer (which loads the section for a switch) and on
  the detail page once a tab has loaded it, never as a ladder badge.

**Surface gates** (`gates.ts`) hold back findings the engine reports correctly while a
question about them is open. The rules and their tests are untouched; each gate is one
line in `SURFACE_GATES`. Today there is one: `interface-down` on the EVPN interfaces of
a network (its SVI, a port of the network's VRF, and its OVS-side port, recognised by
resolving the device to a network that declares EVPN), pending `ovn-recon-7i6.2`.

## Adding a rule

One file, two fixtures.

1. Confirm the rule and its severity on the bead first. Record any reading of an open
   condition as a design note there.
2. Write `rules/<camelCaseId>.ts` exporting a `PhysicalRule` (or `LogicalRule`): `id`
   in kebab case, `severity`, `scope`, `title`, and a pure `evaluate`. Build findings
   with `makeFinding` so the key is filled in.
3. Add it to `registry.ts`.
4. Write `rules/<camelCaseId>.test.ts` with at least one case that fires and one
   that stays quiet. Prefer the real captures under `test/fixtures/` (read the README
   in each directory for the sanitization rules), varied in the test with `clone`,
   over invented data. `registry.test.ts` fails if a rule has no test file.

Rules must:

- return nothing when their data source is absent (no enactments, a CRD that is not
  installed, the cluster's NodeNetworkState not loaded); absence is not a problem;
- report a cluster-wide condition once, on the network object, not once per node;
- mark in `evidence[].inferred` anything matched by a naming convention.

## Shipped rules

| id | scope | fires when |
|---|---|---|
| `localnet-unmapped` | network | A Localnet CUDN or standalone NAD names a physical network that no node maps to a bridge |
| `mapping-bridge-missing` | node | A bridge mapping names an OVS bridge the node does not report |
| `interface-down` | node | A VRF port, a mapped bridge's uplink, or a NAD's bridge (or its uplink) is down; members of a kernel or OVS bond are left to `bond-degraded` |
| `bond-degraded` | node | A kernel bond, or an OVS bond in a bridge's `bridge.port` list, has members down or missing among those configured (reported, plus any an enactment declares); `ignore` is not down. An OVS bond's finding is on the bond's own graph node, `ovs-bond:<bridge>/<bond>` (`ovn-recon-1tw.4`, `ovn-recon-1tw.2`) |
| `nnce-failing` | node | An enactment on the node is Failing or Degraded |
| `mtu-exceeds-uplink` | node-network | A Localnet network's declared MTU exceeds the smallest MTU of its bridge's uplinks on that node; or the cluster network MTU the CNO reports, plus Geneve's 100 bytes (and IPsec Full's 46), exceeds the smallest uplink of the gateway bridge (`physnet`, else br-ex). Quiet without the CNO and during an MTU migration (`ovn-recon-n7r.3`) |
| `nad-config-unparsed` | network | A NAD's `spec.config` is not a JSON object, so the view fell back to pattern matching |
| `vrf-port-unmatched` | node | A VRF declares a port no interface carries |
| `ovs-bridge-unbonded-uplinks` | node | An OVS bridge (not br-int) has two or more uplinks, an OVS bond counting as one, with STP stated off and RSTP not on (`ovn-recon-1tw.5`); uplinks are counted by the link they leave on, so VLANs of one NIC or bond are one uplink (`ovn-recon-vb1`); an uplink that is down still counts, a bridge reporting no STP setting is quiet, Linux bridges are out of scope |
| `masquerade-subnet-too-small` | network | The masquerade subnet the Nodes' `k8s.ovn.org/node-masquerade-subnet` reports cannot hold offset 10 + 2 x the highest network ID in use (the legacy /29 and /125 hold none). Warning with a primary network, info without; on the network configuration (`ovn-recon-2n6.5`) |
| `masquerade-subnet-overlap` | network | The masquerade subnet (annotation, else a held zone's gateway router route, else the default) overlaps a CUDN or UDN subnet or join subnet (on the network), a NodeNetworkState interface address other than br-ex's and the management ports' own (on the interface), or a join or transit subnet on a held zone's router ports (on the network configuration, once per subnet) |
| `masquerade-address-mismatch` | network | Info. A primary network's gateway router in a held zone database carries a gateway router masquerade address (port, `physical_ips`, NAT) other than the one its network ID gives, or none in a family it has addresses in; on the router, scoped to the node and the network. Quiet without a zone database |
| `masquerade-subnet-disagreement` | network | Nodes report different masquerade subnets; once, on the network configuration |

Logical side (`ovn-recon-7i6.3`), evaluated over one zone's collector snapshot:

| id | scope | fires when |
|---|---|---|
| `lsp-down` | node | A pod's Logical_Switch_Port has `up=false` while the pod has been Running on that node for over two minutes; quiet without the node's pods, for `enabled=false`, and for `up` unset |
| `mnp-missing-nad` | network | A MultiNetworkPolicy's `k8s.v1.cni.cncf.io/policy-for` names a NAD that does not exist; quiet without both CRDs |
| `match-ref-unresolved` | node | An ACL's match names an `@port_group` or `$address_set` the zone does not hold (a group's own `_ip4`/`_ip6` sets count as held); needs all three policy tables |
| `mac-binding-orphan` | node | A Static_MAC_Binding names a router port the zone does not hold; quiet until the collector sends `staticMacBindings` (`ovn-recon-e2b.7`) |
| `collector-degraded` | node | The snapshot carries `LIVE_PROBE_FAILED` or `SNAPSHOT_STALE`, and not `COLLECTOR_WARMING` (set by the collector while its start-up cache sweep runs) |

Not built yet: `workload-on-unmapped-node` (a pod or VM on a Localnet network runs on
a node without its mapping), which needs pod attachment data the plugin does not watch
yet.

## Decided not to be findings

Each of these was proposed and rejected on 2026-11-10. Do not re-add them without
going back to the bead.

- **A Localnet mapping present on only some nodes.** Often deliberate: a cluster
  confines a network to the nodes cabled for it. The network page shows "usable on N
  of M nodes" instead. The breakage case is a workload scheduled where the mapping is
  missing, which is `workload-on-unmapped-node`.
- **More than one default route in a node's main table.** The kernel route table
  already marks the one in use (`ovn-recon-dp7.2`); a second one works.
- **A bridge mapping that no network references.** Normal on nodes that carry no such
  workload.

Logical side (`ovn-recon-7i6.3`):

- **Service VIPs without endpoints.** Often normal; the Services tab already counts
  them and filters on them (`ovn-recon-dp7.6`).
- **A router policy whose match names a port the router no longer has.** Seen in every
  zone; it looks like an OVN-Kubernetes leftover that no admin can fix. The policy table
  marks the row instead.
- **A localnet switch with no bridge mapping in its zone** is not a rule of its own: it
  is `localnet-unmapped` (same id, shown on the ladder too) when the physical network is
  mapped nowhere, and a neutral fact otherwise.
| `cno-evpn-gateway-prereq` | network | A CUDN is carried over EVPN (or, with none, a VTEP exists) while the EVPN checklist's `routingViaHost: true` or `ipForwarding: Global` is unmet; on each EVPN CUDN, else once on the network configuration (`ovn-recon-n7r.3`) |
| `cno-route-ads-disabled` | network | RouteAdvertisements exist while route advertisements are not Enabled, so they are ignored; FRR missing from the providers is cited too |
| `cno-mnp-disabled` | network | `disableMultiNetwork` is true while NADs a CUDN did not generate exist. The MultiNetworkPolicy half of the bead's condition needs an MNP list the shell does not watch, and is not reported |
| `cno-evpn-with-ipsec` | network | A CUDN is carried over EVPN while IPsec is not Disabled; on each EVPN CUDN |
| `cno-operator-unhealthy` | network | The network ClusterOperator or operator configuration reports Degraded (or ManagementStateDegraded) True, Available False, or Progressing True for longer than the model's threshold; or managementState is not Managed. Once, on the ClusterOperator |
| `cno-unsupported-overrides` | network | Info. `spec.unsupportedConfigOverrides` is set, or ConfigMap `ovn-kubernetes-config-overrides` is present |
| `cno-migration-in-progress` | network | Info. `spec.migration` or the cluster network configuration's `status.migration` is set |
