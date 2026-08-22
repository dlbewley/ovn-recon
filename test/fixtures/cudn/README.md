# ClusterUserDefinedNetwork Fixtures

Companions to the `NodeNetworkState` fixtures in `../nns/`, holding the CUDN objects
captured from the same cluster at the same time. A file here shares its name with the NNS
fixture it belongs to.

The plugin receives these as a separate prop, so they are stored separately rather than
folded into the NNS document. A VRF interface, a localnet bridge mapping and an attachment
namespace only become meaningful when the NNS and the CUDNs are read together.

## Sanitization Rules

Same as `../nns/README.md`. In addition:

- Keep `status.conditions[].message` verbatim in shape — the plugin scrapes the namespace
  list out of the `NetworkCreated` message with a regex, so the exact bracket format is
  load-bearing. Substitute namespace names if they identify anything.
- Keep at least one CUDN attached to no namespaces (message ending `[]`), which is the
  case the regex most easily gets wrong.

## Inventory

| Fixture | Covers |
|---|---|
| `primary-cudn-vrf.json` | one Layer2 `Primary` CUDN producing a VRF; three `Localnet` CUDNs across two physical networks, two of them sharing one network and distinguished by access VLAN; one CUDN attached to no namespaces |
