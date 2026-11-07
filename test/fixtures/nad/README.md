# NetworkAttachmentDefinition Fixtures

Companions to the `NodeNetworkState` fixtures in `../nns/`, holding
`NetworkAttachmentDefinition` objects captured from the same cluster at the same time.
A file here shares its name with the NNS fixture it belongs to.

## Sanitization Rules

Same as `../nns/README.md`. In addition:

- Keep the `k8s.ovn.org/network-id` annotation and the `evpn` block of `spec.config`
  exactly as captured. The network ID is what per-network EVPN device names embed
  (`svl2.9`, `ovl2.9`), and `evpn.macVRF.vid` is the VLAN id on the SVI in the NNS
  fixture; changing either alone breaks the relationship the fixture exists to show.
- Drop `kubectl.kubernetes.io/last-applied-configuration` and any label under a
  site-specific domain.

## Inventory

| Fixture | Covers |
|---|---|
| `evpn-vxlan.json` | the NAD a Layer2 `Primary` EVPN CUDN creates in its one namespace: network ID 9, network name `cluster_udn_<cudn>`, and an `evpn` config carrying the MAC-VRF VNI, route target and bridge VLAN id |
| `sriov.json` | the NAD the SR-IOV Network Operator generates from an `SriovNetwork`: the `sriovnetwork.openshift.io/owner-ref` and `k8s.v1.cni.cncf.io/resourceName` annotations, and an `sriov` CNI config carrying the VF settings (`trust`, `spoofchk`, `vlan`). Pairs with `../nns/sriov.json`, whose igb PF `enp65s0f1` carves the `vm_igb` pool |
