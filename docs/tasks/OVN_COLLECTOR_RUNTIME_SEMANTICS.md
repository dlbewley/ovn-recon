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

## Snapshot Cache (ovn-recon-e18.17)
- Disk-backed cache of zone snapshots, one file per node: `<cacheDir>/<node>.json`
  (deterministic; same convention as the fixture store but a separate,
  writable directory so fixtures stay read-only).
- Configuration reaches the collector as env:
  - `COLLECTOR_CACHE_DIR` — empty disables the cache (also disabled in
    store-only mode, where fixtures are already instant and authoritative).
  - `COLLECTOR_CACHE_TTL_SECONDS` — default 120; runtime floor 30 (clamped
    with a warning), matching the CRD's `minimum: 30` validation.
- Operator API: `spec.collector.cache` — `enabled` (default true),
  `ttlSeconds` (min 30, default 120), and `storage.mode`:
  - `EmptyDir` (default): ephemeral, restart-stable for the pod's lifetime.
    Zero configuration; cache re-warms after rescheduling.
  - `PVC` with `storage.claimName`: survives rescheduling; the claim must
    already exist. PVC mode without a claimName falls back to EmptyDir.
- Request semantics (`collectZone`, per-node and aggregate paths alike):
  1. Cache entry younger than TTL (by its own `generatedAt`, so freshness is
     meaningful across restarts) → served as-is, no probe.
  2. Stale entry → served immediately, and a single-flight background
     revalidation refreshes it (stale-while-revalidate). Staleness stays
     bounded near the TTL while anyone is watching; the entry's own
     `generatedAt` carries the staleness signal to the UI freshness chip.
  3. No entry → synchronous live probe; on success the result is written
     back atomically (temp file + rename — a torn write reads as a miss).
  4. Synchronous probe failure with no entry → fixture fallback with
     `LIVE_PROBE_FAILED`; failed background revalidations are logged and the
     stale entry keeps serving — real observed data beats fixtures.
- Warm-up and idle behavior: one background sweep at collector startup
  collects zones whose entries are missing or stale (a PVC-backed cache with
  fresh entries makes it a no-op). There is NO recurring refresh cycle — an
  idle collector runs zero probes; revalidation is demand-driven per request.

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
