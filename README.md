# OpenShift Console Plugin Walkthrough

![Built with AI](https://img.shields.io/badge/Built%20with-AI-blueviolet?style=for-the-badge)
[![Image Repository on Quay](https://quay.io/repository/dbewley/ovn-recon/status "Image Repository on Quay")](https://quay.io/repository/dbewley/ovn-recon)
[![CI Status](https://github.com/dlbewley/ovn-recon/actions/workflows/build-test.yaml/badge.svg)](https://github.com/dlbewley/ovn-recon/actions/workflows/build-test.yaml)

**Examples**

![nns visualization 1](img/nns-visualization.png)
![nns visualization 2](img/nns-visualization-2.png)
![nns visualization 3](img/nns-visualization-3.png)

## Repository

The source code for this project is available at: [https://github.com/dlbewley/ovn-recon](https://github.com/dlbewley/ovn-recon)

OpenShift Console Plugin for OVN Rcon.

## Project Structure

- `package.json`: Defines the plugin metadata and dependencies.
- `console-extensions.json`: Defines the extension points (new route and navigation item).
- `webpack.config.ts`: Webpack configuration for building the plugin.
- `tsconfig.json`: TypeScript configuration.
- `src/components/ExamplePage.tsx`: The React component for the new page.
- `Dockerfile`: For building the plugin image.
- `nginx.conf`: Nginx configuration for serving the plugin assets.

## Architecture & Concepts

### Technology Stack

OpenShift Console plugins are built using standard web technologies:

-   **React**: The core library for building the user interface.
-   **TypeScript**: Used for type safety and better developer experience.
-   **PatternFly**: The design system used by OpenShift. It provides a set of React components that ensure your plugin looks and feels like a native part of the console.
-   **Webpack**: Bundles the plugin code. It uses **Module Federation** to expose the plugin's modules (components) so they can be dynamically loaded by the OpenShift Console at runtime.

### How It Works

1.  **Dynamic Loading**: The OpenShift Console is a host application that can dynamically load plugins. It fetches the plugin's manifest (`plugin-manifest.json`) to understand what extensions the plugin provides.
2.  **Extensions**: Plugins define "extensions" in `console-extensions.json`. These extensions tell the console where to integrate the plugin's features (e.g., adding a new route, a navigation item, a dashboard widget, or a cluster overview item).
3.  **Communication**: The plugin runs in its own pod (usually serving static assets via Nginx) but executes within the browser context of the main console application.

### Data Gathering

Plugins interact with the underlying Kubernetes/OpenShift cluster using the **OpenShift Console Dynamic Plugin SDK**. This SDK provides hooks and utilities to:

-   **Watch Resources**: Use hooks like `useK8sWatchResource` to subscribe to real-time updates of Kubernetes resources (Pods, Nodes, Custom Resources, etc.).
-   **API Calls**: Make direct API calls to the Kubernetes API server using `k8sGet`, `k8sCreate`, `k8sPatch`, etc.
-   **Proxying**: The console acts as a proxy for API requests, handling authentication (OAuth) automatically. The plugin doesn't need to manage user tokens directly; it simply makes requests through the SDK, and the console handles the rest.

## How to Build

For detailed build instructions, please see [docs/BUILDING.md](docs/BUILDING.md).

Alternatively, you can use the `make` command:

```bash
make install
make build
```

The build artifacts will be in the `dist` directory.

## How to Deploy

0.  **Set up environment variables:**

    Example `setup_env.sh`:

    ```bash
    #! env bash

    # OpenShift Environment Setup Script
    # Usage: source setup_env.sh

    # Set the KUBECONFIG environment variable to the user's preferred path
    export KUBECONFIG=$HOME/.kube/ocp/hub/kubeconfig
    export APP_NAMESPACE=ovn-recon
    export APP_NAME='ovn-recon'
    export APP_SELECTOR="app.kubernetes.io/name=$APP_NAME"

    # Alias kubectl to oc for convenience and consistency
    alias kubectl='oc'
    # Replace eza alias if exists
    alias ls >/dev/null && unalias ls

    echo "# Environment configured:"
    echo "  KUBECONFIG=$KUBECONFIG"
    echo "  APP_NAMESPACE=$APP_NAMESPACE"
    echo "  APP_NAME=$APP_NAME"
    echo "  APP_SELECTOR=$APP_SELECTOR"
    echo "# Aliases configured:"
    echo "  'kubectl' aliased to 'oc'"
    echo "  'ls' unaliased"
    ```

    ```bash
    source setup_env.sh
    ```

1.  **Build the container image:**

    Since you are likely building on a Mac (ARM64) and deploying to an OpenShift cluster (likely AMD64), you need to specify the target platform:

    ```bash
    export APP_NAME='ovn-recon'
    podman build --platform linux/amd64 -t quay.io/$QUAY_USER/$APP_NAME:latest .
    ```

2.  **Push the image:**

    ```bash
    podman push quay.io/$QUAY_USER/$APP_NAME:latest
    ```

    > [!NOTE]
    > Make sure to update the image reference in `manifests/deployment.yaml` to match your repository.

3.  **Deploy to OpenShift:**

    Apply the manifests using Kustomize:

    ```bash
    oc apply -k manifests
    ```

4.  **Enable the Plugin:**

    Patch the Console Operator config to enable the plugin. Use a JSON patch to append to the list of plugins instead of replacing it:

    ```bash
    oc patch console.operator.openshift.io cluster --type=json \
        --patch '[{"op": "add", "path": "/spec/plugins/-", "value": "ovn-recon"}]'
    ```

    The OpenShift console will reload to apply the changes. You should see a notification that the console has been updated.

### Development Deployment

During development, you can deploy changes to the cluster using the following command:

```bash
source setup_env.sh && \
    make build push && \
    oc rollout restart deployment/$APP_NAME -n "$APP_NAMESPACE" && \
    oc wait --for=condition=ready pod -l "$APP_SELECTOR" -n "$APP_NAMESPACE" --timeout=60s
```


### Helm Deployment

Deploy using Helm from the OCI registry:

```bash
helm install ovn-recon oci://quay.io/dbewley/charts/ovn-recon \
  --version 0.1.0 \
  --namespace ovn-recon \
  --create-namespace
```

Or from the local chart:

```bash
helm install ovn-recon ./charts/ovn-recon \
  --namespace ovn-recon \
  --create-namespace
```

To customize the deployment, create a `values.yaml` file:

```yaml
image:
  repository: quay.io/dbewley/ovn-recon
  tag: "0.0.1"

consolePlugin:
  displayName: "OVN Recon"
```

Then install with your custom values:

```bash
helm install ovn-recon ./charts/ovn-recon \
  --namespace ovn-recon \
  --create-namespace \
  --values values.yaml
```

To upgrade an existing deployment:

```bash
helm upgrade ovn-recon ./charts/ovn-recon \
  --namespace ovn-recon
```

## Troubleshooting

For troubleshooting steps, please see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## References

-   [OpenShift Console Dynamic Plugin SDK](https://github.com/openshift/console/tree/master/frontend/packages/console-dynamic-plugin-sdk)
-   [Dynamic Plugin SDK README](https://www.npmjs.com/package/@openshift-console/dynamic-plugin-sdk)
-   [PatternFly React Documentation](https://www.patternfly.org/v4/components)
-   [OpenShift Console GitHub Repository](https://github.com/openshift/console)
- [Example ocp-console-plugin](https://github.com/dlbewley/ocp-console-plugin)
