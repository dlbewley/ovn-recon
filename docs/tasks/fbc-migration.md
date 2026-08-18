# Catalog Migration: sqlite index → File-Based Catalog (FBC)

Beads epic: `ovn-recon-4vx`. Prerequisite for `ovn-recon-ych` (pre/post-4.22 release streams).

## Why

Two reasons, one urgent and one structural.

**Urgent — the sqlite index cannot express two release streams.** The catalog was built with
`opm index add --mode semver`, and semver mode *infers* the upgrade graph from version ordering
across the whole package. Once a 4.22+ stream (`1.x`) ships alongside a maintenance stream
(`0.3.z`), opm would see `1.0.0 > 0.3.8` and synthesize an upgrade edge between them. A cluster on
OpenShift 4.21 would be offered — and by default auto-upgraded to — the build whose console plugin
cannot load on its console. There is no way to say "these are two independent upgrade graphs" in a
sqlite index.

FBC declares channel membership and `replaces` edges explicitly, so two channels can coexist in one
catalog with no edge between them.

**Structural.** `opm index add` is deprecated upstream and prints a deprecation notice on every
invocation; support will be removed in a future opm release. FBC also makes catalog content
reviewable in git rather than a side effect of whatever bundles CI happened to add to a pulled-forward
sqlite database.

## What changed

| | Before | After |
|---|---|---|
| Source of truth | sqlite DB inside the published catalog image | `operator/catalog/ovn-recon-operator/catalog.json` in git |
| Upgrade edges | inferred by `--mode semver` | declared per channel |
| Build | `opm index add --generate` → generated Dockerfile | `operator/catalog.Dockerfile` |
| Add a release | CI pulls prior catalog, appends bundle | release prep runs `make catalog-fbc-add`, commits |
| Make targets | `catalog-build*`, `catalog-index-*` | `catalog-fbc-*` (sqlite targets removed) |

The migration itself was `opm render` of the live catalog image, which converts sqlite → FBC
directly. The result was verified to be **semantically identical** to the published catalog:
same package, same two channels, same 55 bundles, same upgrade edges.

`--migrate-level bundle-object-to-csv-metadata` was applied, converting the deprecated
`olm.bundle.object` property to `olm.csv.metadata`. Supported by OLM in all OpenShift versions this
operator targets.

## Catalog contents

Preserved exactly as published: **55 bundles**, channels `stable` (18 stable releases) and `latest`
(all 55, including prereleases), default channel `stable`.

> Note: the rendered catalog is *sparse* — only the channel head carries CSV metadata, because that
> is all the sqlite index stored. This is valid FBC and `opm validate` accepts it. Bundles added from
> now on carry full metadata.

## Why not a catalog template

`opm alpha render-template basic` is the upstream-blessed workflow and was tried first. It was
rejected on evidence:

- A template renders by **pulling every bundle image it references**. Rendering the full 55-entry
  history therefore depends on every historical image remaining present and pullable.
- Prerelease bundle images carry expiry labels and are pruned by a daily cron
  (`.github/workflows/cleanup-prereleases.yaml`). Any pruned tag breaks the render.
- Older bundles are **amd64-only**. Rendering the template on an arm64 host fails on
  `v0.1.6-a1` with `no image found in image index for architecture "arm64"`. The build host's
  architecture should not determine whether the catalog can be rebuilt.

Appending to a committed catalog touches only the new bundle image, so history stays reproducible
regardless of what happens to old tags or which host runs the build.

## Release workflow

The catalog is updated during **release prep**, not written back by CI. This keeps the catalog
change reviewable in the release commit and avoids CI pushing to `main` from a tag build.

```bash
cd operator
make bundle VERSION=<x.y.z> IMG=quay.io/dbewley/ovn-recon-operator:v<x.y.z>
make catalog-fbc-add BUNDLE_IMG=quay.io/dbewley/ovn-recon-operator-bundle:v<x.y.z> CHANNELS=stable,latest
git add catalog/
```

