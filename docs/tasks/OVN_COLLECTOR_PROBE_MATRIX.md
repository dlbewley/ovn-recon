# OVN Collector MVP Probe Matrix

## Scope
This matrix defines the initial command targets, parser paths, and RBAC expectations for node-scoped logical topology collection.

## Runtime Inputs
- Node perspective input: `:name` from `/ovn-recon/ovn/:name`
- Probe namespaces (default):
  - `openshift-ovn-kubernetes`
  - `openshift-frr-k8s`
- Probe namespace list is configurable via `spec.collector.probeNamespaces` (legacy `spec.collectorProbeNamespaces` is also accepted for compatibility).

## Command Matrix (snapshot contract v2)

All NB tables are transcribed into `LogicalTopologySnapshot.database` (see
`collector/api/logical-topology-snapshot.schema.json`); each table failure
degrades the snapshot with a `COMMAND_FAILED`/`PARSER_FAILED` warning rather
than aborting collection.

Since `ovn-recon-e2b.1` the six NB tables are read in **one** pod exec, a
multi-op `select` transaction against the NB socket in the `nbdb` container:

```bash
ovsdb-client -f json transact unix:/var/run/ovn/ovnnb_db.sock \
  '["OVN_Northbound",{"op":"select","table":"Logical_Router","where":[]}, ...]'
```

The result is one consistent database state for every table (the per-table
`ovn-nbctl list` calls each read a different state), and adding a table is
one more entry in `nbTables` (`collector/internal/probe/nb_transact.go`). A
per-op error degrades only that table (`COMMAND_FAILED`). If the transact
exec itself fails (no `ovsdb-client` in the container, different socket) the
collector falls back to the per-table `ovn-nbctl --format=json list <Table>`
commands below and adds an `NB_TRANSACT_FAILED` warning. The SB chassis query
for bridge mappings is a separate `ovn-sbctl` exec in the `sbdb` container.

| Purpose | Namespace | Pod Selection | Container | Transact op (fallback command) | Parser/Builder Path | Required RBAC |
|---|---|---|---|---|---|---|
| Logical switches (`ports`, `acls`, `qos_rules`, `load_balancer[_group]` uuids, `other_config`, `external_ids`) | `openshift-ovn-kubernetes` | node-scoped OVN pod on `:name` | `nbdb` (or equivalent OVN DB container) | `select Logical_Switch` (`ovn-nbctl --format=json list Logical_Switch`) | `ParseLogicalSwitches` -> `database.logicalSwitches` | `pods get/list/watch`, `pods/exec create` |
| Logical routers (`ports`, `nat`, `static_routes`, `enabled`, `policies`, `load_balancer[_group]`, `copp` uuids, `options`, `external_ids`) | `openshift-ovn-kubernetes` | node-scoped OVN pod on `:name` | `nbdb` | `select Logical_Router` (`ovn-nbctl --format=json list Logical_Router`) | `ParseLogicalRouters` -> `database.logicalRouters` | `pods get/list/watch`, `pods/exec create` |
| Logical router ports (`mac`, `networks`, `peer`, `enabled`, `gateway_chassis`, `status:hosting-chassis`) | `openshift-ovn-kubernetes` | node-scoped OVN pod on `:name` | `nbdb` | `select Logical_Router_Port` (`ovn-nbctl --format=json list Logical_Router_Port`) | `ParseLogicalRouterPorts` -> `database.logicalRouterPorts` | `pods get/list/watch`, `pods/exec create` |
| Logical switch ports (`type`, `addresses`, `options`, `external_ids`) | `openshift-ovn-kubernetes` | node-scoped OVN pod on `:name` | `nbdb` | `select Logical_Switch_Port` (`ovn-nbctl --format=json list Logical_Switch_Port`) | `ParseLogicalSwitchPorts` -> `database.logicalSwitchPorts` | `pods get/list/watch`, `pods/exec create` |
| NAT rules (UDN masquerade/SNAT disambiguation; `gateway_port`, `match`, `priority`, `external_port_range`) | `openshift-ovn-kubernetes` | node-scoped OVN pod on `:name` | `nbdb` | `select NAT` (`ovn-nbctl --format=json list NAT`) | `ParseNATs` -> `database.nats` | `pods get/list/watch`, `pods/exec create` |
| Static routes (default routes, IC-learned routes; `route_table`, `bfd`, `selection_fields`) | `openshift-ovn-kubernetes` | node-scoped OVN pod on `:name` | `nbdb` | `select Logical_Router_Static_Route` (`ovn-nbctl --format=json list Logical_Router_Static_Route`) | `ParseStaticRoutes` -> `database.staticRoutes` | `pods get/list/watch`, `pods/exec create` |
| Gateway chassis (which chassis may host a distributed gateway port, with priority) | `openshift-ovn-kubernetes` | node-scoped OVN pod on `:name` | `nbdb` | `select Gateway_Chassis` (`ovn-nbctl --format=json list Gateway_Chassis`) | `gatewayChassisFromRows` -> `database.gatewayChassis` | `pods get/list/watch`, `pods/exec create` |
| Zone identity and config sequence (`name`, `nb_cfg`/`sb_cfg`/`hv_cfg`, `options:northd_internal_version`) | `openshift-ovn-kubernetes` | node-scoped OVN pod on `:name` | `nbdb` | `select NB_Global` (`ovn-nbctl --format=json list NB_Global`) | `nbGlobalFromRows` -> `database.nbGlobal` | `pods get/list/watch`, `pods/exec create` |
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
- `metadata.schemaVersion` must be explicit (current: `2`; `v1alpha1` snapshots carried only the deprecated graph payload).
- `warnings[]` must be used instead of silently dropping probe failures.

## Notes
- This matrix is intentionally minimal and should expand as `ovn-recon-e18.8` ports more OVN resources into typed Go collectors.
