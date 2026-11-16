# OVN Recon: OVS bonds in the physical view (plan)

Epic: `ovn-recon-1tw`

## Summary

A NodeNetworkConfigurationPolicy can aggregate NICs inside an OVS bridge instead of with a
kernel bond. nmstate reports such a bond only as an entry in the bridge's `bridge.port`
list, never as an interface of its own, so the physical view draws its members as
independent uplinks of the bridge. This plan models the OVS bond: a node between its
members and its bridge, named in the drawers, and covered by the findings.

## What is wrong today

The policy:

```yaml
- name: br-vmdata
  type: ovs-bridge
  bridge:
    options: { stp: { enabled: false } }
    port:
      - name: ovs-br1
      - name: bond1
        link-aggregation:
          mode: balance-slb
          port: [{ name: ens161 }, { name: ens256 }]
```

What NodeNetworkState reports for it:

- `br-vmdata` (`ovs-bridge`) carries the same `bridge.port` list, `bond1` and its
  `link-aggregation` included.
- `ens161` and `ens256` (`ethernet`) each report `controller: br-vmdata`. Nothing on
  them says bond.
- There is no interface named `bond1`. In OVS it is a row in the Port table with two
  Interface rows, and it has no kernel netdev.
- `ovs-br1` (`ovs-interface`, `controller: br-vmdata`) is the bridge's internal port,
  under a name of its own.

What OVN Recon draws from it:

| Where | Today | Why it matters |
|---|---|---|
| Graph | `ens161 -> br-vmdata` and `ens256 -> br-vmdata`, two independent edges | Two unbonded uplinks on a bridge with STP off is the picture of a switching loop, the opposite of what is configured |
| Bridge drawer | Uplink: ens161, ens256. Other Ports: ovs-br1, bond1 | The aggregation is a bare name with no mode or members; the internal port shows no address |
| Member drawer | Nothing about a bond | `permanentMacFacts` and `describeBond` know only kernel bonds |
| Findings | `bond-degraded` filters on `type: bond` | A member of an OVS bond going down raises nothing |

## The design

**Draw the bond as a node.** It is not synthetic: the bond is observed in the bridge's
own report, only nested rather than listed as an interface. The view already draws br-int
from its ports' `controller` fields, with less to go on than this. The bond gets a cue
that it is an OVS port and has no kernel device, so it is not read as a Linux bond.

```
ens161 ─┐
        ├─ bond1 (ovs-bond · balance-slb) ── br-vmdata ┄┄ physnet-vmdata
ens256 ─┘
```

- **Model.** One selector, `getOvsBonds`, reads every `ovs-bridge`'s `bridge.port`
  entries that carry `link-aggregation`, and `GraphContext` holds the result once. The
  edges, drawers and findings all read it.
- **Node.** Kind `ovs-bond`, in the Bonds lane, with the bond icon and the subtitle
  `ovs-bond · <mode>`. Its id is `ovs-bond:<bridge>:<name>`, so it cannot collide with a
  kernel bond of the same name.
- **Edges.** member -> bond, and bond -> bridge, both membership and observed. When a
  member belongs to an OVS bond, its own `controller` edge to the bridge is not drawn;
  the member edge's rationale cites both facts. The flow-path walk needs no change.
- **Drawers.**
  - The bond: its mode with a gloss, its members and their state, up and down delays,
    its bridge, and the policy that configured it. A hint says that `ip link` does not
    show it and that `ovs-appctl bond/show` holds its runtime state.
  - The bridge: the bond is its uplink.
  - Each member: names its bond.
  - `balance-slb` is glossed as source-MAC and VLAN hashing with no LACP. It needs no
    switch-side LAG, and the switch ports must not be a port-channel.
- **Findings.** `bond-degraded` covers OVS bonds. A new warning fires for the hazard
  the old graph implied: several unbonded uplinks on an OVS bridge with STP and RSTP off.
- **Later.** NNS has no runtime bond state (the active member, per-member enable, hash
  buckets). The collector could read it with `ovs-appctl bond/show`, collector-gated.

## Order

1. `1tw.1` comes first; everything except `1tw.6` depends on it.
2. `1tw.3` (drawers) is the safe first visible change and can ship before the graph.
3. `1tw.2` (node and edges) removes the misleading picture. `1tw.4` can land alongside it.
4. `1tw.5`, `1tw.6` and `1tw.7` follow. `1tw.6` is independent and can go any time.

## Initial Beads Backlog Mapping

| Bead | Type | P | Title | Depends on |
|---|---|---|---|---|
| `ovn-recon-1tw` | epic | 2 | OVS bonds: draw link aggregation that lives inside an OVS bridge | |
| `ovn-recon-1tw.1` | task | 2 | Read OVS bonds out of bridge.port link-aggregation into GraphContext, with a fixture | |
| `ovn-recon-1tw.2` | feature | 2 | Draw an OVS bond as an ovs-bond node in the Bonds lane, between its members and its bridge | `1tw.1` |
| `ovn-recon-1tw.3` | feature | 2 | Name the OVS bond in the bridge and member drawers, and gloss OVS bond modes | `1tw.1` |
| `ovn-recon-1tw.4` | bug | 2 | bond-degraded ignores OVS bonds; uplink findings should name the bond | `1tw.1` |
| `ovn-recon-1tw.5` | feature | 3 | Finding: an OVS bridge with several unbonded physical uplinks and STP/RSTP off | `1tw.1` |
| `ovn-recon-1tw.6` | bug | 3 | Bridge drawer: an ovs-interface port not named after its bridge is its internal port | |
| `ovn-recon-1tw.7` | feature | 3 | Collector: OVS bond runtime state from ovs-appctl bond/show | `1tw.2` |

## Open questions

- The bond's visual cue: a dashed border, or the bridges' purple accent on the bond
  colour. Settle it against the `ovn-recon-nt4` palette in `1tw.2`.
- `1tw.7`: extend the snapshot contract, or add a small bond endpoint to the collector.
