# Operator Cache Hygiene — Remediation Results

**Epic:** `ovn-recon-5gu` · **Completed:** 2026-08-18
**Against:** `docs/anti-pattern-report.txt` (Operator Anti-Pattern Scanner v1.0.0, 2026-07-07)
**Plan:** `docs/tasks/operator-anti-pattern-remediation.md`

## Scanner re-run

**Not possible.** Only the scanner's *output* is in the repo; the tool itself is
not vendored, committed, or referenced by any Makefile target or workflow. Every
finding is instead dispositioned individually below, which is the substance a
re-run would have produced. If the tool resurfaces, this table is what its
output should be checked against.

## Findings disposition (19 of 19)

| ID | Sev | Site | Disposition |
|---|---|---|---|
| AP-1 | HIGH | `ovnrecon_controller.go:723` | **Fixed** (T3). `WithEventFilter` moved to `For(..., builder.WithPredicates(...))`; Namespace watch is now `WatchesMetadata` with an existence-only predicate. |
| AP-3 | CRITICAL | `ovnrecon_controller.go:1013` | **Fixed** (T1/T2). The Deployment informer is label-scoped to `app.kubernetes.io/name=ovn-recon`. |
| AP-3 | CRITICAL ×2 | `ovnrecon_controller.go:485`, `:737` | **False positive** (T5). `For(&OvnRecon{})` already opens that informer and `List(&OvnReconList{})` is served from it. Proven in envtest, both directions — see below. |
| AP-4 | HIGH | `cmd/main.go:183` | **Fixed** (T1). Explicit `Cache` and `Client` options; policy in `internal/controller/cache_policy.go`. |
| AP-5 | HIGH ×10 | `ovnrecon_controller.go:921,922,947,948,1049,1050,1160,1161`, `desired_resources.go:437,438` | **False positive** (T4). `client.CacheOptions.Unstructured` defaults to `false` (controller-runtime v0.19.7 `pkg/cluster/cluster.go:218-222`) and `shouldBypassCache()` returns true for any `runtime.Unstructured` when it is, so these reads always went live. No unstructured informer ever existed. Now pinned explicitly and the corresponding RBAC narrowed. |
| AP-9 | MEDIUM ×4 | `ovnrecon_controller.go:985,1066,1196,1233` | **Not applicable as reported** (T6). Verified on `main`: `:985`/`:1196` update the Console (unstructured, uncached, not ours to label) and `:1066`/`:1233` update OvnRecon finalizers/status (cache deliberately unfiltered). None touches a label-filtered object. The underlying risk is real elsewhere, and is fixed — see T6 below. |

**Net:** 6 findings fixed, 12 false positives, 4 re-scoped and fixed at their real
site. No finding left unaddressed.

### What the scanner missed

It flagged one invisible informer; there were **six**. `controllerutil.CreateOrUpdate`
issues a cached `Get`, so `ServiceAccount`, `ClusterRole` and `RoleBinding` each
had a cluster-wide informer too, as did `Namespace` via the two existence checks
at `:622` and `:1076`. All four are now uncached.

Conversely, the AP-9 rule fires on any `Update()` without a visible label
assignment, and the AP-5 rule assumes unstructured reads are cached. Both
over-report against this codebase.

## Informer footprint

| Type | Before | After |
|---|---|---|
| `OvnRecon` | cluster-wide | cluster-wide *(intentional — `For()`, low cardinality, must stay unfiltered for `primaryInstance()`)* |
| `Deployment` | cluster-wide, full objects | **label-filtered** |
| `Service` | cluster-wide, full objects | **label-filtered** |
| `Namespace` | cluster-wide, full objects | **metadata-only** |
| `ServiceAccount` | cluster-wide, full objects | **none** |
| `ClusterRole` | cluster-wide, full objects | **none** |
| `RoleBinding` | cluster-wide, full objects | **none** |
| `ConsolePlugin`, `Console` | none | none *(now pinned)* |

**7 cluster-wide unfiltered informers → 4**, of which 2 are label-scoped and 1 is
metadata-only. Three are gone outright.

