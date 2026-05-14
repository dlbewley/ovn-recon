# Build the catalog image as multi-arch

The catalog image (`bewley-operator-catalog`) must be published as a multi-arch
manifest covering every node architecture it will run on. In practice that
means **at least `linux/amd64` and `linux/arm64`**, because OpenShift on Apple
Silicon (via CRC) runs an arm64 node.

## Why

A single-arch amd64 catalog image will *appear* to run on an arm64 node
(Linux happily executes amd64 binaries via user-mode emulation) but it crashes
during Go runtime init with:

```
runtime: taggedPointerPack invalid packing: ptr=0xffff... tag=0x1 ...
fatal error: taggedPointerPack
```

The container exits 2 within the same second it starts, the pod enters
`CrashLoopBackOff`, and the `CatalogSource` shows
`connectionState.lastObservedState: TRANSIENT_FAILURE`. The pull and image
size events look healthy, which makes the failure mode confusing — the panic
only appears in `oc logs <pod>` from the start of the log, not the tail.

Root cause: Go's amd64 runtime assumes canonical x86_64 user-space pointers
(top 16 bits zero). Under emulation on arm64 it gets pointers in the
`0xffff...` high half (legitimate arm64 user-space, invalid for amd64
tagging), and the first `epoll_ctl` registration during init fails its
pointer-pack sanity check.

## Build

### Option A — `docker buildx` (preferred when available)

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t quay.io/dbewley/bewley-operator-catalog:latest \
  --push .
```

### Option B — `podman` with a manifest list

```bash
TAG=quay.io/dbewley/bewley-operator-catalog:latest

podman build --platform=linux/amd64 -t ${TAG}-amd64 .
podman build --platform=linux/arm64 -t ${TAG}-arm64 .

podman manifest create  ${TAG}
podman manifest add     ${TAG} containers-storage:${TAG}-amd64
podman manifest add     ${TAG} containers-storage:${TAG}-arm64
podman manifest push --all ${TAG}
```

### `opm` base image (catalog runtime)

The **catalog image** that `opm index add` produces is built from a Dockerfile
whose **`FROM`** line uses Operator Framework’s **`quay.io/operator-framework/opm`**
image (the **catalog pod runtime**, not the `opm` CLI binary in `operator/bin`).
That **`FROM` image must be multi-arch** if you build a multi-arch catalog.
Pin a digest from a manifest list when you want reproducible builds; floating
tags can move or be single-arch on some mirrors. Use **`oc image info
--show-multiarch`** before pinning. For how this maps to Make, see
[Catalog FROM line and `OPM_INDEX_BINARY_IMAGE`](#catalog-from-line-and-opm_index_binary_image)
in the implementation plan below.

## Verify

```bash
oc image info --show-multiarch quay.io/dbewley/bewley-operator-catalog:latest
```

Expect to see both `linux/amd64` and `linux/arm64` rows. A single-arch image
prints one manifest with no platform table.

Compact alternative:

```bash
skopeo inspect --raw docker://quay.io/dbewley/bewley-operator-catalog:latest \
  | jq -r '.manifests[]? | "\(.platform.os)/\(.platform.architecture)\t\(.digest)"'
