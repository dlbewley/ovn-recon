# OVN Recon Operator

The OVN Recon Operator manages the lifecycle of the [OVN Recon](https://github.com/dlbewley/ovn-recon) console plugin on OpenShift. It provides a declarative way to deploy, configure, and automatically enable the plugin within the OpenShift Web Console.

See also [OLM-BUNDLE-GUIDE.md](../docs/OLM-BUNDLE-GUIDE.md).

## Features

- **Automated Deployment**: Manages the plugin backend (Deployment and Service).
- **Console Integration**: Automatically creates `ConsolePlugin` resources and patches the OpenShift Console operator to enable the plugin.
- **Security Hardened**: Runs as non-root with minimal capabilities and mandatory seccomp profiles.
- **Observability**: Uses standard Kubernetes Status Conditions and Events for clear state reporting.
- **Cleanup Safety**: Uses finalizers to ensure all cluster-scoped resources and operator patches are removed when the custom resource is deleted.
- **Multi-instancing Protected**: Logic ensures only the primary (oldest) instance manages cluster-wide configurations like the Console operator.

---

## API Reference (`OvnRecon` CRD)

The operator reacts to the `OvnRecon` custom resource (Group: `recon.bewley.net`, Version: `v1alpha1`, Scope: `Cluster`).

### Spec Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `targetNamespace` | `string` | `ovn-recon` | The namespace where namespaced resources (Deployment, Service) are created. |
| `image.repository`| `string` | `quay.io/dbewley/ovn-recon` | The container image repository. |
| `image.tag` | `string` | `latest` | The container image tag. |
| `image.pullPolicy`| `string` | `IfNotPresent` | Kubernetes ImagePullPolicy. |
| `consolePlugin.displayName` | `string` | `OVN Recon` | The name displayed in the OpenShift console. |
| `consolePlugin.enabled` | `bool` | `true` | If true, the operator will patch the OpenShift Console configuration to enable the plugin. |

### Status Conditions

| Condition Type | Description |
|----------------|-------------|
| `Available` | `True` if the backend Deployment is ready. |
| `PluginEnabled`| `True` if the plugin is successfully enabled in the OpenShift Console operator state. |
| `NamespaceReady`| `True` if the `targetNamespace` exists and is accessible. |
| `ServiceReady` | `True` if the backend Service is reconciled. |
| `ConsolePluginReady` | `True` if the `ConsolePlugin` resource is reconciled. |

---

## Operational Guide

### Prerequisites
- OpenShift 4.20 or compatible.
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

3. **Deploy Sample** [recon_v1alpha1_ovnrecon.yaml](config/samples/recon_v1alpha1_ovnrecon.yaml):
   ```bash
   kubectl apply -f config/samples/recon_v1alpha1_ovnrecon.yaml
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
- `api/v1alpha1/`: API definitions (`ovnrecon_types.go`).
- `internal/controller/`: Reconciliation logic (`ovnrecon_controller.go`).
- `config/`: Kustomize manifests for deployment, RBAC, and CRDs.
- `.github/workflows/`: CI/CD pipelines for building and releasing.

### Key Commands
- `make manifests`: Regenerate CRD and RBAC manifests.
- `make generate`: Regenerate Go code (DeepCopy, etc.).
- `make test`: Run unit tests.
- `make build-installer`: Generate a single `install.yaml` for distribution.

### CI/CD
The operator image is automatically built and pushed to `quay.io/dbewley/ovn-recon-operator` on tags matching `v*`.

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

3. **Check Logs**:
   ```bash
   oc logs -n ovn-recon-operator-system deployment/ovn-recon-operator-controller-manager
   ```

---

## Known Issues

- **Transitive Dependency Conflicts**: Some `yaml.v3` and `structured-merge-diff` versions have module-path conflicts (`gopkg.in` vs `go.yaml.in`). This is managed via `exclude` directives in `go.mod` and doesn't affect runtime.