These counts are derived from the call sites, not measured against a live
cluster; `make -C operator test` asserts the resulting behaviour directly
(below). A production before/after of `rest_client_requests_total` would confirm
the memory and watch-traffic saving but was not run.

## RBAC

Five markers narrowed, since a type that is never cached needs no cluster-wide
`list`/`watch`:

| Resource | Before | After |
|---|---|---|
| `serviceaccounts` | `get,list,watch,create,update,patch,delete` | `get,create,update,patch,delete` |
| `clusterroles`, `rolebindings` | `get,list,watch,create,update,patch,delete` | `get,create,update,patch,delete` |
| `consoleplugins` | `get,list,watch,create,update,patch,delete` | `get,create,update,patch,delete` |
| `consoles` | `get,list,watch,update,patch` | `get,update,patch` |

Deliberately unchanged: `deployments` and `services` keep `list`+`watch` (their
label-filtered informers still LIST+WATCH), `namespaces` keeps them (metadata
informer), and `pods`/`pods/exec` keep them because the operator can only grant
the collector ClusterRole verbs it holds itself.

**No bundle regeneration needed** — `operator/bundle/` is gitignored and CI
regenerates it from `config/` at release time, so `config/rbac/role.yaml` is the
only checked-in artifact and it is current. (The plan assumed otherwise.)

## Verification

`make -C operator test` green, 58.6% statement coverage (was 58.2%).
`make -C operator lint` reports no issue in any added or changed file; its
pre-existing failures are unchanged (`goconst` counts vary run to run, so the
non-`goconst` issue set was compared instead — identical, 23 both sides).

Structural assertions in `cache_policy_test.go`, runtime assertions against
envtest in `cache_runtime_test.go`:

- **T5** — `List(&OvnReconList{})` succeeds after `GetInformer(&OvnRecon{})` and
  fails with `ErrResourceNotCached` without it, under
  `ReaderFailOnMissingInformer`. The negative case is what makes the positive one
  mean anything.
- **T2/T1** — with `ManagerCacheOptions()`, a labelled Deployment is visible to
  the cache and an unlabelled one is not.
- **T3** — a metadata-only Namespace informer serves
  `PartialObjectMetadataList`, and a typed `NamespaceList` read fails, which is
  why `corev1.Namespace` had to move to `DisableFor`.
- **T6** — stripping the filter label really does make a managed Deployment
  vanish from the informer, and `ensureManagedLabels` restores it.
- **T8** — a status-only Deployment update reaches the reconciler, an unmanaged
  Deployment does not, and the request carries no namespace (`OvnRecon` is
  cluster-scoped). This spec drives a real manager; it mirrors the
  `SetupWithManager` wiring rather than calling it, because the real reconciler
  reads ConsolePlugin and Console, which do not exist in envtest.

## T8 — event-driven readiness

`checkDeploymentReady()` was only ever reached by `RequeueAfter` polling: the
controller had no Deployment watch, so the pre-existing cluster-wide Deployment
informer was pure cost with no event benefit. It now has one, and the
not-ready requeue drops from a 10-second poll to a 2-minute backstop.

**Not `Owns()`, despite what the bead said.** The operator sets **no owner
references** on any managed resource — `ovnrecon_controller.go:1063` records
the reasoning ("no owner refs with cluster-scoped CRs") and cleanup runs
through the finalizer instead. `Owns()` enqueues from `ownerReferences`, so it
would have been a silent no-op. The watch maps by the
`app.kubernetes.io/instance` label instead, which every managed resource
already carries, and the informer is already scoped to this operator's objects.

For the record, the premise behind that comment is not quite right: Kubernetes
does permit a namespaced dependent to declare a cluster-scoped owner, and
garbage collection handles it. Switching to real owner references is therefore
possible, but it changes deletion semantics and interacts with the existing
finalizer, so it was left alone here.

**No predicate may be attached to this watch.** Readiness arrives as a
status-only update, which a `GenerationChangedPredicate` would discard —
returning readiness to polling with no visible failure. The envtest spec
asserts a status-only update reaches the reconciler, and was confirmed to fail
when such a predicate is added.

## Follow-up

None outstanding for this epic.