```

A single-arch image prints nothing (the `.manifests[]?` selector fails).

## After publishing

Force OLM to re-pull on the affected cluster:

```bash
oc -n openshift-marketplace delete pod -l olm.catalogSource=bewley-operators
```

The new pod should reach `Running 1/1` and the `CatalogSource` status should
move from `TRANSIENT_FAILURE` to `READY` within ~30 seconds.

---

## Implementation plan

This section satisfies the planning scope for multi-arch operator releases and
OLM catalog publishing (see bead **ovn-recon-970**). It is the agreed reference
before changing CI or Makefiles.

**Direction:** Quay tags may still be **amd64-only** until the first successful
multi-arch release push; after that, keep **manifest lists** (linux/amd64 +
linux/arm64) as the norm for operator, bundle, and catalog (see [Rolling
forward from amd64-only images](#rolling-forward-from-amd64-only-images)).

### Selected CI approach

**Primary recommendation:** **Docker Buildx** in GitHub Actions, combined with
**`opm index add --generate`** for the catalog.

1. **Catalog** — `opm index add` today calls `docker build` once on the runner
   (linux/amd64 on `ubuntu-latest`), which produces an **amd64-only** image.
   Avoid that by generating the index Dockerfile and build context, then
   building with Buildx:

   - Run the same graph inputs the Makefile uses today (`--mode semver`,
     optional `--from-index` when updating an existing catalog), but add
     **`--generate`** (and `-d` / `--out-dockerfile` if you want a fixed path).
   - Run **`docker buildx build --push --platform linux/amd64,linux/arm64`**
     against the generated Dockerfile and context directory `opm` emits.

   This matches the [Operator SDK multi-arch guidance](https://sdk.operatorframework.io/docs/advanced-topics/multi-arch/)
   pattern (manifest lists for shipped images) while staying compatible with
   Actions (no Podman requirement on the runner).

   **Fallback** if the generated Dockerfile does not build cleanly under
   multi-platform in one shot: build **per-arch** images (native **arm64**
   runner such as `ubuntu-24.04-arm` for the arm64 leg, and `ubuntu-latest` for
   amd64, or one leg with QEMU) with distinct tags, then assemble a manifest
   list with **`docker buildx imagetools create`** (conceptually the same as
   Option B in [Build](#build) above, but with Docker).

2. **Operator image** — **Publish multi-arch** for
   `quay.io/dbewley/ovn-recon-operator` (`$VERSION` and optional `:latest`).
   The repo already has **`make docker-buildx`** in `operator/Makefile` with
   `PLATFORMS` defaulting to several arches; narrow to at least
   `linux/amd64,linux/arm64` for the Quay catalog workflow unless you explicitly
   need s390x/ppc64le. Replace or supplement the release job’s plain
   **`make docker-build`** + `docker push` with a buildx push so nodes never
   pull an amd64-only manager on arm64 clusters.

3. **Bundle image** — **Publish multi-arch** for
   `quay.io/dbewley/ovn-recon-operator-bundle` as well. The bundle is
   `FROM scratch` with YAML only (no arch-specific binaries), but the **image
   manifest** must still list each platform so registry and `opm` pulls resolve
   per-node architecture like any other OLM artifact. Use the same
   **`docker buildx build --platform linux/amd64,linux/arm64 --push`** pattern
   as for other images (today `make bundle-build` is a single `docker build`).

### Rolling forward from amd64-only images

If Quay tags today resolve to **single-arch amd64** images, that is expected
before the first successful **multi-arch** release run. Going forward, treat
**manifest lists** (at least **linux/amd64** and **linux/arm64**) as the default
for operator, bundle, and catalog images so arm64 nodes (including CRC on Apple
Silicon) never pull an amd64-only OLM catalog again (see [Why](#why)).

After CI publishes new tags, confirm each image with **`docker buildx
imagetools inspect`** or **`oc image info --show-multiarch`** (see [Verify](#verify)
and the workflow “Verify release images…” step).

### Catalog FROM line and `OPM_INDEX_BINARY_IMAGE`

There are **two different “opm” notions**; pinning applies to the **second**
one:

1. **`opm` the CLI** — the binary Make downloads into `operator/bin/opm`. That
   tool **generates** the catalog Dockerfile and `database/index.db`. It is not
   the image your cluster runs as the catalog.

2. **Catalog runtime base image** — the generated Dockerfile begins with a line
   like **`FROM quay.io/operator-framework/opm:<tag>`** (Operator Framework’s
   image that ships the **on-disk `opm` / registry serve** stack). **That** is
   the filesystem your **catalog pod** actually runs. For multi-arch builds,
   that **`FROM` image must itself be a multi-arch manifest** (or each
   platform’s build will not get a matching rootfs). Floating tags can change
   or temporarily be single-arch on some mirrors.

**Best practice:** pick a **digest** of a catalog base image that **`oc image
info --show-multiarch`** (or Quay’s UI) shows as listing **linux/amd64** and
**linux/arm64**, then pin it so every release uses the same rootfs:

```bash
# Example: inspect a tag (or use a digest URL from Quay after you confirm both arches).
oc image info --show-multiarch quay.io/operator-framework/opm:v1.55.0
```

Wire the pin into catalog generation by setting **`OPM_INDEX_BINARY_IMAGE`**
when calling Make (this becomes **`opm index add --binary-image …`**, which
controls the **`FROM`** in the generated Dockerfile):

```bash
make catalog-build-multiarch CATALOG_IMG=... BUNDLE_IMGS=... \
  OPM_INDEX_BINARY_IMAGE=quay.io/operator-framework/opm@sha256:<digest>
