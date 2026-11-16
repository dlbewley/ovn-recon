import { interfaceNodeId } from '../../topology/ids';
import type { BridgeOptions, Interface } from '../../types';
import { getBridgeUplinks } from '../network';
import { interfacePath, interfaceRemedy, nnsFact, nodeNameOf } from '../node';
import { makeFinding } from '../refs';
import type { Evidence, PhysicalRule } from '../types';

/** OVN-Kubernetes' integration bridge: OVN programs it, and it has no NIC of its own. */
const INTEGRATION_BRIDGE = 'br-int';

/**
 * Whether a bridge's spanning tree is stated off: `true` when STP is reported disabled
 * and RSTP is not reported enabled, `undefined` when nmstate does not say. STP comes
 * as `{ enabled }` in current nmstate and as a bare boolean in older captures (see
 * BridgeOptions). An absent `rstp` is read as off, which is OVS's default and what
 * older nmstate, reporting no `rstp` at all, ran with; the evidence marks it inferred.
 */
const spanningTreeOff = (options: BridgeOptions | undefined): boolean | undefined => {
    if (!options) return undefined;
    const stp = typeof options.stp === 'object' && options.stp !== null ? options.stp.enabled : options.stp;
    if (typeof stp !== 'boolean') return undefined;
    return !stp && options.rstp !== true;
};

/**
 * The device an uplink's frames leave the node on (ovn-recon-vb1): a VLAN's base
 * interface, followed down through stacked VLANs; any other uplink is its own. Two
 * VLANs of one NIC share that NIC's link, so bridging them joins two VLANs rather than
 * looping one: the switch floods a broadcast sent up on VLAN 10 on VLAN 10 only, and
 * it never returns on VLAN 20. A base the node does not report ends the walk there,
 * and a cycle (a malformed capture) stops at the first repeat.
 */
const lowerDevice = (uplink: Interface, byName: Map<string, Interface>): string => {
    const seen = new Set<string>();
    let current = uplink;
    while (!seen.has(current.name)) {
        seen.add(current.name);
        const base = current.vlan?.['base-iface'];
        if (!base) return current.name;
        const next = byName.get(base);
        if (!next) return base;
        current = next;
    }
    return current.name;
};

/** One way off the node: the uplinks that leave on one device, or one OVS bond. */
interface UplinkPath {
    /** The device or OVS bond the path leaves on, named in the summary. */
    label: string;
    /** The bridge's uplink ports on this path; empty for an OVS bond. */
    ports: Interface[];
}

/**
 * ovs-bridge-unbonded-uplinks (ovn-recon-1tw.5): an OVS bridge has two or more uplinks
 * that no OVS bond aggregates, with STP and RSTP both off. A broadcast entering on one
 * uplink is flooded out of the other, and the upstream switch sends it back: a loop
 * through the host, unless the switch side blocks it. This is the hazard the physical
 * view wrongly drew for an OVS bond before ovn-recon-1tw modelled one
 * (docs/tasks/OVS_BOND_PLAN.md).
 *
 * Uplinks are the bridge's ports of an uplink type (getBridgeUplinks). Members of an
 * OVS bond on the bridge count together as the bond, one uplink: OVS forwards a
 * broadcast out of one member of a bond only. A kernel bond is already one interface.
 *
 * Uplinks are counted by the link they leave on (ovn-recon-vb1): VLANs of one NIC, or
 * of one bond, are one path, and a VLAN of an OVS bond's member is that bond's path.
 * Two VLANs of one NIC join two VLANs into one bridge domain; they do not loop one.
 *
 * An uplink that is down still counts. It loops nothing now, but the configuration is
 * what is wrong, and the loop starts the moment its link comes up; the evidence gives
 * each uplink's state so a reader can see which.
 *
 * Quiet when the bridge does not report its options, or reports no STP setting:
 * unknown is not off. Linux bridges are out of scope (the bead is about OVS bonds,
 * and a Linux bridge's STP options differ); br-int is OVN's and has no uplinks.
 */
