import { getActiveBridgeMappings, getLocalnetNetworks } from '../network';
import { makeFinding, nnsRef } from '../refs';
import type { Evidence, PhysicalRule } from '../types';

const MAPPINGS_PATH = 'status.currentState.ovn.bridge-mappings';

/**
 * localnet-unmapped: a Localnet network names a physical network that no node maps to
 * a bridge. OVN-Kubernetes still accepts the network (NetworkCreated=True), but its
 * traffic has nowhere to leave the host on any node.
 *
 * Fires once per network object, never once per node. A physical network mapped on
 * only SOME nodes is deliberately not a finding (see README.md): that is often how a
 * cluster confines a network to the nodes that carry it.
 */
export const localnetUnmapped: PhysicalRule = {
    id: 'localnet-unmapped',
    severity: 'warning',
    scope: 'network',
    domain: 'physical',
    title: 'Localnet network mapped on no node',
    evaluate: ({ cluster }) => {
        const states = cluster.nodeNetworkStates;
        if (!states || states.length === 0) return [];

        const nodesByPhysicalNetwork = new Map<string, string[]>();
        states.forEach((nns) => getActiveBridgeMappings(nns).forEach((mapping) => {
            const nodes = nodesByPhysicalNetwork.get(mapping.localnet) ?? [];
            nodes.push(nns.metadata?.name || '');
            nodesByPhysicalNetwork.set(mapping.localnet, nodes);
        }));
        const allNodes = states.map((nns) => nnsRef(nns));
        const mappedNames = Array.from(nodesByPhysicalNetwork.keys()).sort();

        return getLocalnetNetworks(cluster.cudns, cluster.nads)
            .filter((network) => !nodesByPhysicalNetwork.has(network.physicalNetworkName))
            .map((network) => {
                const physnet = network.physicalNetworkName;
                const evidence: Evidence[] = [
                    {
                        fact: `${network.ref.kind} ${network.ref.name} names physical network ${physnet}.`,
                        sources: [network.ref],
                        path: network.physicalNetworkPath,
                        inferred: network.physicalNetworkInferred
                    },
                    {
                        fact: `No bridge mapping names ${physnet} on any of the ${states.length} nodes' NodeNetworkState.`,
                        sources: allNodes,
                        path: MAPPINGS_PATH
                    }
                ];
                if (mappedNames.length > 0) {
                    evidence.push({
                        fact: `Physical networks that are mapped: ${mappedNames.map((name) =>
                            `${name} (${nodesByPhysicalNetwork.get(name)?.length} of ${states.length} nodes)`).join(', ')}.`,
                        sources: allNodes,
                        path: MAPPINGS_PATH
                    });
                }
                const remedyAlternatives = mappedNames.length > 0 ? ` (mapped: ${mappedNames.join(', ')})` : '';
                return makeFinding({
                    ruleId: localnetUnmapped.id,
                    severity: localnetUnmapped.severity,
                    subject: { kind: 'k8s', ref: network.ref },
                    scope: { network: network.ref },
                    summary: `${network.ref.kind} ${network.ref.name} names physical network ${physnet}, `
                        + 'which no node maps to a bridge.',
                    evidence,
                    remedy: {
                        text: `Point ${network.ref.name} at a physical network that is mapped${remedyAlternatives}, `
                            + `or map ${physnet} to a bridge with a NodeNetworkConfigurationPolicy on the nodes that should carry it.`,
                        target: network.ref,
                        path: network.physicalNetworkInferred ? undefined : network.physicalNetworkPath
                    }
                });
            });
    }
};
