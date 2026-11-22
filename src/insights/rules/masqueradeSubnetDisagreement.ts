import { nodeMasqueradeSubnets } from '../../components/masqueradeIps';
import { cidrKey, nameList, NODE_ANNOTATION_PATH, operatorNetworkRef, plural } from '../masquerade';
import { makeFinding, nodeRef } from '../refs';
import type { PhysicalRule } from '../types';

/**
 * masquerade-subnet-disagreement (ovn-recon-2n6.5): the Nodes do not all report the
 * same masquerade subnets in `k8s.ovn.org/node-masquerade-subnet`. The subnet is one
 * cluster-wide setting, so nodes that differ are part way through a change, or one
 * did not take it. Reported once, on the network configuration; Nodes without the
 * annotation are left out (absence is not a problem).
 */
export const masqueradeSubnetDisagreement: PhysicalRule = {
    id: 'masquerade-subnet-disagreement',
    severity: 'warning',
    scope: 'network',
    domain: 'physical',
    title: 'Nodes disagree on the masquerade subnet',
    evaluate: ({ cluster }) => {
        const byValue = new Map<string, string[]>();
        for (const node of cluster.nodes ?? []) {
            const name = node.metadata?.name;
            const cidrs = nodeMasqueradeSubnets(node).map(cidrKey).filter((cidr): cidr is string => Boolean(cidr));
            if (!name || cidrs.length === 0) continue;
            const value = [...new Set(cidrs)].sort().join(', ');
            byValue.set(value, [...(byValue.get(value) ?? []), name]);
        }
        if (byValue.size < 2) return [];

        // Most nodes first: the odd ones out read last.
        const groups = [...byValue.entries()]
            .map(([value, nodes]) => ({ value, nodes: nodes.sort() }))
            .sort((a, b) => b.nodes.length - a.nodes.length || a.value.localeCompare(b.value));
        const described = groups.map((group) => `${group.value} on ${plural(group.nodes.length, 'node')}`);
        return [makeFinding({
            ruleId: masqueradeSubnetDisagreement.id,
            severity: masqueradeSubnetDisagreement.severity,
            subject: { kind: 'k8s', ref: operatorNetworkRef },
            scope: {},
            summary: `Nodes disagree on the masquerade subnet: ${described.join('; ')}.`,
            evidence: groups.map((group) => ({
                fact: `${plural(group.nodes.length, 'Node')} (${nameList(group.nodes)}) ${group.nodes.length === 1 ? 'reports' : 'report'} ${group.value}.`,
                sources: group.nodes.map(nodeRef),
                path: NODE_ANNOTATION_PATH
            })),
            remedy: {
                text: 'The masquerade subnet is one cluster-wide setting. Check whether a change to internalMasqueradeSubnet '
                    + 'is still rolling out, and the ovnkube-node pods of the nodes that differ.',
                target: operatorNetworkRef,
                verb: 'view'
            }
        })];
    }
};
