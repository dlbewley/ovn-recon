# OVN Collector (Phase 2 Skeleton)

This component provides a Go-based server-side collector for Phase 2 logical OVN visualization.

## Current State

This scaffold includes:
- `cmd/ovn-collector` entrypoint
- `internal/snapshot` canonical payload types and file store
- `internal/probe` typed OVN parser + snapshot assembly pipeline
- HTTP endpoints for health/readiness and node-scoped snapshot retrieval
- fixture corpus under `fixtures/snapshots`
- collector-local `Makefile` and `Dockerfile`

Kubernetes exec integration is not wired yet; the OVN parsing/snapshot assembly pipeline is implemented and unit tested.

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

The server loads snapshot JSON from `SNAPSHOT_DIR`.

- Default (local): `./fixtures/snapshots`
- Default (container image): `/app/fixtures/snapshots`

Lookup order:
1. `${SNAPSHOT_DIR}/<nodeName>.json`
2. `${SNAPSHOT_DIR}/default.json` fallback

## Contract Artifacts

- Go types: `internal/snapshot/types.go`
- JSON schema: `api/logical-topology-snapshot.schema.json`
- UI TypeScript types: `/Users/dale/src/ovn-recon/src/types.ts`

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

Planned collector behavior requires read + pod exec access in:
- `openshift-ovn-kubernetes`
- `openshift-frr-k8s`

Namespace targets should remain configurable.

## Runtime Semantics

Design notes for snapshot transport/freshness/degraded behavior and initial budgets:
- `/Users/dale/src/ovn-recon/docs/tasks/OVN_COLLECTOR_RUNTIME_SEMANTICS.md`