`CHANNELS` on `catalog-fbc-add` controls catalog membership. `make bundle` derives the bundle's
own channel annotations from `VERSION` (a hyphen means prerelease → `latest` only), matching the
logic in the release workflow, so the two stay consistent without being told twice.

> [!NOTE]
> **Commit only `catalog/`.** Everything else `make bundle` touches is a generated artifact that CI
> regenerates from source during release, and several flip per release type:
> `bundle.Dockerfile` and `bundle/metadata/annotations.yaml` carry the channel labels
> (`latest` for a prerelease, `stable,latest` otherwise), and `config/manager/kustomization.yaml`
> carries whatever `IMG` you passed. Revert those rather than committing prerelease values to
> `main`. `operator/bundle/` itself is gitignored apart from `metadata/annotations.yaml`.

> [!IMPORTANT]
> **Pass `IMG`.** It defaults to `ovn-recon-operator:latest`, and `make bundle` runs
> `kustomize edit set image controller=$(IMG)`. Without it the CSV records the wrong operator
> image, `config/manager/kustomization.yaml` is rewritten as a side effect, and — because the
> catalog renders the CSV — that wrong image is baked into the catalog entry. CI sets `IMG`
> itself, so this only bites the local release-prep path.

`CHANNELS` and `DEFAULT_CHANNEL` now default to `stable,latest` and `stable` in the Makefile.
Previously they were unset, so operator-sdk fell back to `alpha` and a local `make bundle`
silently rewrote `bundle/metadata/annotations.yaml`, dropping the real channels.

`catalog-fbc-add` renders the bundle, appends it, and points its `replaces` at the current channel
head. Because the bundle image does not exist until CI builds it, the add can also render the local
bundle directory and stamp the ref it *will* be published under:

```bash
python3 hack/catalog-add-bundle.py --opm bin/opm \
  --fbc catalog/ovn-recon-operator/catalog.json \
  --bundle bundle --image quay.io/dbewley/ovn-recon-operator-bundle:v<x.y.z> \
  --channels stable,latest
```

CI then verifies the committed catalog actually contains the version being released and fails the
release early if that step was skipped.

### Guards

The add script refuses two mistakes that `opm validate` does not catch:

- **Version mismatch** — adding a local bundle directory that was never regenerated, so it still
  carries the scaffold or previous version while the image ref says otherwise.
- **Downgrade edge** — adding a bundle that sorts below the current channel head, which would ask
  OLM to treat a downgrade as an upgrade. A lower version belongs in its own channel; that is
  exactly how the two release streams will stay separate. Override with `--allow-downgrade`.

`opm validate` does catch a forked graph (`multiple channel heads found`), which is the other way
to corrupt a channel.

## Verification performed

- `opm validate catalog` passes.
- `opm render catalog` round-trips to a byte-identical graph.
- Removing the head bundle and re-adding it from its image reproduces the published edges exactly
  (`stable: v0.3.7 replaces v0.3.6`, `latest: v0.3.7 replaces v0.3.7-a4`).
- Catalog image builds via `catalog.Dockerfile`, pre-populates the serve cache at build time, and
  serves (`found existing cache contents` / `serving registry`).
- Adding a lower version into a *new* channel succeeds and validates — the two-stream pattern.

## Verifying the catalog

`make catalog-fbc-verify` answers "is the catalog sound, and would publishing it break anyone already
installed?" Run it before every release and after any hand edit to `catalog.json`.

```bash
cd operator
make catalog-fbc-verify                 # integrity + additive-diff vs the published :latest
make catalog-fbc-verify CATALOG_REF=    # integrity only, offline
make catalog-fbc-verify CATALOG_REF=quay.io/dbewley/bewley-operator-catalog:v4.20
```

It runs two independent checks and exits non-zero on either.

