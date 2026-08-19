# Operator Anti-Pattern Remediation Plan

**Source:** `docs/anti-pattern-report.txt` (Operator Anti-Pattern Scanner v1.0.0, run 2026-07-07)
**Scope:** `operator/` — 19 findings: 3 CRITICAL, 12 HIGH, 4 MEDIUM

## Root Cause

`operator/cmd/main.go` constructs the manager with `ctrl.Options` that set **no
`Cache` field at all**. With controller-runtime defaults, every object type the
cached client touches (via `Watches()`, `Get()`, or `List()`) silently spawns a
**cluster-wide informer** that LISTs and WATCHes every object of that type in
every namespace. Nearly all findings trace back to this, which is why the
cache-configuration task (T1) is the foundation the rest depend on.

Facts that shape the fix design (verified against the code):

- `OvnRecon` is **cluster-scoped** (`+kubebuilder:resource:scope=Cluster`) and
  the target namespace is per-CR (`targetNamespace(ovnRecon)`), so
  `DefaultNamespaces` scoping is **not** viable — label-selector `ByObject`
  scoping is the right approach.
- Managed Deployments/Services already carry
  `app.kubernetes.io/name: ovn-recon` labels
  (`desired_resources.go` `labelsForOvnReconWithVersion`), usable as the cache
  filter selector.
- `go.mod` has no `openshift/api` dependency; ConsolePlugin and Console are
  accessed as `unstructured.Unstructured`.

## Findings → Tasks

### T1 — AP-4 (HIGH): Add explicit `cache.Options` to the manager

`cmd/main.go:183` area — `ctrl.NewManager` is called with no `Cache` field.

> **Correction (2026-08-18):** `DisableFor` is **not** a `cache.Options` field.
> It lives in `ctrl.Options.Client.Cache` (`client.CacheOptions`). The manager
> needs both: `Cache: cache.Options{ByObject: ...}` for informer scoping and
> `Client: client.Options{Cache: &client.CacheOptions{DisableFor: ...}}` for
> cache bypass.
>
> **Scanner under-reported:** `controllerutil.CreateOrUpdate` issues a cached
> `Get`, so `corev1.ServiceAccount`, `rbacv1.ClusterRole` and
> `rbacv1.RoleBinding` each had an invisible cluster-wide informer too, plus
> `corev1.Namespace` via `r.Get` at `:622`/`:1076`. The real pre-fix
> invisible-informer count was **6, not 1**.

Fix: add `Cache: cache.Options{ByObject: ...}` scoping each cached type:

- `appsv1.Deployment`, `corev1.Service`: label selector
  `app.kubernetes.io/name=ovn-recon`.
- `corev1.Namespace`: metadata-only / stripped transform (see T3).
- `reconv1beta1.OvnRecon`: leave unfiltered (operator's own primary resource,
  low cardinality).
- Consider `DisableFor` for types only read occasionally (see T2/T4 for the
  per-type decision).

This task establishes the cache policy; T2–T6 implement per-type decisions on
top of it. Document the chosen policy in `operator/README.md`.

### T2 — AP-3 (CRITICAL): Invisible cluster-wide Deployment informer

`internal/controller/ovnrecon_controller.go:1013` — `checkDeploymentReady()`
does `r.Get(...)` on `appsv1.Deployment`. First call creates a cluster-wide
informer over **every Deployment in the cluster**.

