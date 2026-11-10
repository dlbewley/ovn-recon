import { bridgeMappingNodeId } from '../../topology/ids';
import { getActiveBridgeMappings } from '../network';
import { bridgeMappingRemedy, nnsFact, nodeNameOf } from '../node';
import { makeFinding } from '../refs';
import type { PhysicalRule } from '../types';

/**
 * mapping-bridge-missing: a bridge mapping on this node names an OVS bridge that the
 * node's NodeNetworkState does not report. Every network on that physical network has
 * no way off this node.
 */
export const mappingBridgeMissing: PhysicalRule = {
    id: 'mapping-bridge-missing',
    severity: 'warning',
    scope: 'node',
    domain: 'physical',
    title: 'Bridge mapping names a missing bridge',
    evaluate: ({ node: ctx }) => {
        if (!ctx || ctx.interfaces.length === 0) return [];
        const node = nodeNameOf(ctx);
        const ovsBridges = new Set(ctx.interfaces
            .filter((iface) => iface.type === 'ovs-bridge')
            .map((iface) => iface.name));

        return getActiveBridgeMappings(ctx.nns)
            .filter((mapping) => mapping.bridge && !ovsBridges.has(mapping.bridge))
            .map((mapping) => makeFinding({
                ruleId: mappingBridgeMissing.id,
                severity: mappingBridgeMissing.severity,
                subject: { kind: 'graph-node', node, graphNodeId: bridgeMappingNodeId(mapping.localnet) },
                scope: { node },
                summary: `Bridge mapping ${mapping.localnet} on ${node} names OVS bridge ${mapping.bridge}, `
                    + 'which the node does not report.',
                evidence: [
                    nnsFact(ctx, `Physical network ${mapping.localnet} is mapped to bridge ${mapping.bridge}.`,
                        `status.currentState.ovn.bridge-mappings[localnet=${mapping.localnet}]`),
                    nnsFact(ctx, `No ovs-bridge interface named ${mapping.bridge} is reported.`,
                        'status.currentState.interfaces')
                ],
                remedy: bridgeMappingRemedy(
                    ctx,
                    mapping.localnet,
                    (policy) => `Create bridge ${mapping.bridge} in NodeNetworkConfigurationPolicy ${policy}, `
                        + 'or map the physical network to a bridge that exists.',
                    `No enactment on ${node} claims this mapping; create bridge ${mapping.bridge} `
                        + 'or correct the mapping with a NodeNetworkConfigurationPolicy.'
                )
            }));
    }
};
