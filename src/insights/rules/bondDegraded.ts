import { getBondMembers } from '../../components/nodeVisualizationSelectors';
import { interfaceNodeId } from '../../topology/ids';
import type { Interface, NodeNetworkConfigurationEnactment } from '../../types';
import { interfacePath, interfaceRemedy, nnsFact, nodeNameOf } from '../node';
import { makeFinding, nnceRef } from '../refs';
import type { Evidence, PhysicalRule } from '../types';

/**
 * The members an enactment's desired state gives a bond. The NNCE type declares only
 * name and type for desired interfaces; the rest of the policy's interface is there
 * on the object and is read loosely.
 */
const desiredBondMembers = (
    bondName: string,
    enactment: NodeNetworkConfigurationEnactment
): string[] => {
    const desired = (enactment.status?.desiredState?.interfaces ?? [])
        .find((iface) => iface.name === bondName) as Interface | undefined;
    return desired ? getBondMembers(desired) : [];
};

/**
 * bond-degraded: a bond has fewer members up than it is configured with.
 *
 * Configured members are those the bond reports in link-aggregation.port, together
 * with any an enactment on this node declares for it -- so a member that dropped out
 * of the bond altogether is still counted. A member counts against the bond when the
 * node reports it down, or does not report it at all. nmstate's `ignore` (not managed
 * by NetworkManager) says nothing about the link and is not counted as down.
 */
export const bondDegraded: PhysicalRule = {
    id: 'bond-degraded',
    severity: 'warning',
    scope: 'node',
    domain: 'physical',
    title: 'Bond has members down',
    evaluate: ({ node: ctx }) => {
        if (!ctx) return [];
        const node = nodeNameOf(ctx);
        const byName = new Map(ctx.interfaces.map((iface) => [iface.name, iface]));

        return ctx.interfaces.filter((iface) => iface.type === 'bond').flatMap((bond) => {
            const reported = getBondMembers(bond);
            const declaredBy = new Map<string, NodeNetworkConfigurationEnactment>();
            ctx.enactments.forEach((enactment) => desiredBondMembers(bond.name, enactment)
                .forEach((member) => {
                    if (!reported.includes(member) && !declaredBy.has(member)) declaredBy.set(member, enactment);
                }));
            const configured = [...reported, ...declaredBy.keys()];
            if (configured.length === 0) return [];

            const notUp = configured.filter((member) => {
                const iface = byName.get(member);
                return !iface || iface.state === 'down';
            });
            if (notUp.length === 0) return [];

            const evidence: Evidence[] = [];
            if (reported.length > 0) {
                evidence.push(nnsFact(ctx, `${bond.name} reports members ${reported.join(', ')}.`,
                    interfacePath(bond.name, 'link-aggregation.port')));
            }
            declaredBy.forEach((enactment, member) => evidence.push({
                fact: `Enactment ${enactment.metadata?.name} declares ${member} a member of ${bond.name}, `
                    + 'but the bond does not report it.',
                sources: [nnceRef(enactment)],
                path: `status.desiredState.interfaces[name=${bond.name}].link-aggregation.port`
            }));
            notUp.forEach((member) => {
                const iface = byName.get(member);
                evidence.push(iface
                    ? nnsFact(ctx, `Member ${member} is in state down.`, interfacePath(member, 'state'))
                    : nnsFact(ctx, `Member ${member} is not reported by the node.`, 'status.currentState.interfaces'));
            });

            return [makeFinding({
                ruleId: bondDegraded.id,
                severity: bondDegraded.severity,
                subject: { kind: 'graph-node', node, graphNodeId: interfaceNodeId(bond, ctx) },
                scope: { node },
                summary: `Bond ${bond.name} on ${node} has ${notUp.length} of ${configured.length} members down.`,
                evidence,
                remedy: interfaceRemedy(
                    ctx,
                    bond.name,
                    (policy) => `Check the links of ${notUp.join(', ')} and their switch ports; `
                        + `NodeNetworkConfigurationPolicy ${policy} configures ${bond.name}.`,
                    `Check the links of ${notUp.join(', ')} on ${node} and their switch ports.`
                )
            })];
        });
    }
};
