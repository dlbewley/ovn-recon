# OVN Collector Runtime Semantics (MVP)

## Scope
This document defines the Day-1 semantics for Phase 2 snapshot delivery from the collector to the UI.

## Snapshot Transport
- Endpoint: `GET /api/v1/snapshots/:nodeName`
- Payload: `LogicalTopologySnapshot` JSON
- Caching: `Cache-Control: no-store`
- Metadata headers:
  - `X-OVN-Recon-Snapshot-Generated-At`
  - `X-OVN-Recon-Snapshot-Source-Health`
  - `X-OVN-Recon-Snapshot-Node-Name`

## Freshness Semantics
- Snapshot freshness is computed from `metadata.generatedAt`.
- UI thresholds (current implementation in `/Users/dale/src/ovn-recon/src/components/NodeLogicalTopologyDetails.tsx`):
  - `fresh`: age < 2 minutes
  - `warning`: age >= 2 minutes and < 10 minutes
  - `critical`: age >= 10 minutes
- UI behavior:
  - Shows freshness alert for every loaded snapshot.
  - Surfaces collector warnings and degraded source health inline.
  - Auto-refreshes every 30 seconds and supports manual refresh.

## Degraded and Error Semantics
- `metadata.sourceHealth`:
  - `healthy`: probe/parsing completed without warnings
  - `degraded`: one or more command/parsing warnings were recorded
- `warnings[]` carries structured details such as:
  - `COMMAND_FAILED`
  - `PARSER_FAILED`
  - `PARSER_NORMALIZED`
- Node-scoped fallback:
  - Server attempts `<nodeName>.json` then `default.json` when using file-backed store.
  - Fallback payload sets `metadata.nodeName` to requested node when missing.

## Initial Performance Budgets
- Collector command+normalize+assemble target: <= 5s for typical node snapshot.
- Collector endpoint response target (cached snapshot): p95 <= 300ms.
- UI interaction target on dense fixture (`worker-dense`):
  - pan/zoom/filter interactions remain responsive (no visible lockups)
  - first render <= 1s on developer workstation baseline
- Budget validation status:
  - Parser and snapshot assembly have unit tests.
  - Additional perf/regression harness is tracked in `ovn-recon-e18.5`.

## Open Follow-ups
- Wire Kubernetes pod exec runner into `collector/internal/probe`.
- Add metrics for probe duration, parse failures, and stale snapshot count.
- Add automated perf checks for large fixture sets.