```

In GitHub Actions, pass the same value as an **`env:`** entry or **`make`**
variable on the **`catalog-build-multiarch`** line once you have chosen a
digest. Leaving it **unset** is valid while you are validating the default tag;
set it once you want **reproducible, supply-chain–conscious** catalog builds.

**Note:** This pin is **only** the catalog runtime base. Your **operator** and
**bundle** images are separate; they are already built as multi-arch manifest
lists in the release workflow via **`docker-buildx`** / **`bundle-buildx`**.

### Which images must be multi-arch?

| Image | Multi-arch required? | Notes |
| --- | --- | --- |
| `quay.io/dbewley/bewley-operator-catalog` | **Yes** | **Minimum bar.** Must be a manifest list with **linux/amd64** and **linux/arm64** for `v4.20`, `latest`, and any other tags used by `CatalogSource` (see [Why](#why)). |
| `quay.io/dbewley/ovn-recon-operator` | **Strongly recommended** | OLM and direct installs on arm64 should pull native manager binaries; aligns with SDK multi-arch expectations for referenced operator images. |
| `quay.io/dbewley/ovn-recon-operator-bundle` | **Strongly recommended** | Keeps bundle pulls architecture-correct alongside the catalog index; low overhead with buildx. |

### Concrete files to change (implementation follow-up)

| File | Purpose |
| --- | --- |
| [`.github/workflows/operator-release.yaml`](../../.github/workflows/operator-release.yaml) | Set up **Docker Buildx**; add **`opm index add --generate`** (or scripted equivalent) + **buildx push** for catalog; add **post-push verification** (`oc image info --show-multiarch` or `skopeo inspect --raw` + `jq`); optionally use **`make docker-buildx`** and buildx for bundle; consider **matrix** or **native arm** job if single-job multi-platform catalog build is fragile. |
| [`operator/Makefile`](../../operator/Makefile) | Add targets such as **`catalog-dockerfile`** / **`catalog-build-multiarch`** wrapping `opm ... --generate` and buildx; document **`FROM_INDEX_OPT`** / per-arch **`--from-index`** if incremental index updates are done once per architecture; keep **`catalog-push`** consistent with manifest-list pushes. |
| This doc | Keep verification and rollout sections current after CI lands. |
| [`docs/BUILDING.md`](../BUILDING.md) | Optional: short “release images are multi-arch” note and local buildx prerequisites (only if maintainers want it discoverable outside this task doc). |

No change to [`operator/bundle.Dockerfile`](../../operator/bundle.Dockerfile) is
strictly required for multi-arch beyond invoking buildx with multiple platforms;
the Dockerfile content remains valid.

### Affected tags (current workflow)

From `operator-release.yaml` today:

- **Operator:** `quay.io/dbewley/ovn-recon-operator:$VERSION` and
  `quay.io/dbewley/ovn-recon-operator:latest` (stable only).
- **Bundle:** `quay.io/dbewley/ovn-recon-operator-bundle:$VERSION` and
  `:latest` (stable only).
- **Catalog:** `quay.io/dbewley/bewley-operator-catalog:v4.20` always; plus
  `quay.io/dbewley/bewley-operator-catalog:latest` for stable releases.

The plan assumes those tag names stay the same unless you intentionally
version the catalog tag per operator release (today **catalog is not**
`$VERSION`-scoped; document any future change so consumers are not surprised).

### Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Generated index Dockerfile fails or differs under **`--platform` multi** | Fall back to per-arch builds + **`buildx imagetools create`**; pin **`opm`** version in CI to match Makefile. |
| **`--from-index`** path behaves differently per arch | Prefer a single generated Dockerfile built for both platforms; if splitting jobs, ensure both legs use the **same** index input and bundle digests. |
| **Slow or flaky QEMU** arm64 builds on amd64 runners | Use a **native arm64** GitHub-hosted runner for the arm64 catalog leg. |
| **Sqlite catalog deprecation** (`opm` warns) | Track **file-based catalog (FBC)** migration separately; multi-arch plan applies to whatever image build path replaces sqlite indexes. |
| Wrong **catalog `FROM` / opm runtime** image | Pin **`OPM_INDEX_BINARY_IMAGE`** to a multi-arch digest; verify with **`oc image info --show-multiarch`** (see [Catalog FROM line](#catalog-from-line-and-opm_index_binary_image)). |

### Release validation checklist (catch single-arch before callers pull)

Run (or enforce in CI immediately after push) for **every** tag you publish that
clusters might use:

- [ ] **`oc image info --show-multiarch quay.io/dbewley/bewley-operator-catalog:v4.20`** — must list **linux/amd64** and **linux/arm64** (and the same for **`latest`** when that tag is updated).
- [ ] **`oc image info --show-multiarch`** on **`quay.io/dbewley/ovn-recon-operator:$VERSION`** (and **`bundle`** when multi-arch is implemented) for the same release.
- [ ] **`skopeo inspect --raw docker://…`** + **`jq`** check that the top-level **`mediaType`** is a manifest list when multi-arch is intended (see [Verify](#verify)).
- [ ] Optional smoke: **`CatalogSource`** reaches **READY** on an **arm64** OpenShift node (e.g. CRC on Apple Silicon) after applying the updated catalog image.

