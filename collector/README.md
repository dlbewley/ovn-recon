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
- `GET /api/v1/snapshots/:nodeName`

Example:

```bash
curl -s http://localhost:8090/api/v1/snapshots/worker-a
```

Response headers:
- `Cache-Control: no-store`
- `X-OVN-Recon-Snapshot-Generated-At` (when metadata includes `generatedAt`)
- `X-OVN-Recon-Snapshot-Source-Health`
- `X-OVN-Recon-Snapshot-Node-Name`

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
