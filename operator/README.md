# OVN Recon Operator

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
For local manifest inspection, use `make render`.

## Contributing
Contributions are welcome. Please open an issue to discuss changes.

**NOTE:** Run `make help` for more information on all potential `make` targets

More information can be found via the [Kubebuilder Documentation](https://book.kubebuilder.io/introduction.html)

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
