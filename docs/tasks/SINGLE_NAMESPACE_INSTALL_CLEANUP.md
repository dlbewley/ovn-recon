# Task: Clean up Manual Install Method for Single Namespace Design

## Context
The operator is being moved to a single namespace design where the operator and its operands reside in the same namespace, defaultly `ovn-recon`. The OLM bundle now prompts for this namespace. Manual installation methods (`make deploy`) should also align with this design.

## Technical Requirements
- [x] Update `config/default/kustomization.yaml` to use `ovn-recon` namespace.
- [x] Update `config/manifests/bases/ovn-recon-operator-namespace.yaml` to use `ovn-recon` name.
- [x] Update `config/manifests/bases/ovn-recon-operator-operatorgroup.yaml` to use `ovn-recon` namespace.
- [ ] Verify `make deploy` creates exactly one namespace `ovn-recon`.
- [ ] Update documentation in `README.md` to reflect the new namespace.
- [ ] Update samples in `config/samples/` if they refer to the old namespace.

## Verification Steps
1. Run `make build-installer`.
2. Inspect `dist/install.yaml` to ensure all resources are in the `ovn-recon` namespace.
3. Ensure no resources are lingering in the `ovn-recon-operator` namespace.
