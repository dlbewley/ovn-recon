# OVN Recon Operator

See also [operator readme](../operator/README.md).

## Description
The OVN Recon Operator installs and manages the OVN Recon OpenShift Console Plugin
and its backing service. It reconciles an `OvnRecon` custom resource into the
Deployment, Service, and ConsolePlugin resources needed by the plugin.

## Getting Started

### Prerequisites
- Go 1.23+
- Docker or Podman
- kubectl 1.31+
- Access to a Kubernetes 1.31+ cluster (OpenShift 4.20 recommended)
- `KUBECONFIG` set to your cluster config

### Environment Setup
Set `KUBECONFIG` before running make commands:

Source the setup script from the project root:

```sh
source ../setup_env.sh
```

### Deploy to a Cluster
Build and push your image to the location specified by `IMG`:

```sh
make docker-build docker-push IMG=<some-registry>/operator:tag
```

**NOTE:** This image ought to be published in the personal registry you specified.
And it is required to have access to pull the image from the working environment.
Make sure you have the proper permission to the registry if the above commands don’t work.

Install the CRDs into the cluster:

```sh
# Ensure KUBECONFIG is set
export KUBECONFIG=/Users/dale/.kube/ocp/hub/kubeconfig
make install
```

Deploy the manager to the cluster with the image specified by `IMG`:

```sh
# Ensure KUBECONFIG is set
export KUBECONFIG=/Users/dale/.kube/ocp/hub/kubeconfig
make deploy IMG=<some-registry>/operator:tag
```

> **NOTE**: If you encounter RBAC errors, you may need to grant yourself cluster-admin
privileges or be logged in as admin.

Create an `OvnRecon` instance (example from `config/samples`):

```sh
kubectl apply -k config/samples/
```

Note: ensure the sample values are valid for your cluster.

### Uninstall
Delete the instances (CRs) from the cluster:

```sh
kubectl delete -k config/samples/
```

Delete the APIs (CRDs) from the cluster:

```sh
make uninstall
```

Undeploy the controller from the cluster:

```sh
make undeploy
```

## Distribution
For OLM bundle and catalog publishing, see `docs/OLM-BUNDLE-GUIDE.md`.
For Community Operators submission packaging, see `docs/COMMUNITY_OPERATORS_SUBMISSION.md`.
For local manifest inspection, use `make render`.

## Contributing
Contributions are welcome. Please open an issue to discuss changes.

**NOTE:** Run `make help` for more information on all potential `make` targets

More information can be found via the [Kubebuilder Documentation](https://book.kubebuilder.io/introduction.html)

## Code Structure

### Controller (`internal/controller/ovnrecon_controller.go`)

The main controller implements the reconciliation logic for `OvnRecon` custom resources.

**Key Functions**:
- `Reconcile()` - Main reconciliation loop with finalizer handling and primary instance detection
- `reconcileDeployment()` - Creates/updates Deployment using desired resource spec
- `reconcileService()` - Creates/updates Service using desired resource spec
- `reconcileConsolePlugin()` - Creates/updates ConsolePlugin with correct API structure
- `reconcileConsoleOperator()` - Enables plugin in Console operator configuration
- `handleDeletion()` - Handles cleanup on CR deletion (removes finalizer, deletes resources)
- `removePluginFromConsole()` - Removes plugin from Console operator during deletion
- `checkDeploymentReady()` - Checks Deployment readiness status
- `updateCondition()` - Updates status conditions on the CR
- `isPrimaryInstance()` - Determines if this instance is the primary (oldest) instance
- `ensureTargetNamespaceExists()` - Validates that the target namespace exists
- `deleteNamespacedResources()` - Deletes Deployment and Service during cleanup
- `SetupWithManager()` - Configures the controller with the manager

**Helper Functions**:
- `labelsForOvnRecon()` - Generates standard Kubernetes labels for resources
- `labelsForOvnReconWithVersion()` - Generates labels including version information
- `targetNamespace()` - Determines target namespace from spec or default
- `imageTagFor()` - Determines image tag from spec or default
- `operatorVersionAnnotations()` - Generates operator version annotations

### Desired Resources (`internal/controller/desired_resources.go`)

This file contains functions that generate the desired state specifications for Kubernetes resources.

**Key Functions**:
- `DesiredDeployment()` - Generates Deployment spec with security contexts, resource limits, health probes, and volume mounts
- `DesiredService()` - Generates Service spec with TLS certificate annotations for OpenShift
- `DesiredConsolePlugin()` - Generates ConsolePlugin unstructured resource with backend service configuration
- `mergeStringMap()` - Helper function for merging string maps (used for labels and annotations)

## Known Issues

### YAML Dependency Conflict
There's a known dependency conflict between `go.yaml.in/yaml/v3` and `gopkg.in/yaml.v3` in `k8s.io/kube-openapi`. This is a transitive dependency that doesn't affect runtime but may cause build warnings.

**Current Status**: Mitigated by excluding problematic versions (v3.0.3, v3.0.4) in `go.mod`. The build completes successfully with no warnings.

**Workarounds** (if issue resurfaces):
1. Exclude kube-openapi if not needed
2. Use replace directive (may cause other issues)
3. Wait for upstream fix

**Impact**: Low - doesn't affect runtime, only potential build warnings

## License

Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
