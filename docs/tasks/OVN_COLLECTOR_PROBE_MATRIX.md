# OVN Collector MVP Probe Matrix

## Scope
This matrix defines the initial command targets, parser paths, and RBAC expectations for node-scoped logical topology collection.

## Runtime Inputs
- Node perspective input: `:name` from `/ovn-recon/ovn/:name`
- Probe namespaces (default):
  - `openshift-ovn-kubernetes`
  - `openshift-frr-k8s`
- Probe namespace list is configurable via `spec.collector.probeNamespaces` (legacy `spec.collectorProbeNamespaces` is also accepted for compatibility).

## Command Matrix (MVP)

| Purpose | Namespace | Pod Selection | Container | Command | Parser/Builder Path | Required RBAC |
|---|---|---|---|---|---|---|
| Logical switches snapshot | `openshift-ovn-kubernetes` | node-scoped OVN pod on `:name` | `nbdb` (or equivalent OVN DB container) | `ovn-nbctl --format=json list Logical_Switch` | Go snapshot builder (typed model -> `LogicalTopologySnapshot.nodes/edges`) | `pods get/list/watch`, `pods/exec create` |
| Logical routers snapshot | `openshift-ovn-kubernetes` | node-scoped OVN pod on `:name` | `nbdb` | `ovn-nbctl --format=json list Logical_Router` | Go snapshot builder | `pods get/list/watch`, `pods/exec create` |
| Logical switch ports snapshot | `openshift-ovn-kubernetes` | node-scoped OVN pod on `:name` | `nbdb` | `ovn-nbctl --format=json list Logical_Switch_Port` | Go snapshot builder | `pods get/list/watch`, `pods/exec create` |
| Gateway/BGP adjunct context (optional in MVP payload) | `openshift-frr-k8s` | FRR pod associated with `:name` | FRR container | command TBD by FRR integration needs | warning/metadata enrichment (degraded if unavailable) | `pods get/list/watch`, `pods/exec create` |

## Node Selection Semantics
- Resolver must prefer pods scheduled on node `:name`.
- If no pod is available on `:name`, collector returns node-scoped degraded snapshot with warning code `NODE_TARGET_NOT_FOUND`.
- If pod exists but command exec fails, collector returns degraded snapshot with warning code `PROBE_EXEC_FAILED`.

## Error and Staleness Semantics
- Missing node snapshot file/path: return HTTP 404 when no fallback exists.
- Missing node with fallback enabled: return fallback payload with warning `SNAPSHOT_DEFAULT` and `metadata.nodeName=:name`.
- Stale data: surface warning `SNAPSHOT_STALE` and expose stale timestamp in metadata.
- Partial collection failure: retain available graph fragments and emit warning per failed source.

## Output Requirements
- Output must conform to `collector/api/logical-topology-snapshot.schema.json`.
- `metadata.schemaVersion` must be explicit (current: `v1alpha1`).
- `warnings[]` must be used instead of silently dropping probe failures.

## Notes
- This matrix is intentionally minimal and should expand as `ovn-recon-e18.8` ports more OVN resources into typed Go collectors.
