# VTEP Fixtures

Companions to the `NodeNetworkState` fixtures in `../nns/`, holding the cluster-scoped
`k8s.ovn.org/v1` `VTEP` objects captured from the same cluster at the same time. A file
here shares its name with the NNS fixture it belongs to.

OVN-Kubernetes names the kernel devices it creates for a VTEP after the VTEP itself:
`evbr`, `evx4` or `evx6`, then `-<name>` when that fits in a 15-character interface
name, else `.` and the first 8 hex digits of `sha256(<name>)`.

## Sanitization Rules

Same as `../nns/README.md`. In addition:

- **The VTEP name is load-bearing and must not be changed on its own.** The device
  names in the NNS fixture embed a hash of it (`evx4.4a75265e` is
  `sha256("demo-evpn-vteps")[:8]`), so renaming the VTEP means renaming those devices to
  match the new hash, in every place they appear.
- Rewrite `spec.cidrs` into the same documentation range the NNS fixture uses for the
  node's addresses, so the VTEP address `vxlan.local` names still falls inside it.

The Node annotation that pairs with these, `k8s.ovn.org/vteps`, is a one-line JSON
string and is written inline in the tests that need it rather than stored here.

## Inventory

| Fixture | Covers |
|---|---|
| `evpn-vxlan.json` | one `Unmanaged` VTEP, `Accepted`, whose name is too long for the readable device-name form and so appears on the node only as a hash |
