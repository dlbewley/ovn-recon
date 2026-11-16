import { getBondMembers, getOvsBonds } from '../../components/nodeVisualizationSelectors';
import type { GraphContext } from '../../topology/context';
import { interfaceNodeId } from '../../topology/ids';
import type { Interface, NodeNetworkConfigurationEnactment } from '../../types';
import { interfacePath, interfaceRemedy, nnsFact, nodeNameOf } from '../node';
import { makeFinding, nnceRef } from '../refs';
import type { Evidence, Finding, FindingSubject, PhysicalRule, Remedy } from '../types';

/**
 * The interfaces an enactment wants. The NNCE type declares only name and type for
 * desired interfaces; the rest of the policy's interface is there on the object and
 * is read loosely.
 */
const desiredInterfaces = (enactment: NodeNetworkConfigurationEnactment): Interface[] =>
    (enactment.status?.desiredState?.interfaces ?? []) as Interface[];

/** The members an enactment's desired state gives a kernel bond. */
const desiredBondMembers = (bondName: string, enactment: NodeNetworkConfigurationEnactment): string[] =>
    getBondMembers(desiredInterfaces(enactment).find((iface) => iface.name === bondName));

/**
 * The members an enactment's desired state gives an OVS bond (ovn-recon-1tw.4): the
 * policy declares it as a port of the bridge, `bridge.port[].link-aggregation.port`,
 * the same shape NNS reports it in, so getOvsBonds reads both.
 */
const desiredOvsBondMembers = (
    bridge: string,
    bondName: string,
    enactment: NodeNetworkConfigurationEnactment
): string[] => getOvsBonds(desiredInterfaces(enactment))
    .find((bond) => bond.bridge === bridge && bond.name === bondName)
    ?.members.map((member) => member.name) ?? [];

/**
 * Where a bridge's port entry for an OVS bond is, in the dotted path form. Some
 * captures list a bridge's ports under `ports`; getOvsBonds reads either, and the path
 * names the one the bridge used.
 */
const ovsBondPortPath = (bridge: Interface | undefined, bondName: string, field: string): string =>
    `bridge.${!bridge?.bridge?.port && bridge?.bridge?.ports ? 'ports' : 'port'}[name=${bondName}].${field}`;

/** One bond, kernel or OVS, as the rule weighs it. */
interface BondUnderTest {
    /** How the summary names it: `Bond bond0`, `OVS bond bond1 in bridge br-vmdata`. */
    title: string;
    /** How evidence and the remedy name it: `bond0`, `OVS bond bond1 in br-vmdata`. */
    name: string;
    /** The members the node reports, and the evidence line saying so. */
    reported: string[];
    reportedFact: Evidence;
    /** The members one enactment declares, and where in the enactment. */
    declared: (enactment: NodeNetworkConfigurationEnactment) => string[];
    declaredPath: string;
    /** What reports the bond's members: `the bond`, or for an OVS bond its bridge. */
    reporter: string;
    /** The interface a policy configures the bond through: the bond, or its bridge. */
    owner: string;
    subject: FindingSubject;
    /** Tells apart several OVS bonds on one bridge, which share the bridge as subject. */
    discriminator?: string;
    /** A last line for the remedy, after the members to check. */
    remedyHint?: string;
}

const degradedFinding = (
    ctx: GraphContext,
    byName: Map<string, Interface>,
    bond: BondUnderTest
): Finding[] => {
    const node = nodeNameOf(ctx);
    const declaredBy = new Map<string, NodeNetworkConfigurationEnactment>();
    ctx.enactments.forEach((enactment) => bond.declared(enactment).forEach((member) => {
        if (!bond.reported.includes(member) && !declaredBy.has(member)) declaredBy.set(member, enactment);
    }));
    const configured = [...bond.reported, ...declaredBy.keys()];
    if (configured.length === 0) return [];

    const notUp = configured.filter((member) => {
        const iface = byName.get(member);
        return !iface || iface.state === 'down';
    });
    if (notUp.length === 0) return [];

    const evidence: Evidence[] = [];
    if (bond.reported.length > 0) evidence.push(bond.reportedFact);
    declaredBy.forEach((enactment, member) => evidence.push({
        fact: `Enactment ${enactment.metadata?.name} declares ${member} a member of ${bond.name}, `
            + `but ${bond.reporter} does not report it.`,
        sources: [nnceRef(enactment)],
        path: bond.declaredPath
    }));
    notUp.forEach((member) => {
        const iface = byName.get(member);
        evidence.push(iface
            ? nnsFact(ctx, `Member ${member} is in state down.`, interfacePath(member, 'state'))
            : nnsFact(ctx, `Member ${member} is not reported by the node.`, 'status.currentState.interfaces'));
    });

    const hint = bond.remedyHint ? ` ${bond.remedyHint}` : '';
    const remedy: Remedy = interfaceRemedy(
        ctx,
        bond.owner,
        (policy) => `Check the links of ${notUp.join(', ')} and their switch ports; `
            + `NodeNetworkConfigurationPolicy ${policy} configures ${bond.name}.${hint}`,
        `Check the links of ${notUp.join(', ')} on ${node} and their switch ports.${hint}`
    );

    return [makeFinding({
        ruleId: bondDegraded.id,
        severity: bondDegraded.severity,
        subject: bond.subject,
        scope: { node },
        summary: `${bond.title} on ${node} has ${notUp.length} of ${configured.length} members down.`,
        evidence,
        remedy
    }, bond.discriminator)];
};