export const ovsBridgeUnbondedUplinks: PhysicalRule = {
    id: 'ovs-bridge-unbonded-uplinks',
    severity: 'warning',
    scope: 'node',
    domain: 'physical',
    title: 'OVS bridge has unbonded uplinks with STP off',
    evaluate: ({ node: ctx }) => {
        if (!ctx || ctx.interfaces.length === 0) return [];
        const node = nodeNameOf(ctx);

        return ctx.interfaces
            .filter((iface) => iface.type === 'ovs-bridge' && iface.name !== INTEGRATION_BRIDGE)
            .flatMap((bridge) => {
                const options = bridge.bridge?.options;
                if (!spanningTreeOff(options)) return [];

                const bonds = ctx.ovsBonds.filter((bond) => bond.bridge === bridge.name);
                const bondOfMember = new Map(bonds.flatMap((bond) =>
                    bond.members.map((member) => [member.name, bond.name] as const)));
                const byName = new Map(ctx.interfaces
                    .filter((iface) => iface.type !== 'ovs-bridge')
                    .map((iface) => [iface.name, iface]));
                const ports: Interface[] = getBridgeUplinks(bridge.name, ctx.interfaces)
                    .filter((uplink) => !bondOfMember.has(uplink.name));
                // One path per OVS bond, then one per device the remaining ports leave
                // on; a port whose device is a bond member joins that bond's path.
                const paths = new Map<string, UplinkPath>(
                    bonds.map((bond) => [`ovs-bond:${bond.name}`, { label: bond.name, ports: [] }]));
                ports.forEach((port) => {
                    const device = lowerDevice(port, byName);
                    const bond = bondOfMember.get(device);
                    const key = bond ? `ovs-bond:${bond}` : `device:${device}`;
                    const path = paths.get(key) ?? { label: device, ports: [] };
                    path.ports.push(port);
                    paths.set(key, path);
                });
                if (paths.size < 2) return [];
                const uplinkNames = [...paths.values()].map((path) =>
                    (path.ports.length === 1 && path.ports[0].name === path.label) || path.ports.length === 0
                        ? path.label
                        : `${path.label} (${path.ports.map((port) => port.name).join(', ')})`);
                const sharedPaths = [...paths.values()].filter((path) =>
                    path.ports.length > 1 || (path.ports.length === 1 && path.ports[0].name !== path.label));

                const evidence: Evidence[] = [
                    ...bonds.map((bond) => nnsFact(ctx,
                        `${bond.name} is an OVS bond on ${bridge.name}`
                            + `${bond.mode ? ` (${bond.mode})` : ''} aggregating `
                            + `${bond.members.map((member) => member.name).join(', ') || 'no reported members'}; `
                            + 'it counts as one uplink.',
                        interfacePath(bridge.name, `bridge.port[name=${bond.name}].link-aggregation`))),
                    ...ports.map((port) => nnsFact(ctx,
                        `${port.name} (${port.type}, ${port.state || 'state unknown'}) is an uplink of ${bridge.name} `
                            + 'in no OVS bond.',
                        interfacePath(port.name, 'controller'))),
                    ...sharedPaths.map((path) => nnsFact(ctx,
                        `${path.ports.map((port) => port.name).join(', ')} `
                            + `${path.ports.length > 1 ? 'leave' : 'leaves'} the node on ${path.label}, `
                            + 'counted as one uplink: VLANs of one link join VLANs, they do not loop one.',
                        interfacePath(path.ports[0].name, 'vlan.base-iface'))),
                    {
                        ...nnsFact(ctx, `${bridge.name} has STP and RSTP off.`,
                            interfacePath(bridge.name, 'bridge.options')),
                        ...(options?.rstp === undefined ? {
                            inferred: 'The bridge reports no rstp option; OVS leaves RSTP off unless it is enabled.'
                        } : {})
                    }
                ];
                const list = uplinkNames.join(', ');

                return [makeFinding({
                    ruleId: ovsBridgeUnbondedUplinks.id,
                    severity: ovsBridgeUnbondedUplinks.severity,
                    subject: { kind: 'graph-node', node, graphNodeId: interfaceNodeId(bridge, ctx) },
                    scope: { node },
                    summary: `OVS bridge ${bridge.name} on ${node} has ${paths.size} uplinks `
                        + `not aggregated in one bond (${list}) with STP and RSTP off.`,
                    evidence,
                    remedy: interfaceRemedy(
                        ctx,
                        bridge.name,
                        (policy) => `In NodeNetworkConfigurationPolicy ${policy}, aggregate ${list} in one OVS bond `
                            + `(a bridge.port entry of ${bridge.name} with link-aggregation), keep only one of them `
                            + `on the bridge, or enable RSTP (bridge.options.rstp: true).`,
                        `Aggregate ${list} in one OVS bond on ${bridge.name} (a bridge.port entry with `
                            + 'link-aggregation in a NodeNetworkConfigurationPolicy), keep only one of them on the '
                            + 'bridge, or enable RSTP (bridge.options.rstp: true).'
                    )
                })];
            });
    }
};
