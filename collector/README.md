# OVN Collector (Phase 2 Skeleton)

This component provides a Go-based server-side collector for Phase 2 logical OVN visualization.

## Current State

This is an initial scaffold with:
- `cmd/ovn-collector` entrypoint
- `internal/snapshot` canonical payload types
- HTTP endpoints for health/readiness and node-scoped snapshot retrieval
- collector-local `Makefile` and `Dockerfile`

The OVN probing pipeline and Kubernetes integration are not implemented yet.

## Endpoints

- `GET /healthz`
- `GET /readyz`
- `GET /api/v1/snapshots/:nodeName`

Example:

```bash
curl -s http://localhost:8090/api/v1/snapshots/worker-0
```

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
