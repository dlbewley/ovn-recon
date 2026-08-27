# NodeNetworkConfigurationEnactment fixtures

`primary-cudn-vrf.json` is SYNTHETIC, but mirrors the exact shape verified on
cluster hub.lab.bewley.net (recorded on bead ovn-recon-s3t.34, 2026-08-22):
`nnce/cnv-1.br-vmdata` claiming an ovs-bridge, an ovs-interface and a bridge
mapping, and `nnce/cnv-1.storage-vlan` claiming a kernel VLAN interface. Names
are aligned to the `nns/primary-cudn-vrf.json` capture (node `worker-1`), whose
interfaces br-vmdata, ovs-vlan-1920, ens224.456 and mapping physnet-vmdata are
exactly the resources these enactments claim. Everything unclaimed in that NNS
(br-ex, ens192, the VRF, patch ports, geneve) is the installer/OVN-K set.

Cases still wanted (tracked on ovn-recon-s3t.23): a real capture, two NNCEs
claiming one interface, and an NNCE in Failing or Progressing state — the last
two are synthesized inline in tests, since they are contraindicated or
transient on a healthy cluster.