Fix (choose in T1's policy): `ByObject` with the
`app.kubernetes.io/name=ovn-recon` label selector (preferred — the readiness
check runs every reconcile, so keeping it cached is worthwhile), or add
`&appsv1.Deployment{}` to `DisableFor` and accept direct API reads. Note the
managed Service should get the same treatment for consistency. Verify RBAC
still matches (informer needs `list`+`watch`).

### T3 — AP-1 (HIGH): Namespace watch caches every Namespace, full objects

`internal/controller/ovnrecon_controller.go:719-725` — `SetupWithManager` has
`Watches(&corev1.Namespace{}, ...)` for collector probe-namespace events, plus
a global `WithEventFilter(predicate.GenerationChangedPredicate{})`.

Two problems:

1. The Namespace informer caches full Namespace objects cluster-wide; only
   name/existence is used (`reconcileRequestsForProbeNamespace` reads
   `object.GetName()`). Fix: switch to `WatchesMetadata()` (metadata-only
   informer) or add a `ByObject` transform stripping everything but metadata.
2. `WithEventFilter` applies the generation predicate to **all** watches
   including Namespaces, which is both ineffective for cache size and
   semantically wrong for namespace events. Fix: move it to a per-watch
   `builder.WithPredicates(...)` on the `For()` clause.

### T4 — AP-5 (HIGH ×10): Typed/unstructured cache trap for ConsolePlugin & Console

> **Resolved as FALSE POSITIVE (2026-08-18, during T1).**
> `client.CacheOptions.Unstructured` defaults to `false`
> (controller-runtime v0.19.7 `pkg/cluster/cluster.go:218-222`), and
> `client.shouldBypassCache()` returns `true` for any `runtime.Unstructured`
> when that flag is false. ConsolePlugin and Console reads have therefore
> always gone live to the API server — no unstructured informers ever existed.
> The scanner does not model this default. T1 pins `Unstructured: false`
> explicitly. **Option B adopted** (user decision); T4 reduces to consistency
> review plus dropping the now-provably-unneeded `list;watch` RBAC on
> `consoleplugins`/`consoles`.

`ovnrecon_controller.go:921-922, 947-948, 1049-1050, 1160-1161`,
`desired_resources.go:437-438` — ConsolePlugin (`console.openshift.io/v1`) and
Console (`operator.openshift.io/v1`) are read/written as
`unstructured.Unstructured` through the cached client, spawning separate
unstructured cluster-wide informers alongside the typed cache.

Decision to make, then apply consistently to all five sites:

- **Option A (preferred):** add `github.com/openshift/api` and use typed
  `consolev1.ConsolePlugin` / `operatorv1.Console`, registered in the scheme,
  with cache policy from T1 (Console is a singleton — `DisableFor` +
  direct reads is reasonable; ConsolePlugin count is tiny).
- **Option B:** keep unstructured but add both GVKs to `DisableFor` so
  reads bypass the cache entirely (no informers, no watch RBAC).

Either way, eliminate the mixed-representation access pattern.

### T5 — AP-3 (CRITICAL ×2, likely false positive): OvnReconList informer

`ovnrecon_controller.go:485, 737` — `r.List(ctx, &OvnReconList{})`. The scanner
flags these, but `For(&reconv1beta1.OvnRecon{})` already creates this informer;
the List is served from the existing cache at no extra cost.

Task: verify (informer metrics / `kubectl get --raw` audit or envtest
assertion), document the conclusion in the bead and in T1's cache policy notes,
and ensure any `ByObject` filter added for OvnRecon in T1 doesn't hide CRs from
`primaryInstance()` selection. No code change expected.

### T6 — AP-9 (MEDIUM ×4): Label preservation on Update paths

`ovnrecon_controller.go:985, 1066, 1196, 1233`. Only becomes a real bug once T1
introduces label-filtered caching: an Update that drops the filter label makes
the object invisible to the filtered informer and the operator fights itself.

Scope carefully — the scanner over-reports here:

- `:985` / `:1196` (Console updates) and `:1066` / `:1233` (OvnRecon
  finalizer/status updates) touch objects the operator does **not** label-filter
  (Console is not ours to label; OvnRecon cache should stay unfiltered per T1).
- The real work: audit every `CreateOrUpdate` mutate function and `Update()`
  on **managed** resources (Deployment, Service, ConfigMap, RBAC) to guarantee
  the `app.kubernetes.io/name=ovn-recon` filter label is (re)applied before
  every write. Add a shared helper, e.g. `ensureManagedLabels(obj)`.

### T7 — Validation: prove the informer footprint shrank, no regressions

- `make -C operator test` (envtest) green; extend tests where cache behavior
  changed (e.g. T3 metadata watch still triggers reconciles).
- Re-run the anti-pattern scanner; expect AP-1/3/4/5/9 clean or documented as
  accepted (T5).
- Compare informer/watch counts before/after (controller-runtime
  `rest_client_requests_total`, or apiserver audit of LIST/WATCH on startup)
  and record numbers in the bead.
- Verify RBAC: removing informers may allow **dropping** `watch`/`list` on
  Deployments cluster-wide, etc. Regenerate bundle if RBAC markers change.

## Dependency Graph

```
                 ┌──────────────────────────────┐
                 │ T1  AP-4 cache.Options (P1)  │
                 └──┬─────┬─────┬─────┬─────────┘
                    │     │     │     │
        ┌───────────┘     │     │     └───────────┐
        ▼                 ▼     ▼                 ▼
  T2 AP-3 Deployment  T3 AP-1  T5 AP-3 verify  T4 AP-5 ConsolePlugin/
  informer (P1)       NS watch OvnReconList    Console representation
        │             (P2)     (P3)            (P2)
        │                 │     │                 │
        │                 │     │     ┌───────────┤
        │                 │     │     ▼           │
        │                 │     │  T6 AP-9 labels │
        │                 │     │  (P3, also ← T1)│
        ▼                 ▼     ▼     ▼           ▼
                 ┌──────────────────────────────┐
                 │ T7  Validation & scanner     │
                 │     re-run (P2)              │
                 └──────────────────────────────┘
```

All of T1–T6 block T7. T1 blocks T2, T3, T4, T5, T6. T4 additionally blocks T6.

## Initial Beads Backlog Mapping

| Task | Bead ID | Title | Priority | Depends on |
|------|---------|-------|----------|------------|
| Epic | ovn-recon-5gu | Remediate operator anti-pattern scan findings | P1 | — |
| T1 | ovn-recon-5gu.1 | AP-4: Add explicit cache.Options to manager | P1 | — |
| T2 | ovn-recon-5gu.2 | AP-3: Scope Deployment informer (label selector or DisableFor) | P1 | T1 |
| T3 | ovn-recon-5gu.3 | AP-1: Metadata-only Namespace watch, per-watch predicates | P2 | T1 |
| T4 | ovn-recon-5gu.4 | AP-5: Unify ConsolePlugin/Console access (typed or uncached) | P2 | T1 |
| T5 | ovn-recon-5gu.5 | AP-3: Verify OvnReconList List() served by For() informer | P3 | T1 |
| T6 | ovn-recon-5gu.6 | AP-9: Ensure filter labels preserved on managed-resource writes | P3 | T1, T4 |
| T7 | ovn-recon-5gu.7 | Validate informer footprint reduction, re-run scanner | P2 | T2–T6 |
