import { getOvsBonds } from '../../components/nodeVisualizationSelectors';
import type { GraphContext } from '../../topology/context';
import { ifaceNodeId } from '../../topology/ids';
import type { Interface } from '../../types';
import { operatorNetworkRef } from '../cno';
import { getActiveBridgeMappings, getBridgeUplinks, getLocalnetNetworks } from '../network';
import { interfacePath, nnsFact, nodeNameOf } from '../node';
import { makeFinding } from '../refs';
import type { Finding, PhysicalRule } from '../types';

/** The physical network OVN-Kubernetes maps to its gateway bridge. */
const GATEWAY_PHYSICAL_NETWORK = 'physnet';
const GATEWAY_BRIDGE = 'br-ex';

type SizedUplink = Interface & { mtu: number };

const sizedUplinks = (bridge: string, interfaces: Interface[]): SizedUplink[] =>
    getBridgeUplinks(bridge, interfaces)
        .filter((uplink): uplink is SizedUplink => typeof uplink.mtu === 'number' && uplink.mtu > 0);

const smallestOf = (uplinks: SizedUplink[]): SizedUplink =>
    uplinks.reduce((min, uplink) => (uplink.mtu < min.mtu ? uplink : min));

/**
 * The cluster network (ovn-recon-n7r.3): pod traffic between nodes leaves through the
 * gateway bridge encapsulated, so its uplinks must carry the cluster network MTU the
 * Cluster Network Operator reports plus the encapsulation overhead. Read from
 * ctx.clusterMtu, never guessed: quiet without it.
 */
const clusterNetworkFinding = (ctx: GraphContext, uplinkFact: (bridge: string, uplink: SizedUplink) => string): Finding[] => {
    const clusterMtu = ctx.clusterMtu;
    if (!clusterMtu) return [];
    const node = nodeNameOf(ctx);
    const mapping = getActiveBridgeMappings(ctx.nns).find((m) => m.localnet === GATEWAY_PHYSICAL_NETWORK && m.bridge);
    const bridge = mapping?.bridge
        ?? (ctx.interfaces.some((iface) => iface.name === GATEWAY_BRIDGE) ? GATEWAY_BRIDGE : undefined);
    if (!bridge) return [];
    const uplinks = sizedUplinks(bridge, ctx.interfaces);
    if (uplinks.length === 0) return [];
    const smallest = smallestOf(uplinks);
    const needed = clusterMtu.value + clusterMtu.overhead;
    if (needed <= smallest.mtu) return [];

    return [makeFinding({
        ruleId: mtuExceedsUplink.id,
        severity: mtuExceedsUplink.severity,
        subject: { kind: 'graph-node', node, graphNodeId: ifaceNodeId(smallest.name) },
        scope: { node, network: operatorNetworkRef },
        summary: `The cluster network MTU ${clusterMtu.value} needs ${needed} on the uplinks of ${bridge}, larger than `
            + `the ${smallest.mtu} of uplink ${smallest.name} on ${node}.`,
        evidence: [
            { fact: `The cluster network MTU is ${clusterMtu.value}.`, sources: [clusterMtu.source], path: clusterMtu.path },
            {
                fact: `Pod traffic between nodes carries ${clusterMtu.overhead} bytes of encapsulation: ${clusterMtu.overheadBasis}`,
                sources: [operatorNetworkRef],
                path: 'spec.defaultNetwork.ovnKubernetesConfig'
            },
            mapping
                ? nnsFact(ctx, `Physical network ${GATEWAY_PHYSICAL_NETWORK} is mapped to bridge ${bridge}.`,
                    `status.currentState.ovn.bridge-mappings[localnet=${GATEWAY_PHYSICAL_NETWORK}]`)
                : {
                    ...nnsFact(ctx, `${bridge} is the gateway bridge.`, interfacePath(bridge, 'name')),
                    inferred: `No ${GATEWAY_PHYSICAL_NETWORK} bridge mapping is reported; ${GATEWAY_BRIDGE} is the bridge OVN-Kubernetes uses by default.`
                },
            ...uplinks.map((uplink) => nnsFact(ctx, uplinkFact(bridge, uplink), interfacePath(uplink.name, 'mtu')))
        ],
        remedy: {
            text: `Raise the MTU of ${smallest.name} (and the switch ports beyond it) to at least ${needed}, or lower the `
                + 'cluster network MTU with the documented MTU migration.',
            target: operatorNetworkRef,
            verb: 'view'
        }
    }, 'cluster-network')];
};

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
 *
 * The cluster network gets the same check (ovn-recon-n7r.3): the gateway bridge's
 * uplinks (the `physnet` mapping, else br-ex) must carry the cluster network MTU the
 * Cluster Network Operator reports plus the encapsulation (Geneve 100 bytes, IPsec 46
 * more), read from ctx.clusterMtu. Quiet when the caller passes none, and during an
 * MTU migration (clusterMtuOf).
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
        const uplinkFact = (bridge: string, uplink: SizedUplink): string => {
            const bond = ovsBonds.find((b) => b.bridge === bridge && b.members.some((m) => m.name === uplink.name));
            return bond
                ? `${uplink.name} (${uplink.type}) is a member of OVS bond ${bond.name}, an uplink of ${bridge}, `
                    + `with MTU ${uplink.mtu}.`
                : `${uplink.name} (${uplink.type}) is an uplink of ${bridge} with MTU ${uplink.mtu}.`;
        };

        const localnet = getLocalnetNetworks(ctx.cudns, ctx.nads).flatMap((network) => {
            const mtu = network.mtu;
            const mapping = mappings.find((m) => m.localnet === network.physicalNetworkName);
            if (!mtu || !mapping?.bridge) return [];
            const uplinks = sizedUplinks(mapping.bridge, ctx.interfaces);
            if (uplinks.length === 0) return [];
            const smallest = smallestOf(uplinks);
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
        return [...localnet, ...clusterNetworkFinding(ctx, uplinkFact)];
    }
};