> [!IMPORTANT]
> **One-time local setup for the published diff.** `opm render` pulls through `containers/image`,
> which refuses to run without a signature policy file and provides **no flag and no environment
> variable** to point at one — it consults only `~/.config/containers/policy.json` and
> `/etc/containers/policy.json`. Podman on macOS keeps its policy inside the VM, so the host
> usually has none and the `--ref` diff fails with `no policy.json file found`.
>
> ```bash
> mkdir -p ~/.config/containers && \
>   printf '{"default":[{"type":"insecureAcceptAnything"}]}' > ~/.config/containers/policy.json
> ```
>
> This is the same permissive default podman and skopeo ship. The integrity check needs no network
> and no policy; run `make catalog-fbc-verify CATALOG_REF=` to skip the published diff entirely.
> CI writes the file itself before verifying.

**Integrity** (offline). Every channel has exactly one head, every entry reaches that head by its
`replaces` chain, no `replaces` points at a missing entry, and every channel entry has a matching
`olm.bundle`. A forked or broken graph strands users on a version with no upgrade path — and note
`opm validate` catches only the forked-head case, not the others.

**Regression** (needs the network). Diffs against a published catalog image and requires the change
to be purely **additive**: no bundle removed, no image ref changed on a pre-existing bundle, no edge
rewritten on a pre-existing channel entry, `defaultChannel` unchanged. This is what turns "existing
users are unaffected" into a checked fact.

Both checks are negative-tested: removing a mid-chain bundle and rewriting an edge on a pre-existing
entry each make it fail.

### Evidence from the migration

Run against the sqlite catalog still published at `:latest`, the FBC catalog diffs as:

```
channel 'latest': +2 entries ['ovn-recon-operator.v0.3.8-a0', 'ovn-recon-operator.v0.3.8-a1']
channel 'stable': +0 entries
OK
```

Nothing removed, no edges rewritten, `stable` untouched. Confirmed on a live cluster: the
packagemanifest served from the FBC catalog is identical to the one from the sqlite catalog
(same `displayName`, description length, `installModes`, owned CRDs, `alm-examples`), so the
`olm.bundle.object` → `olm.csv.metadata` conversion costs nothing in the console.

### Catching release-path defects before a tag

Most of `operator-release.yaml` is gated on `if: startsWith(github.ref, 'refs/tags/v')`, so it does
**not** run on pull requests or on merges to `main`. A green PR check means `make build` and
`make test` passed — nothing about the bundle or catalog path. Three consecutive releases failed on
defects that had shipped green for exactly this reason.

Two guards now cover it:

- **`scripts/lint-workflows.py`** runs on every PR (a job in `build-test.yaml`) and syntax-checks
  the shell inside every `run:` block. GitHub expressions are neutralised first, so `${{ ... }}`
  does not produce false positives. This catches the class of defect that shipped twice.
- **`release-dryrun.yaml`** runs the real release path — same make targets, same shell — but builds
  images with `--output type=cacheonly` instead of pushing. It triggers on PRs that touch the
  catalog, Makefile, hack scripts or the release workflow; weekly on a schedule to catch toolchain
  and base-image drift; and on demand via `workflow_dispatch`, optionally with a version to
  simulate. By default it simulates the current default-channel head so the
  "catalog contains this release" check exercises its success path.

Tracked in `ovn-recon-sye`.

### Catalog image tags

Decided in `ovn-recon-w35`. The OpenShift dimension is carried by the **OLM channel**, not the image
tag, because a Subscription names a channel and OLM will never offer a bundle outside it. Pointing a
CatalogSource at the wrong tag is a much weaker guarantee. So the tag only separates stable content
from experimental content:

| Tag | Contains | Previously |
|---|---|---|
| `:stable` | stable releases only | was `:latest` |
| `:latest` | every release, prereleases included | was `:v4.20` |
| `:v4.20` | deprecated alias of `:latest` | unchanged, retire later |

