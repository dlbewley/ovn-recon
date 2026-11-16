import { getOvsBonds } from '../../components/nodeVisualizationSelectors';
import type { Interface } from '../../types';
import { getActiveBridgeMappings, getBridgeUplinks, getLocalnetNetworks } from '../network';
import { interfacePath, nnsFact, nodeNameOf } from '../node';
import { makeFinding } from '../refs';
import type { PhysicalRule } from '../types';

/**
 * mtu-exceeds-uplink: a Localnet network declares an MTU larger than the uplink of
 * the bridge its physical network is mapped to on this node. Workloads will send
 * frames the uplink drops.
 *
 * The network's MTU is the one it declares (the CUDN's localnet.mtu, else the mtu its
 * generated NAD carries, else a standalone NAD's config.mtu). With no declared MTU the
 * rule is quiet: no default is assumed. Compared against the smallest MTU among the
 * bridge's uplinks. A node with no mapping for the physical network is not this
 * rule's business.
 *
 * A member of an OVS bond is an uplink like any other port of the bridge (it reports
 * `controller: <bridge>`), but nothing on it says bond; its evidence names the bond, so
 * a reader is not left looking for two independent uplinks (ovn-recon-1tw.4).
 */
export const mtuExceedsUplink: PhysicalRule = {
    id: 'mtu-exceeds-uplink',
    severity: 'warning',
    scope: 'node-network',
    domain: 'physical',
    title: 'Network MTU exceeds its uplink',
    evaluate: ({ node: ctx }) => {
        if (!ctx || ctx.interfaces.length === 0) return [];
        const node = nodeNameOf(ctx);
        const mappings = getActiveBridgeMappings(ctx.nns);
        const ovsBonds = getOvsBonds(ctx.interfaces);
        const uplinkFact = (bridge: string, uplink: Interface & { mtu: number }): string => {
            const bond = ovsBonds.find((b) => b.bridge === bridge && b.members.some((m) => m.name === uplink.name));
            return bond
                ? `${uplink.name} (${uplink.type}) is a member of OVS bond ${bond.name}, an uplink of ${bridge}, `
                    + `with MTU ${uplink.mtu}.`
                : `${uplink.name} (${uplink.type}) is an uplink of ${bridge} with MTU ${uplink.mtu}.`;
        };

        return getLocalnetNetworks(ctx.cudns, ctx.nads).flatMap((network) => {
            const mtu = network.mtu;
            const mapping = mappings.find((m) => m.localnet === network.physicalNetworkName);
            if (!mtu || !mapping?.bridge) return [];
            const uplinks = getBridgeUplinks(mapping.bridge, ctx.interfaces)
                .filter((uplink): uplink is Interface & { mtu: number } => typeof uplink.mtu === 'number' && uplink.mtu > 0);
            if (uplinks.length === 0) return [];
            const smallest = uplinks.reduce((min, uplink) => (uplink.mtu < min.mtu ? uplink : min));
            if (mtu.value <= smallest.mtu) return [];

            return [makeFinding({
                ruleId: mtuExceedsUplink.id,
                severity: mtuExceedsUplink.severity,
                subject: { kind: 'graph-node', node, graphNodeId: network.graphNodeId },
                scope: { node, network: network.ref },
                summary: `${network.ref.kind} ${network.ref.name} has MTU ${mtu.value}, larger than `
                    + `the ${smallest.mtu} of uplink ${smallest.name} on ${node}.`,
                evidence: [
                    { fact: `${network.ref.name} declares MTU ${mtu.value}.`, sources: [mtu.source], path: mtu.path },
                    nnsFact(ctx, `Physical network ${mapping.localnet} is mapped to bridge ${mapping.bridge}.`,
                        `status.currentState.ovn.bridge-mappings[localnet=${mapping.localnet}]`),
                    ...uplinks.map((uplink) => nnsFact(ctx, uplinkFact(mapping.bridge, uplink),
                        interfacePath(uplink.name, 'mtu')))
                ],
                remedy: {
                    text: `Lower the MTU of ${network.ref.name} to ${smallest.mtu} or less, or raise the MTU of `
                        + `${smallest.name} (and the switch ports beyond it) with a NodeNetworkConfigurationPolicy.`,
                    target: network.ref,
                    path: mtu.source === network.ref ? mtu.path : undefined
                }
            })];
        });
    }
};
