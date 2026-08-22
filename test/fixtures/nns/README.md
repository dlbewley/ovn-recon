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
| `bonded-lldp.json` | real bonded UCS worker | three 802.3ad bonds — one into `br-ex`, one into a second OVS bridge, one standalone carrying its own address; LLDP neighbours on six NICs across two leaf switches; **27 localnet mappings on a single bridge**; a half-configured localnet patch port that is down and unattached; two unused NICs in `down` state |

`primary-cudn-vrf.json` has a companion in `test/fixtures/cudn/` holding the
`ClusterUserDefinedNetwork` objects from the same cluster, since the VRF, the localnet
mappings and the attachment namespaces only make sense together.

Prefer extending a real capture over inventing a synthetic one. Synthetic fixtures only
prove the parsers handle shapes we already thought of — the real captures are what surfaced
the `prefix-length` / `prefix_length` split, the bridge-shadowing case, and the fact that one
bridge routinely carries dozens of localnet mappings.

Anonymisation must preserve relationships, not just replace strings. In `bonded-lldp.json` the
802.3ad members share their bond's MAC while `permanent-mac-address` keeps the burned-in one, and
`ovn-k8s-mp0`'s MAC encodes its own IP address (`0A:58:AC:16:18:02` ⇄ `172.22.24.2`) — rewriting
either half alone would produce a fixture that looks real and is not. Localnet renames must be
applied to the dotted form in patch port names as well as the dashed form in the mappings.
