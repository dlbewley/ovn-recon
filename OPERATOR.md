# OVN Recon Operator

The OVN Recon Operator manages the lifecycle of the [OVN Recon](https://github.com/dlbewley/ovn-recon) console plugin on OpenShift. It provides a declarative way to deploy, configure, and automatically enable the plugin within the OpenShift Web Console.

See also [OLM-BUNDLE-GUIDE.md](docs/OLM-BUNDLE-GUIDE.md).

## Features

- **Automated Deployment**: Manages the plugin backend (Deployment and Service).
- **Optional Logical Topology Collector**: Supports an `ovn-collector` feature gate for enabling collector-backed logical topology capabilities.
- **Console Integration**: Automatically creates `ConsolePlugin` resources and patches the OpenShift Console operator to enable the plugin.
- **Security Hardened**: Runs as non-root with minimal capabilities and mandatory seccomp profiles.
- **Observability**: Uses standard Kubernetes Status Conditions and Events for clear state reporting.
- **Cleanup Safety**: Uses finalizers to ensure all cluster-scoped resources and operator patches are removed when the custom resource is deleted.
- **Multi-instancing Protected**: Logic ensures only the primary (oldest) instance manages cluster-wide configurations like the Console operator.

---

## API Reference (`OvnRecon` CRD)

The operator reacts to the `OvnRecon` custom resource (Group: `recon.bewley.net`, Preferred Version: `v1beta1`, Scope: `Cluster`).

### Spec Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `targetNamespace` | `string` | `ovn-recon` | The namespace where namespaced resources (Deployment, Service) are created. |
| `operator.logging.level` | `string` | `info` | Operator log level. Allowed: `error`, `warn`, `info`, `debug`, `trace`. |
| `operator.logging.events.minType` | `string` | `Normal` | Minimum Kubernetes event type emitted by the operator. Allowed: `Normal`, `Warning`. |
| `operator.logging.events.dedupeWindow` | `string` | `5m` | Event deduplication window used by the operator event recorder. |
| `consolePlugin.displayName` | `string` | `OVN Recon` | The name displayed in the OpenShift console. |
| `consolePlugin.enabled` | `bool` | `true` | If true, the operator will patch the OpenShift Console configuration to enable the plugin. |
| `consolePlugin.image.repository`| `string` | `quay.io/dbewley/ovn-recon` | Plugin backend image repository. |
| `consolePlugin.image.tag` | `string` | _operator's own version_ | Plugin backend image tag. Defaults to `OPERATOR_VERSION` (stamped into the CSV at release), falling back to `latest` only when that is unset or `dev` — i.e. for `make deploy` development installs. |
| `consolePlugin.image.pullPolicy`| `string` | `IfNotPresent` | Plugin backend ImagePullPolicy. |
| `consolePlugin.logging.level` | `string` | `info` | Console plugin backend log level. Allowed: `error`, `warn`, `info`, `debug`. |
| `consolePlugin.logging.accessLog.enabled` | `bool` | `false` | Enables request access logging in the console plugin backend. |
| `collector.enabled` | `bool` | `false` | Enables logical topology features backed by the collector service. |
| `collector.image.repository`| `string` | `quay.io/dbewley/ovn-collector` | OVN collector image repository. |
| `collector.image.tag` | `string` | _inherits `consolePlugin.image.tag`_ | OVN collector image tag. |
| `collector.image.pullPolicy`| `string` | _inherits `consolePlugin.image.pullPolicy`_ | OVN collector image pull policy. |
| `collector.probeNamespaces` | `[]string` | `["openshift-ovn-kubernetes","openshift-frr-k8s"]` | Namespaces where collector is granted pod read/exec access. |
| `collector.logging.level` | `string` | `info` | Collector log level. Allowed: `error`, `warn`, `info`, `debug`, `trace`. |
| `collector.logging.includeProbeOutput` | `bool` | `false` | Includes raw probe command output in collector logs when enabled. |

### Migration Notes

- New hierarchical fields are preferred: `consolePlugin.image.*`, `collector.enabled`, `collector.image.*`, and `collector.probeNamespaces`.
- `v1beta1` is the storage version. `v1alpha1` remains served for compatibility.
- The CRD uses API-server conversion strategy `None` (schema parity between versions), so reads/writes in either served version are accepted.
- Legacy fields are still accepted for compatibility in both served versions:
  - `image.*` (use `consolePlugin.image.*`)
  - `featureGates.ovn-collector` (use `collector.enabled`)
  - `collectorImage.*` (use `collector.image.*`)
  - `collectorProbeNamespaces` (use `collector.probeNamespaces`)
- If both new and legacy fields are set, the new hierarchical fields win.
- If `operator.logging`, `consolePlugin.logging`, or `collector.logging` are omitted, runtime behavior matches prior defaults:
  - operator and component log levels default to `info`
  - operator events default to `minType=Normal` with `dedupeWindow=5m`
  - plugin access logs and collector probe output logging remain disabled

### Feature Gate Notes

- `collector.enabled` is intended to gate Phase 2 logical topology capabilities.
- Collector deployment targets the same namespace as `targetNamespace`.
- When enabled, the operator reconciles collector Deployment and Service resources named `<ovnrecon-name>-collector`.
- When enabled, the operator also reconciles collector ServiceAccount/ClusterRole and RoleBindings in each `collector.probeNamespaces` entry.
- Current default mode is standalone Deployment; DaemonSet support is a planned future evolution for per-node collection scale.

### Status Conditions

| Condition Type | Description |
|----------------|-------------|
| `Available` | `True` if the backend Deployment is ready. |
| `PluginEnabled`| `True` if the plugin is successfully enabled in the OpenShift Console operator state. |
| `NamespaceReady`| `True` if the `targetNamespace` exists and is accessible. |
| `ServiceReady` | `True` if the backend Service is reconciled. |
| `ConsolePluginReady` | `True` if the `ConsolePlugin` resource is reconciled. |

---

## OpenShift Version Compatibility

### Current state

Published releases up to and including `v0.3.7` support OpenShift 4.20 and later, and continue to
work on newer consoles — the `v0.3.7` plugin was verified running on a 4.22.8 console. One operator
version, one bundle, channels `stable` and `latest`, one plugin image.

Releases **after** `v0.3.7` target OpenShift 4.22+ only. See [The 4.22 break](#the-422-break).

### Why this changes at 4.22

The console plugin is not self-contained. OpenShift Console supplies React, react-router, and react-i18next to dynamic plugins at runtime through webpack module federation's shared scope, and **OpenShift 4.22 changes those shared modules** — React 17 to 18, react-router 5 to 7, react-i18next 11 to 16.

The incompatibility is **one-way**, which is easy to get wrong:

- **Old plugin on a new console: works.** Observed — the React 17 build (`v0.3.7`, SDK 1.8.0) runs on a 4.22.8 console with no errors. `ConsoleRemotePlugin` sets `requiredVersion` from the SDK package's own `peerDependencies`, and SDK 1.8.0 declares none, so that build shares React with no version expectation at all and simply uses whatever the console provides. `strictVersion` is never set by the SDK, so even a declared mismatch would only warn.
- **New plugin on an old console: breaks.** This build declares `@console/pluginAPI: >=4.22.0-0`, so a 4.21 console declines to load it. It would also fail on its own: `import { Link } from 'react-router'` resolves to react-router **v5** on 4.21, and v5 exports `Link` from `react-router-dom`, not `react-router`.

So a plugin stays usable on newer consoles for as long as the APIs it touches survive — which is luck, not contract, since `react-router-dom` and `react-router-dom-v5-compat` are both already deprecated.

This is a property of the plugin bundle only. The operator's Go reconcile logic, the `OvnRecon` CRD, and the collector are all unaffected — they have no console coupling. **A single operator build continues to work across both generations; only the plugin image it deploys must differ.**

### The 4.22 break

**Decision: a clean break, not a maintenance stream.** From the 4.22 migration onward, releases
target OpenShift 4.22+ and are deliberately incompatible with 4.21 and earlier. There is no
`release-4.21` branch, no backports, and no parallel stream.

Straddling both generations would mean freezing on an SDK that keeps falling further behind, buying
compatibility that expires on someone else's schedule — `react-router-dom` and
`react-router-dom-v5-compat` are already deprecated.

| | |
|---|---|
| `main` | OpenShift 4.22+ only |
| Last pre-4.22 release | `v0.3.7` — stays published and installable, receives nothing further |
| Backports | none |

The **operator** itself is unaffected by the console generation: its reconcile logic, the `OvnRecon`
CRD, and the collector have no console coupling. Only the plugin bundle is version-bound.

Guardrails, in the order they take effect:

| Guardrail | Where | Effect |
|---|---|---|
| `minKubeVersion: 1.35.0` | CSV | **The gate.** OLM will not install the bundle below Kubernetes 1.35 (OpenShift 4.22) |
| `@console/pluginAPI: >=4.22.0-0` | plugin `package.json` | Backstop — a 4.21 console declines to load the plugin instead of breaking the page |
| `olm.maxOpenShiftVersion` | CSV | Optional; blocks a **cluster** upgrade while an incompatible operator is installed. Not used |

`stable` and `latest` simply keep advancing; there is no per-generation channel and no frozen
channel. `minKubeVersion` does the gating instead, and it fails **safe**:

- A 4.21 cluster (Kubernetes 1.34) never installs the newer bundle. The CSV stays in
  `Pending` / `RequirementsNotMet` with `CSV version requirement not met: minKubeVersion (1.35.0) >
  server version (1.34.x)`.
- The **existing** operator keeps running. A replaced CSV is only garbage-collected once its
  replacement reaches `Succeeded`, and a Pending CSV never does — so `v0.3.7` is not torn down.

Verified against `openshift/operator-framework-olm` `release-4.20` and `release-4.21`
(`pkg/controller/operators/olm/requirements.go`, `operator.go`), not assumed.

The visible cost is cosmetic: a 4.21 user sees a permanently Pending CSV and a Subscription that
looks stuck, explained only by that terse OLM message. Release notes for 4.22-targeted releases
should state the OpenShift 4.22+ requirement plainly.

> [!IMPORTANT]
> **Catalog image tags** (decided in `ovn-recon-w35`):
>
> | Tag | Contains | Status |
> |---|---|---|
> | `:stable` | stable releases only | current |
> | `:latest` | every release, prereleases included | current |
> | `:v4.20` | alias of `:latest` | **deprecated, will be deleted** (`ovn-recon-09z`) |
>
> `:latest` changed meaning — it used to be stable-only. A Subscription on the `stable` *channel* is
> unaffected either way, since the channel decides what is offered, but a CatalogSource that wants
> stable-only content should point at `:stable`.
>
> `:v4.20` stopped meaning anything after the FBC migration: one catalog serves every supported
> OpenShift version, so the tag never selected a 4.20-specific catalog. When it is retired it will be
> **deleted**, not merely left unpublished — a `CatalogSource` still pointing at it should fail
> visibly rather than silently serve an ever-staler catalog. See
> [fbc-migration.md](docs/tasks/fbc-migration.md#catalog-image-tags).

> [!NOTE]
> **Operand images and disconnected installs.** The plugin and collector images are declared to OLM
> through the `RELATED_IMAGE_*` convention: `config/manager/manager.yaml` sets `RELATED_IMAGE_PLUGIN`
> and `RELATED_IMAGE_COLLECTOR`, operator-sdk harvests them into the CSV's `spec.relatedImages`, and
> CI stamps the release version over the `:dev` placeholder. That block is what
> `oc adm catalog mirror` and `ImageSetConfiguration` read, so without it a disconnected cluster
> would install the operator and then fail to pull its own workloads.
>
> The operator **consumes** those same env vars, so the images it deploys are the ones the bundle
> declared rather than merely agreeing by coincidence. Precedence: an explicit repository or tag on
> the `OvnRecon` CR wins, then `RELATED_IMAGE_*`, then the built-in default composed with
> `OPERATOR_VERSION`. A mirroring tool that rewrites `RELATED_IMAGE_*` to point at the mirror
> registry therefore changes what gets deployed, which is the whole point of the convention.

> [!NOTE]
> **How the plugin and collector images get pinned.** They are not named in the catalog. The operator
> derives their tag from `OPERATOR_VERSION`, which CI stamps into the CSV at release, so an OLM
> install of operator `vX.Y.Z` deploys `ovn-recon:vX.Y.Z` and `ovn-collector:vX.Y.Z`. That makes the
> plugin transitively pinned to whichever bundle the channel offered, with no OpenShift-version
> detection in the operator.
>
> Two cases resolve to `latest` instead and are worth pinning explicitly: a development install via
> `make deploy` (where `OPERATOR_VERSION` is `dev`), and any `OvnRecon` CR that sets
> `consolePlugin.image.tag: latest`.
>
> Note that `collector.image.tag` **inherits** the plugin tag when unset
> (`collectorImageTagFor()`), so overriding the plugin tag alone repoints the collector too — which
> will fail if no collector image exists under that tag.

---

## Operational Guide

### Prerequisites
- OpenShift **4.22 or later** for releases after `v0.3.7`; `v0.3.7` itself supports 4.20+. See [OpenShift Version Compatibility](#openshift-version-compatibility).
- `oc` or `kubectl` CLI.
- Cluster-admin permissions (required for CRD installation and Console operator patching).

### Installation (Development Mode)

1. **Install CRDs**:
   ```bash
   cd operator
   make install
   ```

2. **Run Locally**:
   ```bash
   # Ensure your KUBECONFIG is set
   make run
   ```

3. **Deploy Sample** [recon_v1beta1_ovnrecon.yaml](config/samples/recon_v1beta1_ovnrecon.yaml):
   ```bash
   oc apply -f config/samples/recon_v1beta1_ovnrecon.yaml
   ```

### Deployment (Cluster Mode)

To deploy the operator as a deployment in the cluster:
```bash
cd operator
make deploy IMG=quay.io/dbewley/ovn-recon-operator:latest
```

---

## Development Guide

### Repository Structure
- `api/v1beta1/`: Preferred API definitions (`ovnrecon_types.go`).
- `api/v1alpha1/`: Served compatibility API definitions.
- `internal/controller/`: Reconciliation logic (`ovnrecon_controller.go`).
- `config/`: Kustomize manifests for deployment, RBAC, and CRDs.
- `.github/workflows/`: CI/CD pipelines for building and releasing.

### Key Commands
- `make manifests`: Regenerate CRD and RBAC manifests.
- `make generate`: Regenerate Go code (DeepCopy, etc.).
- `make test`: Run unit tests.
- `make build-installer`: Generate a single `install.yaml` for distribution.

### CI/CD

The operator image is automatically built and pushed to `quay.io/dbewley/ovn-recon-operator` on tags matching `v*`, by [operator-release.yaml](.github/workflows/operator-release.yaml).

Everything the release produces is derived from the **git tag**, not from the Makefile. `VERSION` comes from `${GITHUB_REF#refs/tags/}`, and `IMG` / `BUNDLE_IMG` / `CATALOG_IMG` are passed on the `make` command line — the `VERSION ?= 0.0.1` default in `operator/Makefile` is a kubebuilder scaffold value and is never used in CI.

A tag containing a hyphen (e.g. `v1.0.1-beta.1`) is treated as a prerelease: it publishes only to the `latest` channel and does not move the floating `latest` image tags.

### Releasing the operator

Unlike the plugin (where `npm version` creates the tag), the operator is tagged by hand. Two steps
are easy to get wrong:

1. **Update the catalog first.** The file-based catalog under `operator/catalog/` is source of
   truth and is updated during release prep, not written back by CI. CI fails the release if the
   version being tagged is not already in the committed catalog. See
   [docs/tasks/fbc-migration.md](docs/tasks/fbc-migration.md).

   ```bash
   cd operator
   make bundle VERSION=<x.y.z> IMG=quay.io/dbewley/ovn-recon-operator:v<x.y.z>
   make catalog-fbc-add BUNDLE_IMG=quay.io/dbewley/ovn-recon-operator-bundle:v<x.y.z>
   git add catalog/   # only the catalog; the rest is generated
   ```

2. **Tag with `-a`.** `git push --follow-tags` pushes only *annotated* tags. A tag created with a
   bare `git tag <name>` is lightweight and is silently skipped, while any other unpushed annotated
   tags in your repo get pushed instead — re-triggering a release for an old version and
   overwriting its published images with freshly built content.

   ```bash
   git tag -a v<x.y.z> -m "v<x.y.z>" && git push --follow-tags
   ```

   Verify before pushing: `git cat-file -t v<x.y.z>` prints `tag` for annotated, `commit` for
   lightweight. `git push --dry-run --follow-tags` lists exactly which refs would go.

> [!IMPORTANT]
> The workflow triggers on `tags: ['v*']` with **no branch restriction**, and several outputs are branch-independent: the floating `:latest` image tags, the channel selection (`stable,latest`), and the hard-coded catalog tag `quay.io/dbewley/bewley-operator-catalog:v4.20`. Those outputs being branch-independent no longer matters for a maintenance branch, since the 4.22
break means there will not be one, but it still means any tag pushed from any branch publishes as if
it came from `main`.
>
> Before any maintenance branch is cut, the workflow must derive the channel, the floating tags, and the catalog content from the branch or tag pattern. Tracked in `ovn-recon-ych`.

The catalog is a [File-Based Catalog](docs/tasks/fbc-migration.md) under `operator/catalog/`, where channel membership and upgrade edges are **declared** rather than inferred. This is what makes two independent upgrade graphs expressible in one catalog, and therefore a prerequisite for the pre/post-4.22 split. The previous sqlite index (`opm index add --mode semver`) inferred edges from version ordering and would have synthesized an upgrade edge from the legacy stream to the current one.

---

## Troubleshooting

1. **Check Resource Status**:
   ```bash
   oc describe ovnrecon ovn-recon
   ```
   Look at the `Status.Conditions` section for specific error reasons.

2. **Check Events**:
   ```bash
   oc get events --field-selector involvedObject.kind=OvnRecon
   ```
   Event reason meanings and compatibility notes are documented in [docs/EVENT_REASON_CATALOG.md](docs/EVENT_REASON_CATALOG.md).

3. **Check Logs**:
   ```bash
   oc logs -n ovn-recon-operator-system deployment/ovn-recon-operator-controller-manager
   ```

---

## Known Issues

- **Transitive Dependency Conflicts**: Some `yaml.v3` and `structured-merge-diff` versions have module-path conflicts (`gopkg.in` vs `go.yaml.in`). This is managed via `exclude` directives in `go.mod` and doesn't affect runtime.
