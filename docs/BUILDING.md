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

## Releasing

To release a new version:

1.  Run `npm version <patch|minor|major>`. This will:
    - Update the version in `package.json`.
    - Sync the version to `consolePlugin` section.
    - Run linting and tests.
    - Create a git commit and tag (e.g., `v1.0.1`).

2.  Push the changes and tags to GitHub:
    ```bash
    git push --follow-tags
    ```

3.  The CI pipeline will automatically:
    - Build the container image.
    - Push the versioned tag (e.g., `quay.io/dbewley/ovn-recon:1.0.1`).
    - If it is a stable release (no hyphen, e.g., `v1.0.0`), it will also update the `latest` tag. Prereleases (e.g., `v1.0.1-beta.1`) will **not** update `latest`.

## Deployment

To deploy the manifests to an OpenShift cluster (requires `oc` CLI and an active session):

```bash
make deploy
```