### Release prerequisite: Community Operators

**ovn-recon-970** (this plan) is a **prerequisite** for catalog installability on
mixed-arch OpenShift. **ovn-recon-bz6** (“Submit operator to Community Operators
catalog”) **depends on** implementing multi-arch catalog (and recommended
operator/bundle) publishing per this plan; see **Initial Beads Backlog Mapping**
below.

### Initial Beads Backlog Mapping

| Bead ID | Role |
| --- | --- |
| **ovn-recon-970** | Planning: multi-arch release and catalog publishing (this document). |
| **ovn-recon-bz6** | Community Operators submission; blocked on multi-arch release artifacts being published and verified as above. |

Implementation work (CI/Makefile changes) can be tracked as a **new bead**
discovered-from **ovn-recon-970** once you start coding, so planning stays closed
while engineering proceeds on a focused task.

**Status (implemented):** `.github/workflows/operator-release.yaml` publishes
`quay.io/dbewley/ovn-recon-operator`, `ovn-recon-operator-bundle`, and
`bewley-operator-catalog` as manifest lists for **linux/amd64** and
**linux/arm64** using Docker Buildx, `make docker-buildx` / `bundle-buildx` /
`catalog-build-multiarch`, and a post-push `docker buildx imagetools inspect`
check (see workflow “Verify release images…” step). **Recommended next
hardening step:** set **`OPM_INDEX_BINARY_IMAGE`** to a **multi-arch digest** for
the catalog runtime `FROM` image (see [Catalog FROM line and OPM_INDEX_BINARY_IMAGE](#catalog-from-line-and-opm_index_binary_image)).
