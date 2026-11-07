# SriovNetworkNodeState Fixtures

Companions to the `NodeNetworkState` fixtures in `../nns/`, holding the
`sriovnetwork.openshift.io/v1` `SriovNetworkNodeState` the SR-IOV Network Operator keeps
for the same node, captured at the same time. A file here shares its name with the NNS
fixture it belongs to.

The resource answers what NodeNetworkState cannot: `spec.interfaces[].vfGroups[]` carves
each PF's VFs into pools, one per device-plugin resource, and `status.interfaces[].Vfs[]`
names the driver each VF is bound to (`vfio-pci` for a VF passed through to a VM or DPDK,
the NIC's VF driver for a host netdevice).

## Sanitization Rules

Same as `../nns/README.md`. In addition:

- Rewrite the node name and the PF MACs exactly as the NNS fixture did, in lower case
  as this resource reports them, so `status.interfaces[].mac` still equals the NNS PF's
  `mac-address`.
- Leave VF MACs, PCI addresses, vendor and device IDs alone: the VF MACs are what tie
  a VF on the host to its NNS entry, and the PCI addresses are what a holder's
  `network-status` annotation would name.
- Drop `managedFields`, `resourceVersion` and the operator-config owner's uid.

## Inventory

| Fixture | Covers |
|---|---|
| `sriov.json` | three PFs each split into a `vfio-pci` pool for VMs and a `netdevice` pool for pods (`vm_igb` VFs 0-3 / `pod_igb` VFs 4-6 on `enp65s0f1`; `vm_pf0`/`pod_pf0` and `vm_pf1`/`pod_pf1` on the two Mellanox PFs), and a fourth PF (`enp65s0f0`) with no groups and no VFs. Pairs with `../nns/sriov.json`, `../nad/sriov.json` and `../virtualmachine/sriov.json` |
