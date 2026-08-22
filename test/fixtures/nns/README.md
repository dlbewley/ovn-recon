# NodeNetworkState Fixtures

These fixtures are sanitized snapshots used by unit tests in `src/components/*.test.ts`.

## Sanitization Rules

- Remove cluster-identifying values (real hostnames, domains, IPs tied to environments).
- Keep structural shape and key variations that parser logic depends on.
- Preserve edge-case key styles when relevant (for example `mac-address` and `mac_address`).
- Keep fixture scope minimal to the behavior under test.

## Naming Convention

- Use lowercase, kebab-case filenames.
- Name fixtures by scenario, not by environment.
- Examples: `basic-host.json`, `vrf-mixed-routes.json`, `partial-missing-fields.json`.

## Minimum Fields

Each fixture should include:

- `apiVersion`
- `kind`
- `metadata.name`
- `status.currentState.interfaces`

Optional sections such as routes and bridge mappings should be included only when needed by tests.

## Maintenance

- Add or update fixtures when parser/model behavior changes.
- Keep fixture diffs small and focused.
- Add or update tests in the same change that modifies fixture semantics.

## Inventory

| Fixture | Captured from | Covers |
|---|---|---|
| `basic-host.json` | synthetic | minimal single-NIC node: one bridge, one localnet mapping |
| `host-lldp.json` | synthetic | LLDP neighbour TLVs and the LLDP toggle |
| `vrf-mixed-routes.json` | synthetic | VRF route matching across route key spellings |
| `partial-missing-fields.json` | synthetic | absent optional sections; parsers must not throw |
| `primary-cudn-vrf.json` | real CNV worker | ovs-interface shadowing a same-named ovs-bridge and holding the node IP; linux VLAN interface; VRF created by a Primary (Layer2) CUDN with its own route table; two OVS bridges with two localnet mappings; patch/veth/geneve/loopback tail |

`primary-cudn-vrf.json` has a companion in `test/fixtures/cudn/` holding the
`ClusterUserDefinedNetwork` objects from the same cluster, since the VRF, the localnet
mappings and the attachment namespaces only make sense together.

Prefer extending a real capture over inventing a synthetic one. Synthetic fixtures only
prove the parsers handle shapes we already thought of — the real capture is what surfaced
the `prefix-length` / `prefix_length` split and the bridge-shadowing case.
