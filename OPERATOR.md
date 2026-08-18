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
| `consolePlugin.image.tag` | `string` | `latest` | Plugin backend image tag. |
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

Today there is a **single release stream** supporting OpenShift 4.20 and later. One operator version, one bundle, one channel (`stable`, with `latest` also published), one plugin image.

### Why this changes at 4.22

The console plugin is not self-contained. OpenShift Console supplies React, react-router, and react-i18next to dynamic plugins at runtime through webpack module federation's shared scope, and **OpenShift 4.22 changes those shared modules** — React 17 to 18, react-router 5 to 7, react-i18next 11 to 16. Only one version of each singleton module can be loaded, so a plugin compiled against React 18 cannot run on a 4.21 console, and vice versa.

This is a property of the plugin bundle only. The operator's Go reconcile logic, the `OvnRecon` CRD, and the collector are all unaffected — they have no console coupling. **A single operator build continues to work across both generations; only the plugin image it deploys must differ.**

### Planned stream split

> [!NOTE]
> Planned, not yet implemented. Tracked in beads `ovn-recon-ych` (release streams), `ovn-recon-t14` (plugin migration), and `ovn-recon-4vx` (catalog migration).

| | Legacy stream | Current stream |
|---|---|---|
| OpenShift | 4.20 – 4.21 | 4.22+ |
| Git branch | `release-4.21` (frozen) | `main` |
| Operator version | `0.3.z` | `1.x` |
| OLM channel | `stable-4.21` | `stable-4.22` |
| Plugin build | React 17 / router 5 | React 18 / router 7 |
| Maintenance | Security and P0 bugs only | Active development |

The `release-4.21` branch is a **freeze, not a parallel development line**. Features land on `main`; only critical fixes are cherry-picked back. Because operator and collector changes are stream-independent, they ship from `main` and serve both generations.

Three independent guardrails prevent a mismatched install, each covering a different failure path:

| Guardrail | Where | Prevents |
|---|---|---|
| `com.redhat.openshift.versions` | bundle `annotations.yaml` | The bundle appearing in the wrong per-OCP catalog |
| `olm.maxOpenShiftVersion` | last pre-4.22 CSV | A **cluster** upgrade to 4.22 while an incompatible operator is installed |
| `@console/pluginAPI` range | plugin `package.json` | The console loading a plugin it cannot satisfy — the plugin is skipped rather than crashing the page |

Selection between streams is **static**: each stream's bundle references its own plugin image tag, and OLM channel membership decides which bundle a cluster can install. The operator does not detect the cluster's OpenShift version. This keeps the compatibility decision declarative and reviewable rather than embedded in reconcile logic, at the cost of the user choosing the correct channel. Runtime version detection remains a possible future improvement — see the design notes on `ovn-recon-ych` for the tradeoff.

> [!WARNING]
> `consolePlugin.image.tag` defaults to `latest`. Once two streams exist, a floating `latest` tag will resolve to whichever stream published most recently and can deliver an incompatible plugin to your cluster. **Pin `consolePlugin.image.tag` (and `collector.image.tag`) to an explicit version** rather than relying on the default. The default is expected to change to a stream-specific tag as part of the split.

---

## Operational Guide

### Prerequisites
- OpenShift 4.20 or compatible. See [OpenShift Version Compatibility](#openshift-version-compatibility) — support becomes stream-specific at OpenShift 4.22.
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

> [!IMPORTANT]
> The workflow triggers on `tags: ['v*']` with **no branch restriction**, and several outputs are branch-independent: the floating `:latest` image tags, the channel selection (`stable,latest`), and the hard-coded catalog tag `quay.io/dbewley/bewley-operator-catalog:v4.20`. A release tag pushed from a future `release-4.21` branch would therefore overwrite `main`'s floating tags and publish into the same `stable` channel and the same catalog.
>
> Before any maintenance branch is cut, the workflow must derive the channel, the floating tags, and the catalog content from the branch or tag pattern. Tracked in `ovn-recon-ych`.

The catalog is currently built with `opm index add --mode semver`, which **infers upgrade edges from version ordering across the whole package**. That is safe with one stream and unsafe with two — it would synthesize an upgrade edge from the legacy stream to the current one. Migrating to a File-Based Catalog, where channel membership and upgrade edges are declared explicitly, is a prerequisite for the split (`ovn-recon-4vx`).

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
