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

Every rule that ships today is a `warning`. `info` exists for the practice notes of
`ovn-recon-s3t.35`.

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
  NodeNetworkState. `LogicalContext` is a collector snapshot plus its ladder model;
  no rule uses it yet.

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

Network-scope rules read `ctx.cluster` only; node and node-network rules read
`ctx.node` only. The evaluator enforces this, which is what lets a node page and the
overview share the network findings.

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
| `interface-down` | node | A VRF port, a mapped bridge's uplink, or a NAD's bridge (or its uplink) is down; bond members are left to `bond-degraded` |
| `bond-degraded` | node | A bond has members down or missing among those configured (reported, plus any an enactment declares); `ignore` is not down |
| `nnce-failing` | node | An enactment on the node is Failing or Degraded |
| `mtu-exceeds-uplink` | node-network | A Localnet network's declared MTU exceeds the smallest MTU of its bridge's uplinks on that node |
| `nad-config-unparsed` | network | A NAD's `spec.config` is not a JSON object, so the view fell back to pattern matching |
| `vrf-port-unmatched` | node | A VRF declares a port no interface carries |

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