> [!WARNING]
> **`:latest` changed meaning.** It used to be stable-only and now includes prereleases. A
> Subscription on the `stable` **channel** is unaffected either way — the channel decides what is
> offered, not the image tag — but a CatalogSource that wants stable-only content should move to
> `:stable`. `manifests/catalogsource.yaml` currently points at `:latest` and is GitOps-managed.

`:v4.20` never meant anything after the FBC migration: one catalog serves every supported OpenShift
version. It is still published so existing CatalogSources keep resolving, and should be retired once
consumers have moved.

### Channels

Today: `stable` (stable releases) and `latest` (stable releases and prereleases). Unchanged from the
sqlite era and already what the catalog contains.

> [!NOTE]
> **These names do not survive the 4.22 split.** An unversioned channel cannot hold two release
> streams — OLM would offer 4.22 content to a 4.21 cluster, which is the exact failure the split
> exists to prevent. Channel naming at the split is being decided in `ovn-recon-ych`; expect
> per-generation names, with the current channels deprecated via `olm.deprecations` rather than
> deleted outright.

### Pruning dangling prereleases

Prerelease bundle images are published with a `quay.expires-at` label and are eventually removed, but
the catalog keeps referencing them by tag. `make catalog-fbc-prune-dangling` reports those entries;
`APPLY=1` removes them and splices the upgrade chain so the channel keeps exactly one head.

```bash
cd operator
make catalog-fbc-prune-dangling            # dry run
make catalog-fbc-prune-dangling APPLY=1    # remove
make catalog-fbc-verify CATALOG_REF=       # integrity only; see below
```

Two deliberate refusals:

- **Only prereleases are pruned.** A missing *stable* image is reported as an error and nothing is
  removed — silently dropping a stable release would strand anyone sitting on it.
- **Only a definite 404 counts as missing.** Any other registry response (401, 5xx, timeout) is
  treated as present, so a network hiccup can never delete catalog content.

Pruning is **not additive**, so the default `make catalog-fbc-verify` will fail against the published
catalog by design — that guard exists to catch accidental removals. Use `CATALOG_REF=` to run the
integrity check alone when the removal is intentional.

### Cutover risk

`:latest` still serves the **sqlite** catalog — prereleases only push `:v4.20`. The first stable
release publishes FBC to `:latest`, and that is the moment existing consumers switch format.
Rollback point for the sqlite image:

```
quay.io/dbewley/bewley-operator-catalog@sha256:de7c1d1746544c02055f6bdbc30b51419e2526327cd56d3abf7994bc29c77f6c
```

The catalog base image (`OPM_IMAGE`) is pinned by digest, because that image is the runtime consumers
execute in their clusters; an unpinned `:latest` could change their behavior with no corresponding
change in this repo.

## Not done yet

- **Cutover has not been published.** The next release will be the first built from FBC. Verify the
  catalog on a live cluster with a `CatalogSource` before relying on it.
- ~~The sqlite targets are still present in `operator/Makefile`.~~ **Removed** once FBC was proven
  in production (`ovn-recon-4vx.2`).
- **Prerelease entries are still carried** in the `latest` channel. Their images are pruned on a
  cron, so those references will eventually dangle. Pruning them is a behavior change for anyone
  subscribed to `latest` and is tracked separately.
- **Catalog tag taxonomy is unchanged.** The image still publishes to `:v4.20` and `:latest` so
  existing `CatalogSource` resources keep working. The `:v4.20` tag no longer implies an OpenShift
  version — one FBC catalog serves every supported release. Decided in `ovn-recon-w35` / `ovn-recon-ych`.
- ~~`catalog-push-pruned-index` / legacy package removal still uses `opm index rm`.~~ **Removed.**
  Under FBC, graph removal is a text edit to `catalog.json` plus `make catalog-fbc-verify
  CATALOG_REF=` — see [OLM-BUNDLE-GUIDE.md](../OLM-BUNDLE-GUIDE.md).
