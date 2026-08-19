# Building and Running OVN Recon

This document describes how to set up your development environment, build the project, run tests, and create container images.

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or newer
- [npm](https://www.npmjs.com/)
- [podman](https://podman.io/) or [docker](https://www.docker.com/) for container image building

> [!NOTE]
> The plugin build is tied to the OpenShift Console version it targets — the console supplies React, react-router, and react-i18next at runtime, so the plugin must be compiled against matching versions. See [Release Streams and OpenShift Compatibility](#release-streams-and-openshift-compatibility) before releasing.

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

- An OpenShift cluster (4.20+)
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

## Release Streams and OpenShift Compatibility

### Why the plugin cannot be version-agnostic

OpenShift Console loads dynamic plugins via webpack module federation and supplies the shared singleton modules itself — React, react-router, react-i18next, and PatternFly. The plugin must **not** bundle its own copies; it compiles against whatever versions the target console provides. When the console upgrades one of those modules across a major version, every plugin must upgrade with it.

OpenShift 4.22 does exactly that: React 17 → 18, react-router 5 → 7, react-i18next 11 → 16, PatternFly 6 only.

The incompatibility runs **one way only**. An older plugin generally keeps working on a newer console: the SDK never sets `strictVersion`, and SDK versions before the 4.x line declared no `peerDependencies`, so those builds shared React with no version expectation and took whatever the console provided. The `v0.3.7` build (React 17) was observed running cleanly on a 4.22.8 console.

A **newer** plugin on an **older** console is what actually breaks — partly by our own declaration (`@console/pluginAPI: >=4.22.0-0` makes an older console decline to load it) and partly for real (`import { Link } from 'react-router'` resolves to v5 on 4.21, which exports `Link` from `react-router-dom` instead).

### The 4.22 break

**Decision: a clean break, not a maintenance branch.** From the 4.22 migration onward, builds target
OpenShift 4.22+ and are deliberately incompatible with 4.21 and earlier. There is no `release-4.21`
branch and no parallel stream to backport into.

The reasoning: an older plugin keeps working on a newer console only for as long as the APIs it
touches survive, and `react-router-dom` and `react-router-dom-v5-compat` are already deprecated.
Straddling both generations means freezing on an SDK that is falling further behind, in exchange for
compatibility that expires on someone else's schedule.

What this means in practice:

| | |
|---|---|
| `main` | OpenShift 4.22+ only |
| Last pre-4.22 release | `v0.3.7`, stays published and installable, receives nothing further |
| Backports | none |
| Guardrail | `@console/pluginAPI: >=4.22.0-0` — a 4.21 console declines to load the plugin rather than breaking the page |

Because the guardrail is a *load-time* check, a 4.21 cluster that upgrades to a 4.22-targeted release
gets a running operator with an absent plugin: degraded and visible, not a broken console. That is
the intended failure mode.

The remaining work is making sure a 4.21 cluster is never *offered* the newer release in the first
place — an OLM channel boundary, tracked in `ovn-recon-ych`.

See [OPERATOR.md](../OPERATOR.md#openshift-version-compatibility) for the OLM-side guardrails.

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

> [!WARNING]
> **`--follow-tags` only pushes _annotated_ tags.** `npm version` creates one, so the plugin flow
> above is safe. A tag made by hand with `git tag <name>` is **lightweight** and will be silently
> skipped — `git push --follow-tags` reports success while pushing no tag at all, and will happily
> push any *other* annotated tags sitting unpushed in your local repo instead. That can re-trigger
> a release for an old version and overwrite already-published images with freshly built content.
>
> Tag by hand with `-a`, or push the tag by name:
>
> ```bash
> git tag -a v1.0.1 -m "v1.0.1" && git push --follow-tags
> # or
> git push origin v1.0.1
> ```
>
> Check what you are about to publish first — `git cat-file -t <tag>` prints `tag` for annotated
> and `commit` for lightweight, and `git push --dry-run --follow-tags` lists exactly which refs
> would go.
