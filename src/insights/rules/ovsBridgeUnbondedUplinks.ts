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
                const bonded = new Set(bonds.flatMap((bond) => bond.members.map((member) => member.name)));
                const ports: Interface[] = getBridgeUplinks(bridge.name, ctx.interfaces)
                    .filter((uplink) => !bonded.has(uplink.name));
                const uplinkNames = [...bonds.map((bond) => bond.name), ...ports.map((port) => port.name)];
                if (uplinkNames.length < 2) return [];

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
                    summary: `OVS bridge ${bridge.name} on ${node} has ${uplinkNames.length} uplinks `
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
