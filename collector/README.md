# OVN Collector (Phase 2 Skeleton)

This component provides a Go-based server-side collector for Phase 2 logical OVN visualization.

## Current State

This scaffold includes:
- `cmd/ovn-collector` entrypoint
- `internal/snapshot` canonical payload types and file store
- `internal/probe` typed OVN parser + snapshot assembly pipeline
- in-cluster pod exec runner for live OVN interrogation
- HTTP endpoints for health/readiness and node-scoped snapshot retrieval
- fixture corpus under `fixtures/snapshots` (`cnv-1` carries the `policy`
  section, all three node fixtures the `services` section)
- collector-local `Makefile` and `Dockerfile`

## Endpoints

- `GET /healthz`
- `GET /readyz`
- `GET /api/v1/snapshots/:nodeName`: one node's zone snapshot
- `GET /api/v1/snapshots`: every reachable node's zone snapshot in one
  response (`ClusterLogicalTopology`)
- `GET /api/v1/sections/<section>[,<section>]/snapshots[/:nodeName]`: the
  same two endpoints with optional sections added (see below)
- `GET /api/v1/lookup/<ip|mac|cidr|name>/<value>`: where an address or a name
  is, across every stored zone snapshot (see [Lookup](#lookup))

Example:

```bash
curl -s http://localhost:8090/api/v1/snapshots/worker-a
curl -s --compressed http://localhost:8090/api/v1/sections/policy,services/snapshots/worker-a
curl -s --compressed 'http://localhost:8090/api/v1/snapshots/worker-a?include=policy,services'
```

### Optional sections

Both snapshot endpoints can add optional sections to a response. Without
them a response carries the ladder tables only, which is what the topology
views fetch. There are two equivalent spellings, served by the same code:

- In the path: `/api/v1/sections/<section>[,<section>]/snapshots[/:nodeName]`.
  **This is the one the console plugin uses, and the one to use for anything
  that reaches the collector through the OpenShift console.** The console's
  plugin asset handler forwards a request's path and drops its query string,
  so a query parameter silently never arrives (`ovn-recon-e2b.12`).
- As a query parameter: `?include=<section>[,<section>]` (the parameter may
  also repeat). Convenient for direct use with `curl`.

A request that uses both gets the union.

| Section | Adds to `database` | NB tables |
|---|---|---|
| `policy` | `acls`, `portGroups`, `addressSets` | `ACL`, `Port_Group`, `Address_Set` |
| `services` | `loadBalancers`, `loadBalancerGroups` | `Load_Balancer`, `Load_Balancer_Group` |

An unknown section name is a `400` whose body lists the valid ones. In a
response, an absent section key means the section was not requested or not
collected; an empty array means it was collected and the table is empty.

The sections exist because of their size. Measured on a ten-node cluster with
a few hundred Services and NetworkPolicies, the ladder tables are 100 to
200 KB per node, the policy tables add about 1 MB and the service tables
about 200 KB, and both are nearly identical in every zone, so a polling
topology view (and above all the aggregate, which would repeat them once per
node) should not carry them. The collector still reads every table in one
transaction and caches one full snapshot per node; the section list only
selects what a response carries, so asking for a section never triggers a
second collection. The aggregate endpoint honours it too, but a client that
wants section data for a cluster-wide view should read it from one node's
snapshot.

The `services` section is populated: `loadBalancers` are the NB rows as
stored (`vips` maps `"vip:port"` to the comma-separated backend list, empty
for a VIP without endpoints; `externalIds` name the owning Service) and
`loadBalancerGroups` are the named sets that switches and routers attach by
uuid (`logicalSwitches[].loadBalancerGroup`, `logicalRouters[].loadBalancerGroup`).
A switch or router sees its own `loadBalancer` rows plus the members of each
group it attaches.

The `policy` section is populated too (`ovn-recon-e2b.5`). `acls` are the NB
rows as stored: `priority`, `direction` (`from-lport` or `to-lport`),
`action`, `match`, `tier`, the logging columns when set (`log`, `severity`,
`meter`, `label`), `options` and `externalIds`. `portGroups` carry `name`,
`ports` (switch port uuids) and `acls` (ACL uuids); every row is delivered,
including the groups with neither. `addressSets` carry `name` and
`addresses`. An ACL applies where it is attached: to the member ports of a
port group that lists it, or to every port of a switch that lists it in
`logicalSwitches[].acls`. Inside a `match`, `@name` is a port group and
`$name` an address set, both by `name`; the collector does not resolve them.
The owner of each row is in `externalIds` (`k8s.ovn.org/owner-controller`,
`k8s.ovn.org/owner-type`, `k8s.ovn.org/name`, `k8s.ovn.org/id`). Under
interconnect a zone's port groups list only that zone's own ports, so read a
port's groups from its own node's snapshot.

### Lookup

`GET /api/v1/lookup/<kind>/<value>` answers "where is this address or name?"
with every row, in every zone, that holds it (`ovn-recon-tpp.1`).

```bash
curl -s --compressed http://localhost:8090/api/v1/lookup/ip/10.131.0.70
curl -s --compressed http://localhost:8090/api/v1/lookup/mac/0a:58:0a:83:00:46
curl -s --compressed http://localhost:8090/api/v1/lookup/cidr/10.1.2.0%2F24
curl -s --compressed http://localhost:8090/api/v1/lookup/name/thanos-querier
```

| Kind | Value | Matches |
|---|---|---|
| `ip` | one IPv4 or IPv6 address | rows that hold the address, and CIDRs that contain it |
| `mac` | six octets, any common spelling | rows that hold the MAC |
| `cidr` | `address/length` (host bits are masked off) | the same CIDR, CIDRs that contain it, and addresses and CIDRs inside it |
| `name` | text, case-insensitive substring | switch port, switch and router names, and network identities |

**Everything is in the path; nothing is read from a query string.** The
console's plugin asset handler drops query strings (`ovn-recon-e2b.12`), and
it also decodes the path before forwarding it, so a CIDR's `%2F` reaches the
collector as a literal slash. The value is therefore everything after the
kind segment: `/lookup/cidr/10.1.2.0%2F24` and `/lookup/cidr/10.1.2.0/24` are
the same request. Encode the value (`encodeURIComponent`) so that it survives
any hop that does not decode.

**A lookup reads stored snapshots only.** With live probing that is the
snapshot cache: whatever entry each current node has, however old and
whichever collector build wrote it. A lookup never collects, never starts
the background refresh a snapshot request would, and never answers from the
fixture files. Without live probing it searches the fixture corpus, as the
snapshot endpoints serve it. Each hit carries `snapshotGeneratedAt`, and
`zones` lists every zone that was searched with its snapshot time, so a
client can say how old an answer is; to refresh, request the snapshots and
look up again. A node with no cache entry is not searched and is named in a
`ZONE_NOT_CACHED` warning; a collector that probes live but has no cache
(`COLLECTOR_CACHE_DIR` unset) answers with no zones and a
`LOOKUP_CACHE_DISABLED` warning.

What is searched, by `table` and `matchedField`:

| Table | `ip` and `cidr` | `mac` | `name` |
|---|---|---|---|
| `Logical_Switch_Port` | `addresses`, `dynamicAddresses`, `portSecurity` | the same three | `name`, `externalIds.namespace` |
| `Logical_Router_Port` | `networks` | `mac` | |
| `NAT` | `externalIp`, `logicalIp` | `externalMac` | |
| `Logical_Router_Static_Route` | `ipPrefix` | | |
| `Logical_Switch` | `otherConfig.subnet`, `otherConfig.ipv6_prefix` | | `name`, `externalIds.k8s.ovn.org/network` |
| `Logical_Router` | | | `name`, `externalIds.k8s.ovn.org/network` |
| `Load_Balancer` | `vips` (the address of each key) | | |

Load balancer VIPs are matched only in a snapshot that carries the `services`
section. A cache entry written by a current collector does; an entry left by
a collector that predates the section, or a ladder-only fixture, does not.

`matchType` says how the stored value relates to the query:

- `exact`: the stored address, CIDR or name equals it.
- `containment`: a stored CIDR contains the queried address or CIDR. The row
  is about a range the query falls in (a subnet-wide SNAT rule, a route, a
  switch subnet), not about the address itself. A zero-length prefix (a
  default route) is never a containment match.
- `within` (`cidr` only): the stored address or CIDR lies inside the queried
  CIDR.
- `substring` (`name` only): the stored name contains the text.

An address written with a mask on a port (`100.88.0.5/16` on a router port or
a remote switch port) is that port's address: it matches on the address and
never by the mask beside it. A row is one hit however many of its fields
match (a pod port holds its address in `addresses` and in `portSecurity`);
the best match type is reported, and between equals the first field in the
table above.

Each hit:

```json
{
  "node": "worker-a",
  "table": "Logical_Switch_Port",
  "rowUuid": "0b6a4d0e-…",
  "rowName": "openshift-monitoring_thanos-querier-7b7bd6f866-nhwtv",
  "construct": { "kind": "switch", "name": "worker-a", "uuid": "5c1f…" },
  "network": "default",
  "owner": { "kind": "Pod", "namespace": "openshift-monitoring", "name": "thanos-querier-7b7bd6f866-nhwtv" },
  "matchedField": "addresses",
  "matchedValue": "0a:58:0a:83:00:46 10.131.0.70",
  "matchType": "exact",
  "snapshotGeneratedAt": "2026-11-10T12:00:00Z"
}
```

- `node` is the zone. The same row seen from another zone is another hit.
- `construct` is the switch that lists a port, the router that lists a port,
  NAT rule or static route, or the row itself when it is a switch or router.
  It is absent for a load balancer, which many switches and routers attach,
  and for a row nothing in the zone references.
- `network` is the `k8s.ovn.org/network` identity (`default`,
  `cluster_udn_<name>`, `<namespace>_<name>`): the row's own
  `k8s.ovn.org/network` external_id, else the network of its
  `k8s.ovn.org/owner-controller`, else the same from its construct, else
  `default`. These are the plugin's classification rules
  (`logicalClassification.ts`, `ovnOwner.ts`), not a second set.
- `owner` is present when external_ids name one: `Pod` for a switch port
  flagged `pod=true` with a `namespace` (the pod name is the last
  underscore-separated segment of the port name; the `pod` external_id is a
  flag, not a name); the `k8s.ovn.org/kind` and `k8s.ovn.org/owner`
  (`namespace/name`) pair that load balancers carry; otherwise
  `k8s.ovn.org/owner-type` with `k8s.ovn.org/name` as written.
- `rowName` is absent for `NAT` and `Logical_Router_Static_Route`, which have
  no name column.

**Every hit is returned; none is chosen.** User-defined network subnets may
overlap, and the transit and join subnets are the same in every network, so
one address is often in several networks at once, in one zone. Use `network`
and `construct` to tell the hits apart.

A name lookup matches the names OVN stores. Those spell a network with dots
for dashes (`cluster_udn_example.p.cudn_ovn_layer2_switch` for the network
`example-p-cudn`), so switches and routers are also matched on their network
identity, which keeps the real name. A virtual machine is found through its
`virt-launcher-<vm>-…` pod.

Hits are ordered best first: `exact`, `containment` (longest stored prefix
first), `within`, `substring`; then by node, table and row name. A response
carries at most 200 hits: `total` counts every matching row, `limit` is the
cap, and `truncated` is true when hits were cut. What is cut is the tail of
that order.

Errors: `400` with a plain-text reason for an unknown kind, a missing value,
or a value that does not parse as its kind (an `ip` with a mask, a `cidr`
without one, a `mac` that is not six octets); `405` for anything but `GET`.

The search itself is `snapshot.Lookup` / `snapshot.LookupSearch` in
`internal/snapshot/lookup.go`, a pure function over snapshots, for any other
caller that needs the same answer.

### Response headers

- `Cache-Control: no-store`
- `Vary: Accept-Encoding`
- `Content-Encoding: gzip` when the request sends `Accept-Encoding: gzip`
  (snapshot JSON compresses about five times, the policy tables seven to
  eight); a request without it gets the uncompressed body
- `X-OVN-Recon-Snapshot-Generated-At` (per-node endpoint, when metadata
  includes `generatedAt`)
- `X-OVN-Recon-Snapshot-Source-Health` (snapshot endpoints)
- `X-OVN-Recon-Snapshot-Node-Name` (per-node endpoint)

The lookup endpoint sends the first three; its snapshot times are in the
body.

## Snapshot Source

The server first attempts live OVN collection using Kubernetes pod exec in `COLLECTOR_TARGET_NAMESPACES`.
If live collection fails, it falls back to snapshot JSON from `SNAPSHOT_DIR` and adds a `LIVE_PROBE_FAILED` warning.

- Default (local): `./fixtures/snapshots`
- Default (container image): `/app/fixtures/snapshots`

Lookup order:
1. `${SNAPSHOT_DIR}/<nodeName>.json`
2. `${SNAPSHOT_DIR}/default.json` fallback

## Contract Artifacts

- Go types: `internal/snapshot/types.go`, `internal/snapshot/lookup_types.go`
- JSON schemas: `api/logical-topology-snapshot.schema.json`,
  `api/cluster-logical-topology.schema.json`,
  `api/lookup-response.schema.json`
- UI TypeScript types: `../src/types.ts`
- Fixture corpus: `fixtures/snapshots/*.json`

The lookup contract is checked on both sides: the collector's tests compare
the Go types and enums with `lookup-response.schema.json` and validate real
responses against it, and `../src/lookupContract.test.ts` compares the
TypeScript types with the same schema.

The schemas and the fixture corpus are kept in canonical serializer form:
exactly `JSON.stringify(value, null, 2)` plus a trailing newline (Python's
`json.dumps(value, indent=2, ensure_ascii=False)` produces the same bytes).
That lets a script in either language load, edit and dump a contract file
without a formatting diff. After editing one by hand, run
`npm run format:contract` from the repository root; `npm run check:contract`
(also run by CI and by the Jest suite) fails when a file is not canonical.

## Build and Run

```bash
cd collector
make build
make run
```

## Image Build

```bash
cd collector
make image IMAGE_TAG=dev
```

## Runtime and RBAC Assumptions (Planned)

Live OVN collection requires read + pod exec access in at least one namespace
that contains runnable OVN probe pods. The default target namespace list is:
- `openshift-ovn-kubernetes`
- `openshift-frr-k8s`

`openshift-frr-k8s` is optional. Clusters only have that namespace when the
OpenShift FRR stack is enabled. If the namespace is missing, forbidden, or has no
running pods, the collector logs a warning and continues with other configured
probe namespaces. Current logical topology collection reads the OVN NB
database in one `ovsdb-client transact` exec against the `nbdb` container
(falling back to per-table `ovn-nbctl list` with an `NB_TRANSACT_FAILED`
warning) plus one `ovn-sbctl` exec for chassis bridge mappings, and can remain
healthy when `openshift-ovn-kubernetes` is available.

Namespace targets should remain configurable.

## Runtime Semantics

Design notes for snapshot transport/freshness/degraded behavior and initial budgets:
- `../docs/tasks/OVN_COLLECTOR_RUNTIME_SEMANTICS.md`
