# Community Operators Submission Runbook

This runbook describes how to publish OVN Recon Operator bundles to the OpenShift embedded OperatorHub via `community-operators-prod`.

## Source References

- Release process and target directory layout:
  - <https://k8s-operatorhub.github.io/community-operators/operator-release-process/>
- `ci.yaml` requirements (`updateGraph`, `reviewers`) for package roots:
  - <https://k8s-operatorhub.github.io/community-operators/packaging-required-fields/>
- OpenShift catalog path:
  - Submit under `community-operators/operators/` in `community-operators-prod`.
- Contribution prerequisites (including DCO signoff):
  - <https://k8s-operatorhub.github.io/community-operators/contributing-prerequisites/>

## Multi-Version OpenShift Strategy

- Package channel strategy:
  - `stable` for current generally-available releases.
  - `latest` for pre-release/testing streams.
- Upgrade graph strategy:
  - Use `updateGraph: semver-mode` in package `ci.yaml`.
- OpenShift compatibility policy:
  - Keep compatibility broad by default.
  - Add an explicit `olm.maxOpenShiftVersion` cap only when required by deprecation/removal constraints.

## Submission Steps

1. Generate release bundle content (tag workflow or local).
2. Prepare community-operators layout from the bundle:

```bash
scripts/prepare-community-operators-submission.sh <version>
```

This stages:

- `dist/community-operators/ovn-recon-operator/<version>/manifests`
- `dist/community-operators/ovn-recon-operator/<version>/metadata`
- `dist/community-operators/ovn-recon-operator/ci.yaml`

3. Validate bundle locally before opening the upstream PR:

```bash
make -C operator bundle IMG=<registry>/ovn-recon-operator:v<version>
operator-sdk bundle validate ./operator/bundle
```

4. Create a branch in your fork of `community-operators-prod` and copy staged content into:

```text
community-operators/operators/ovn-recon-operator/
```

5. Commit with DCO signoff:

```bash
git commit -s -m "operator ovn-recon-operator (<version>)"
```

6. Open a PR to `redhat-openshift-ecosystem/community-operators-prod`.

## Release Workflow Integration

The `operator-release` workflow now emits a `community-operators` artifact for tag builds. Use that artifact as the canonical handoff payload for submission PRs.
