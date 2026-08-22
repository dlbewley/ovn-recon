# Testing with temporary image tags

How to get an unreleased build onto a cluster without cutting a release and without
pushing `:latest`.

## Why not just push `:latest`

`:latest` is mutable and shared. Overwriting it means:

- Anyone else pointed at `:latest` silently picks up your work-in-progress.
- `imagePullPolicy: Always` plus an unchanged tag makes "did my change deploy?"
  genuinely hard to answer — the tag looks identical before and after.
- There is nothing to roll back *to*. The previous `:latest` is gone.
- A pod restart hours later quietly pulls something different from what you tested.

Use `:latest` for solo inner-loop work on a cluster nobody else touches. For anything
shared or remote, use a unique tag.

## Naming a temporary tag

Derive it from the branch's bead ID and the short commit, so the tag says what it is and
stays unique:

```bash
source setup_env.sh
export TEST_TAG="s3t11-$(git rev-parse --short HEAD)"   # e.g. s3t11-873f7dd
```

Bead-plus-commit beats a bare commit: it survives a rebase readably, and it tells the next
person which work the tag belongs to. Never reuse a temporary tag for different content —
that reintroduces exactly the mutability problem above.

## Plugin and collector: build, push, point the CR at them

Both are ordinary operands, and the `OvnRecon` CR can override each independently.

```bash
source setup_env.sh
export TEST_TAG="s3t11-$(git rev-parse --short HEAD)"

# Plugin (repo root)
make build push IMAGE_TAG="$TEST_TAG"

# Collector
make -C collector build push IMAGE_TAG="$TEST_TAG"
```

Then point the CR at them. `consolePlugin.image` and `collector.image` each take
`repository`, `tag` and `pullPolicy`:

```bash
oc patch ovnrecon ovn-recon -n "$APP_NAMESPACE" --type=merge -p "{
  \"spec\": {
    \"consolePlugin\": {\"image\": {\"tag\": \"$TEST_TAG\", \"pullPolicy\": \"Always\"}},
    \"collector\":     {\"image\": {\"tag\": \"$TEST_TAG\", \"pullPolicy\": \"Always\"}}
  }
}"
```

Leave `repository` unset unless you are testing from a different registry; it defaults to
`quay.io/dbewley/ovn-recon` and `quay.io/dbewley/ovn-collector`.

> [!IMPORTANT]
> **If the CR is managed by Argo CD, this patch will be reverted in about a second.**
> On `hub.lab.bewley.net` the `OvnRecon` CR carries
> `argocd.argoproj.io/tracking-id=hub-cfg-ovn-recon` and self-heals almost immediately.
>
> Either suspend auto-sync for the duration of the test:
>
> ```bash
> oc patch application hub-cfg-ovn-recon -n openshift-gitops --type=merge \
>   -p '{"spec":{"syncPolicy":{"automated":null}}}'
> ```
>
> …or make the change at the Argo source repo instead and let it sync normally. Remember to
> restore the sync policy afterwards — see Cleanup.
>
> Query Argo apps as `applications.argoproj.io`; the bare `application` short name resolves
> to `app.k8s.io` on this cluster.

## Operator: use the release path, not a temporary tag

The operator is not an operand — nothing in the `OvnRecon` CR points at it. It is deployed by
OLM from the CSV in the bundle, and the CSV is rendered into the file-based catalog. Patching
the operator Deployment's image directly works but is undone the moment OLM reconciles the CSV.

For operator changes, cut a prerelease instead (see
[BUILDING.md § Releasing](BUILDING.md#releasing)). A prerelease tag containing a hyphen goes to
the `latest` channel only and does not move `:latest` or the `stable` channel, which makes it
the right tool for cluster testing.

That path also delivers the plugin and collector, because the CSV's `relatedImages` pins both:
the operator resolves them from `RELATED_IMAGE_PLUGIN` / `RELATED_IMAGE_COLLECTOR` when the CR
does not override them. If you cut a prerelease, you usually do **not** need the CR patch above
at all — and you avoid the Argo CD problem entirely.

## Verifying what actually deployed

Check the running containers rather than the CR, since the CR records intent and OLM or Argo may
have overridden it:

```bash
oc get pods -n "$APP_NAMESPACE" \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[*].image}{"\n"}{end}'
```

Resolve a tag to the digest you actually pulled, which is the only unambiguous answer:

```bash
oc get pods -n "$APP_NAMESPACE" \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[*].imageID}{"\n"}{end}'
```

For the console plugin specifically, a browser cache will happily serve the previous bundle. Do a
hard reload, and confirm the plugin version the console reports:

```bash
oc get consoleplugin ovn-recon -o jsonpath='{.spec.backend.service}{"\n"}'
```

If a rollout seems stuck, restart it explicitly:

```bash
oc rollout restart deployment/$APP_NAME -n "$APP_NAMESPACE"
oc rollout status  deployment/$APP_NAME -n "$APP_NAMESPACE" --timeout=120s
```

## Cleanup

Temporary tags are cheap but not free — they accumulate in Quay and make the tag list hard to
read. When the test is done:

```bash
# Drop the CR overrides so the operator's RELATED_IMAGE_* defaults apply again
oc patch ovnrecon ovn-recon -n "$APP_NAMESPACE" --type=json -p '[
  {"op": "remove", "path": "/spec/consolePlugin/image/tag"},
  {"op": "remove", "path": "/spec/collector/image/tag"}
]'

# Restore Argo CD auto-sync if you suspended it
oc patch application hub-cfg-ovn-recon -n openshift-gitops --type=merge \
  -p '{"spec":{"syncPolicy":{"automated":{"prune":true,"selfHeal":true}}}}'
```

Then delete the temporary tags in Quay. Prerelease *releases* are pruned by the scheduled
`cleanup-prereleases` workflow; ad hoc test tags are not, so they are yours to remove.

## Choosing between the two paths

| | Temporary tag | Prerelease |
|---|---|---|
| Plugin or collector only | ✅ fastest | works, slower |
| Operator changes | ❌ OLM reverts it | ✅ the only path |
| CR is Argo-managed | needs sync suspended | ✅ no CR edit needed |
| Someone else needs to reproduce it | tag may be gone | ✅ immutable, in the catalog |
| Inner loop, solo cluster | ✅ | overkill |
