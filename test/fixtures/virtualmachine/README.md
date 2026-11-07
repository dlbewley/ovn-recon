# VirtualMachine Fixtures

Companions to the `NodeNetworkState` fixtures in `../nns/`, holding `kubevirt.io/v1`
`VirtualMachine` objects captured from the same cluster. A file here shares its name with
the NNS fixture it belongs to.

Nothing reads these yet. They are kept for ovn-recon-s3t.65: a VM with an `sriov: {}`
interface holds one of the VFs that has left the host, and its `macAddress` is the MAC the
PF reports for that VF in the NNS fixture, which is how the holder of an absent VF can be
named.

## Sanitization Rules

Same as `../nns/README.md`. In addition:

- Replace the cloud-init `userData` with a stub: the capture carried a password.
- Drop firmware `serial` and `uuid`, `managedFields`, `resourceVersion`, finalizers and
  the top-level annotations (template validations and a kubemacpool timestamp).
- Keep the interface `macAddress` values exactly: `02:1e:ad:27:70:ac` is VF 0 of
  `enp65s0f1` in `../nns/sriov.json`, on the `vm-igb` network of `../nad/sriov.json`.

## Inventory

| Fixture | Covers |
|---|---|
| `sriov.json` | a running VM with a pod-network interface and one `sriov` interface on Multus network `vm-igb`, whose MAC is VF 0 of `enp65s0f1` |
