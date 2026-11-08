# OVN Collector (Phase 2 Skeleton)

This component provides a Go-based server-side collector for Phase 2 logical OVN visualization.

## Current State

This scaffold includes:
- `cmd/ovn-collector` entrypoint
- `internal/snapshot` canonical payload types and file store
- `internal/probe` typed OVN parser + snapshot assembly pipeline
- in-cluster pod exec runner for live OVN interrogation
- HTTP endpoints for health/readiness and node-scoped snapshot retrieval
- fixture corpus under `fixtures/snapshots`
- collector-local `Makefile` and `Dockerfile`

## Endpoints

- `GET /healthz`
- `GET /readyz`
- `GET /api/v1/snapshots/:nodeName`: one node's zone snapshot
- `GET /api/v1/snapshots`: every reachable node's zone snapshot in one
  response (`ClusterLogicalTopology`)

Example:

```bash
curl -s http://localhost:8090/api/v1/snapshots/worker-a
curl -s --compressed 'http://localhost:8090/api/v1/snapshots/worker-a?include=policy,services'
```

### Optional sections (`include`)

Both snapshot endpoints take `?include=<section>[,<section>]` (the parameter
may also repeat). Without it a response carries the ladder tables only, which
is what the topology views fetch.

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
transaction and caches one full snapshot per node; `include` only selects
what a response carries, so asking for a section never triggers a second
collection. The aggregate endpoint honours `include` but a client that wants
section data for a cluster-wide view should read it from one node's snapshot.

The mechanism is ahead of the data: the collector does not populate the
sections until the policy plane (`ovn-recon-e2b.5`) and the service plane
(`ovn-recon-e2b.6`) add their tables and row types, so today a request with
`include` returns the same payload as one without.

### Response headers

- `Cache-Control: no-store`
- `Vary: Accept-Encoding`
- `Content-Encoding: gzip` when the request sends `Accept-Encoding: gzip`
  (snapshot JSON compresses about five times, the policy tables seven to
  eight); a request without it gets the uncompressed body
- `X-OVN-Recon-Snapshot-Generated-At` (per-node endpoint, when metadata
  includes `generatedAt`)
- `X-OVN-Recon-Snapshot-Source-Health`
- `X-OVN-Recon-Snapshot-Node-Name` (per-node endpoint)

## Snapshot Source

The server first attempts live OVN collection using Kubernetes pod exec in `COLLECTOR_TARGET_NAMESPACES`.
If live collection fails, it falls back to snapshot JSON from `SNAPSHOT_DIR` and adds a `LIVE_PROBE_FAILED` warning.

- Default (local): `./fixtures/snapshots`
- Default (container image): `/app/fixtures/snapshots`

Lookup order:
1. `${SNAPSHOT_DIR}/<nodeName>.json`
2. `${SNAPSHOT_DIR}/default.json` fallback

## Contract Artifacts

- Go types: `internal/snapshot/types.go`
- JSON schemas: `api/logical-topology-snapshot.schema.json`,
  `api/cluster-logical-topology.schema.json`
- UI TypeScript types: `../src/types.ts`
- Fixture corpus: `fixtures/snapshots/*.json`

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
- `/Users/dale/src/ovn-recon/docs/tasks/OVN_COLLECTOR_RUNTIME_SEMANTICS.md`