/**
 * bond-degraded: a bond has fewer members up than it is configured with.
 *
 * Configured members are those the bond reports in link-aggregation.port, together
 * with any an enactment on this node declares for it -- so a member that dropped out
 * of the bond altogether is still counted. A member counts against the bond when the
 * node reports it down, or does not report it at all. nmstate's `ignore` (not managed
 * by NetworkManager) says nothing about the link and is not counted as down.
 *
 * Kernel bonds are `type: bond` interfaces. An OVS bond (ovn-recon-1tw.4) has no
 * interface of its own: nmstate reports it only as an entry in its bridge's
 * `bridge.port` list, and its members report nothing but `controller: <bridge>`. Its
 * finding is on the bridge's graph node, the nearest thing the graph draws, until
 * ovn-recon-1tw.2 gives the bond a node of its own.
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

        const kernel = ctx.interfaces.filter((iface) => iface.type === 'bond').flatMap((bond) => {
            const reported = getBondMembers(bond);
            return degradedFinding(ctx, byName, {
                title: `Bond ${bond.name}`,
                name: bond.name,
                reported,
                reportedFact: nnsFact(ctx, `${bond.name} reports members ${reported.join(', ')}.`,
                    interfacePath(bond.name, 'link-aggregation.port')),
                declared: (enactment) => desiredBondMembers(bond.name, enactment),
                declaredPath: `status.desiredState.interfaces[name=${bond.name}].link-aggregation.port`,
                reporter: 'the bond',
                owner: bond.name,
                subject: { kind: 'graph-node', node, graphNodeId: interfaceNodeId(bond, ctx) }
            });
        });

        const ovs = getOvsBonds(ctx.interfaces).flatMap((bond) => {
            // Not byName: a bridge's internal port may share its name and replace it there.
            const bridge = ctx.interfaces.find((iface) => iface.name === bond.bridge && iface.type === 'ovs-bridge');
            const reported = bond.members.map((member) => member.name);
            const name = `OVS bond ${bond.name} in ${bond.bridge}`;
            return degradedFinding(ctx, byName, {
                title: `OVS bond ${bond.name} in bridge ${bond.bridge}`,
                name,
                reported,
                reportedFact: nnsFact(ctx,
                    `Bridge ${bond.bridge} reports OVS bond ${bond.name} with members ${reported.join(', ')}.`,
                    interfacePath(bond.bridge, ovsBondPortPath(bridge, bond.name, 'link-aggregation.port'))),
                declared: (enactment) => desiredOvsBondMembers(bond.bridge, bond.name, enactment),
                declaredPath: `status.desiredState.interfaces[name=${bond.bridge}].bridge.port[name=${bond.name}]`
                    + '.link-aggregation.port',
                reporter: `bridge ${bond.bridge}`,
                owner: bond.bridge,
                subject: {
                    kind: 'graph-node',
                    node,
                    graphNodeId: interfaceNodeId(bridge ?? { name: bond.bridge, type: 'ovs-bridge' }, ctx)
                },
                discriminator: `ovs-bond:${bond.name}`,
                // NNS carries no runtime bond state; OVS's own view of each member is here.
                remedyHint: `ovs-appctl bond/show ${bond.name} on the node shows which members OVS has enabled.`
            });
        });

        return [...kernel, ...ovs];
    }
};
