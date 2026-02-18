# Building and Running OVN Recon

This document describes how to set up your development environment, build the project, run tests, and create container images.

## Prerequisites

- [Node.js](https://nodejs.org/) (v14 or newer recommended)
- [npm](https://www.npmjs.com/)
- [podman](https://podman.io/) or [docker](https://www.docker.com/) for container image building

## Installation

Install project dependencies:

```bash
npm install
```

## Development

To start the development server:

```bash
npm run start
```
Or use the Makefile shortcut:
```bash
make dev
```

This will start the webpack development server.

## Building for Production

To create a production build in the `dist/` directory:

```bash
npm run build
```
Or via Makefile:
```bash
make build
```

## Testing and Linting

### Linting
To check the code for linting errors:

```bash
npm run lint
```
Or via Makefile:
```bash
make lint
```

### Testing
To run the test suite:

```bash
npm run test
```
Or via Makefile:
```bash
make test
```

## Container Image

To build the container image:

```bash
make image
```

To push the image to the registry (requires authentication):

```bash
make push
```

## Manual Deployment to OpenShift

For development and testing, you can manually deploy the plugin to an OpenShift cluster.

### Prerequisites

- An OpenShift cluster (4.10+)
- `oc` CLI tool configured and authenticated
- Podman or Docker for building images

### Environment Setup

Create a `setup_env.sh` file for convenience:

```bash
#! env bash

# OpenShift Environment Setup Script
# Usage: source setup_env.sh

export KUBECONFIG=$HOME/.kube/config  # Adjust to your kubeconfig path
export APP_NAMESPACE=ovn-recon
export APP_NAME='ovn-recon'
export APP_SELECTOR="app.kubernetes.io/name=$APP_NAME"

alias kubectl='oc'

echo "# Environment configured:"
echo "  KUBECONFIG=$KUBECONFIG"
echo "  APP_NAMESPACE=$APP_NAMESPACE"
echo "  APP_NAME=$APP_NAME"
echo "  APP_SELECTOR=$APP_SELECTOR"
```

Source the file:
```bash
source setup_env.sh
```

### Build and Push Custom Image

Since you are likely building on a Mac (ARM64) and deploying to OpenShift (AMD64), specify the target platform:

```bash
podman build --platform linux/amd64 \
    -t quay.io/$QUAY_USER/$APP_NAME:latest .
podman push quay.io/$QUAY_USER/$APP_NAME:latest
```

> [!NOTE]
> Update the image reference in `manifests/deployment.yaml` to match your repository.

### Deploy with Kustomize

Apply the manifests:

```bash
oc apply -k manifests
```

Wait for the pod to be ready:

```bash
oc wait --for=condition=ready pod -l "$APP_SELECTOR" -n "$APP_NAMESPACE" --timeout=60s
```

### Enable the Plugin

Patch the Console Operator to enable the plugin:

```bash
oc patch console.operator.openshift.io cluster --type=json \
    --patch '[{"op": "add", "path": "/spec/plugins/-", "value": "ovn-recon"}]'
```

The OpenShift console will reload automatically.

### Development Workflow

During development, rebuild and redeploy with:

```bash
source setup_env.sh && \
    make install build image push && \
    make -C collector build image push && \
    oc rollout restart deployment/$APP_NAME -n $APP_NAMESPACE && \
    oc wait --for=condition=ready pod -l "$APP_SELECTOR" -n "$APP_NAMESPACE" --timeout=60s
```

## Feature Branch Workflow

1.  Create and switch to a feature branch:
    ```bash
    git checkout -b feature/my-new-feature
    ```

2.  Make changes, commit them, and push:
    ```bash
    git add .
    git commit -m "feat: add amazing new feature"
    git push -u origin feature/my-new-feature
    ```

3.  Create a Pull Request (PR) via command line (requires [GitHub CLI](https://cli.github.com/)):
    ```bash
    gh pr create --title "feat: add amazing new feature" --body "Detailed description of changes"
    ```
    Or via the output link in the terminal.

4.  Wait for CI checks (Build, Test, Lint) to pass. Merge the PR into `main` once approved.

## Releasing

To release a new version:

1.  Switch to `main` and pull the latest changes:
    ```bash
    git checkout main
    git pull origin main
    ```

2.  Run `npm version <patch|minor|major>`. This will:
    - Update the version in `package.json`.
    - Sync the version to `consolePlugin` section.
    - Sync the version to `charts/ovn-recon/Chart.yaml` appVersion.
    - Run linting and tests.
    - Create a git commit and tag (e.g., `v1.0.1`).

3.  Push the changes and tags to GitHub:
    ```bash
    git push --follow-tags
    ```

4.  The CI pipeline will automatically:
    - Build the container image.
    - Push the versioned tag (e.g., `quay.io/dbewley/ovn-recon:1.0.1`).
    - If it is a stable release (no hyphen, e.g., `v1.0.0`), it will also update the `latest` tag. Prereleases containing a `-` (e.g., `v1.0.1-beta.1`) will **not** update `latest`.
    - **Create a GitHub Release** with automatically generated release notes. Pre-releases will be marked accordingly.
