# `cluster-localnet-coverage` fixtures

Three companion files, captured together on 2026-11-10 from a ten-node OpenShift 4.22
cluster with read-only `oc get` and trimmed with `jq`:

| File | Holds |
|---|---|
| `nns/cluster-localnet-coverage.json` | every node's NodeNetworkState as a `kind: List`, trimmed to the OVS bridges, their uplinks (name, type, state, MTU, controller) and the bridge mappings |
| `../cudn/cluster-localnet-coverage.json` | the six Localnet ClusterUserDefinedNetworks: spec and status conditions only |
| `../nad/cluster-localnet-coverage.json` | the Localnet NADs those CUDNs generated, with their owner references and `spec.config` verbatim |

What it covers (ovn-recon-7i6.2, `localnet-unmapped`):

- `physnet` is mapped on all ten nodes (`machinenet` rides it);
- `physnet-vmdata` is mapped on the four workers only (`vlan-1924`, `vlan-1926`): partial
  coverage, which is deliberately not a finding;
- `thirdmap` (`vlan-333`) and `secondmap` (`vlan-333-again`, `vlan-999`) are mapped on no
  node, while every one of those CUDNs reports `NetworkCreated=True`. That is the
  mapped-nowhere case the rule exists for, as it stood on the cluster.
- the CUDN-generated NADs, one per selected namespace, must not repeat the CUDN's finding.

Sanitization: node names are renamed by role (`worker-N`, `control-N`, `storage-N`);
annotations (GitOps tracking ids, last-applied configuration), uids, timestamps and
resource versions are dropped. Interface, bridge, physical network, CUDN and namespace
names are kept as captured; they identify nothing outside the cluster.

When the inventory tables in `README.md` here and in `../cudn/` and `../nad/` are next
edited, add a row pointing at this note.
