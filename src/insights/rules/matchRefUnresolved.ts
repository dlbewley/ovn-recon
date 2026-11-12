import { ownerOf, ownerTarget } from '../../components/ovnOwner';
import { matchRefs, policyIndexFor, PolicyIndex } from '../../components/policyIndex';
import type { ACLRow, LogicalDatabase } from '../../types';
import { constructSubject, snapshotFact, zoneSubject } from '../logical';
import { makeFinding, nodeRef } from '../refs';
import type { Evidence, Finding, K8sRef, LogicalRule, Remedy } from '../types';

/** ACLs cited by name in one finding before a count stands for the rest. */
const MAX_CITED_ACLS = 3;

/**
 * OVN derives two address sets from every port group, `<group>_ip4` and
 * `<group>_ip6`, which a match names like any other set but no Address_Set row holds.
 */
const IMPLICIT_SET = /^(.+)_ip[46]$/;

/** `@group` or `$set` names in this ACL's match that the zone does not hold. */
export const unresolvedRefs = (index: PolicyIndex, acl: Pick<ACLRow, 'match'>): string[] => {
    const refs = matchRefs(acl);
    return [
        ...refs.portGroups.filter((name) => !index.portGroupByName.has(name)).map((name) => `@${name}`),
        ...refs.addressSets.filter((name) => {
            if (index.addressSetByName.has(name)) return false;
            const implicit = IMPLICIT_SET.exec(name);
            return !(implicit && index.portGroupByName.has(implicit[1]));
        }).map((name) => `$${name}`)
    ];
};

const describeAcl = (acl: ACLRow): string =>
    `${acl.name ? `ACL ${acl.name}` : `ACL ${acl.uuid}`} (${acl.direction}, priority ${acl.priority})`;

const k8sRefOf = (target: { apiVersion: string; kind: string; name: string; namespace?: string }): K8sRef => {
    const slash = target.apiVersion.indexOf('/');
    return {
        group: slash > 0 ? target.apiVersion.slice(0, slash) : '',
        version: slash > 0 ? target.apiVersion.slice(slash + 1) : target.apiVersion,
        kind: target.kind,
        name: target.name,
        namespace: target.namespace
    };
};

/** Start from the ACL's owner when the external IDs name one; else from the node. */
const remedyFor = (acls: ACLRow[], node: string): Remedy => {
    const owner = acls.map((acl) => ownerTarget(ownerOf(acl.externalIds))).find(Boolean);
    const text = 'OVN-Kubernetes writes these ACLs together with the groups and sets they name, so a '
        + 'missing name usually means it has not finished, or has failed, reconciling the policy behind them. '
        + `Look for errors about it in the ovnkube-controller container of the ovnkube-node pod on ${node}.`;
    return owner
        ? { text, target: k8sRefOf(owner), verb: 'view' }
        : { text, target: nodeRef(node), verb: 'view' };
};

const findingFor = (
    node: string,
    ref: string,
    acls: ACLRow[],
    switchName: string | undefined
): Finding => {
    const isGroup = ref.startsWith('@');
    const kind = isGroup ? 'port group' : 'address set';
    const cited = acls.slice(0, MAX_CITED_ACLS);
    const evidence: Evidence[] = [
        snapshotFact(node, `No ${kind} named ${ref.slice(1)} exists in this zone.`,
            isGroup ? 'Port_Group.name' : 'Address_Set.name'),
        ...cited.map((acl) => snapshotFact(node, `${describeAcl(acl)} matches on ${ref}: ${acl.match}`,
            `ACL[uuid=${acl.uuid}].match`)),
        ...(acls.length > cited.length
            ? [snapshotFact(node, `${acls.length - cited.length} more ACLs here name ${ref}.`)]
            : [])
    ];
    const one = acls.length === 1;
    const where = switchName ? `switch ${switchName}` : `the zone of ${node}`;
    return makeFinding({
        ruleId: matchRefUnresolved.id,
        severity: matchRefUnresolved.severity,
        subject: switchName ? constructSubject(node, 'switch', switchName) : zoneSubject(node),
        scope: { node },
        summary: `${one ? 'An ACL' : `${acls.length} ACLs`} on ${where} name${one ? 's' : ''} ${kind} ${ref}, `
            + `which does not exist; OVN cannot compile such a match, so ${one ? 'the ACL is' : 'those ACLs are'} `
            + 'likely not in force.',
        evidence,
        remedy: remedyFor(acls, node)
    }, ref);
};

/** Missing name to the ACLs naming it, in the order given. */
const groupByRef = (index: PolicyIndex, acls: ACLRow[]): Map<string, ACLRow[]> => {
    const byRef = new Map<string, ACLRow[]>();
    acls.forEach((acl) => unresolvedRefs(index, acl).forEach((ref) => {
        const list = byRef.get(ref) ?? [];
        list.push(acl);
        byRef.set(ref, list);
    }));
    return byRef;
};

const hasFullPolicySection = (database: LogicalDatabase | undefined): database is LogicalDatabase =>
    Boolean(database && database.acls && database.portGroups && database.addressSets);

/**
 * match-ref-unresolved: an ACL's match names a port group (`@name`) or address set
 * (`$name`) that does not exist in the zone. Reported on each switch the ACL applies
 * on, once per missing name; an ACL that applies on no switch of the zone is
 * reported on the zone. Reads the `policy` section, and stays quiet unless all three
 * of its tables were collected.
 */
export const matchRefUnresolved: LogicalRule = {
    id: 'match-ref-unresolved',
    severity: 'warning',
    scope: 'node',
    domain: 'logical',
    title: 'ACL names a missing group or set',
    section: 'policy',
    evaluate: ({ nodeName, snapshot }) => {
        const database = snapshot.database;
        if (!hasFullPolicySection(database)) return [];
        const index = policyIndexFor(database);
        const findings: Finding[] = [];
        const placed = new Set<string>();
        database.logicalSwitches.forEach((logicalSwitch) => {
            const acls = index.aclsBySwitch.get(logicalSwitch.uuid)?.all ?? [];
            acls.forEach((acl) => placed.add(acl.uuid));
            groupByRef(index, acls).forEach((naming, ref) =>
                findings.push(findingFor(nodeName, ref, naming, logicalSwitch.name)));
        });
        const unplaced = (database.acls ?? []).filter((acl) => !placed.has(acl.uuid));
        groupByRef(index, unplaced).forEach((naming, ref) => findings.push(findingFor(nodeName, ref, naming, undefined)));
        return findings;
    }
};
