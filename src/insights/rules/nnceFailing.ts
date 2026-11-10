import type { NodeNetworkConfigurationEnactment } from '../../types';
import { nodeNameOf } from '../node';
import { makeFinding, nncpRef, nnceRef } from '../refs';
import type { PhysicalRule } from '../types';

const BAD_CONDITIONS = ['Failing', 'Degraded'];

/**
 * The policy an enactment records. The label is the reliable source; the name is
 * `<node>.<policy>`, and node names may themselves contain dots, so the fallback
 * strips the known node name rather than splitting on the first dot.
 */
const policyNameOf = (enactment: NodeNetworkConfigurationEnactment, node: string): string => {
    const label = enactment.metadata?.labels?.['nmstate.io/policy'];
    if (label) return label;
    const name = enactment.metadata?.name || '';
    return node && name.startsWith(`${node}.`) ? name.slice(node.length + 1) : name;
};

/**
 * nnce-failing: a NodeNetworkConfigurationEnactment on this node is Failing or
 * Degraded, so a policy's configuration did not (fully) apply here. A node with no
 * enactments -- no nmstate operator, an imported NodeNetworkState -- reports nothing.
 * Progressing and Pending are transient and are not findings.
 */
export const nnceFailing: PhysicalRule = {
    id: 'nnce-failing',
    severity: 'warning',
    scope: 'node',
    domain: 'physical',
    title: 'Network policy failed to apply',
    evaluate: ({ node: ctx }) => {
        if (!ctx) return [];
        const node = nodeNameOf(ctx);
        return ctx.enactments.flatMap((enactment) => {
            const enactmentNode = enactment.metadata?.labels?.['nmstate.io/node'];
            if (enactmentNode && node && enactmentNode !== node) return [];
            const bad = (enactment.status?.conditions ?? [])
                .filter((c) => BAD_CONDITIONS.includes(c.type) && c.status === 'True');
            if (bad.length === 0) return [];
            const policy = policyNameOf(enactment, node);
            const ref = nnceRef(enactment);
            const state = bad.map((c) => c.type).join(' and ');
            return [makeFinding({
                ruleId: nnceFailing.id,
                severity: nnceFailing.severity,
                subject: { kind: 'k8s', ref },
                scope: { node },
                summary: `NodeNetworkConfigurationPolicy ${policy} is ${state} on ${node}.`,
                evidence: bad.map((c) => ({
                    fact: `Condition ${c.type} is True${c.reason ? ` (${c.reason})` : ''}`
                        + `${c.message ? `: ${c.message}` : '.'}`,
                    sources: [ref],
                    path: `status.conditions[type=${c.type}]`
                })),
                remedy: {
                    text: `Read the enactment's message, then correct NodeNetworkConfigurationPolicy ${policy}; `
                        + 'nmstate normally rolls a failed configuration back, so the node may still run its previous state.',
                    target: nncpRef(policy),
                    path: 'spec.desiredState'
                }
            })];
        });
    }
};
