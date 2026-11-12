import type { LogicalTopologySnapshot } from '../../types';
import { loadSnapshot, logicalContext } from '../testing';
import { matchRefUnresolved } from './matchRefUnresolved';

/** A port group of cnv-1 with a member port and ACLs, and the switch that port is on. */
const placedGroup = (snapshot: LogicalTopologySnapshot) => {
    const database = snapshot.database!;
    const group = database.portGroups!.find((pg) => pg.ports.length > 0 && pg.acls.length > 0)!;
    const logicalSwitch = database.logicalSwitches.find((ls) => ls.ports.includes(group.ports[0]))!;
    return { group, logicalSwitch };
};

const setMatch = (snapshot: LogicalTopologySnapshot, aclUuid: string, match: string) => {
    snapshot.database!.acls!.find((acl) => acl.uuid === aclUuid)!.match = match;
};

describe('match-ref-unresolved', () => {
    it('stays quiet on the capture as taken: every reference resolves', () => {
        ['cnv-1', 'ctrl-1'].forEach((name) =>
            expect(matchRefUnresolved.evaluate(logicalContext(loadSnapshot(name)))).toEqual([]));
    });

    it('fires once per missing name on the switch the ACL applies on', () => {
        const snapshot = loadSnapshot('cnv-1');
        const { group, logicalSwitch } = placedGroup(snapshot);
        setMatch(snapshot, group.acls[0], 'outport == @pg_gone && ip4.src == $as_gone');

        const findings = matchRefUnresolved.evaluate(logicalContext(snapshot));

        expect(findings.map((finding) => finding.key.split('|').pop())).toEqual(['@pg_gone', '$as_gone']);
        expect(findings[0]).toEqual(expect.objectContaining({
            ruleId: 'match-ref-unresolved',
            subject: { kind: 'construct', node: 'cnv-1', constructKind: 'switch', name: logicalSwitch.name }
        }));
        expect(findings[0].summary).toBe(
            `An ACL on switch ${logicalSwitch.name} names port group @pg_gone, which does not exist; `
            + 'OVN cannot compile such a match, so the ACL is likely not in force.'
        );
        expect(findings[0].evidence[1].path).toBe(`ACL[uuid=${group.acls[0]}].match`);
        expect(findings[0].remedy.verb).toBe('view');
    });

    it('takes a port group\'s own _ip4 and _ip6 sets as resolved', () => {
        const snapshot = loadSnapshot('cnv-1');
        const { group } = placedGroup(snapshot);
        setMatch(snapshot, group.acls[0], `ip4.src == $${group.name}_ip4 || ip6.src == $${group.name}_ip6`);
        expect(matchRefUnresolved.evaluate(logicalContext(snapshot))).toEqual([]);
    });

    it('reports an ACL that applies on no switch here on the zone', () => {
        const snapshot = loadSnapshot('cnv-1');
        const empty = snapshot.database!.portGroups!.find((pg) => pg.ports.length === 0 && pg.acls.length > 0)!;
        setMatch(snapshot, empty.acls[0], 'inport == @pg_gone');

        const findings = matchRefUnresolved.evaluate(logicalContext(snapshot));
        expect(findings).toHaveLength(1);
        expect(findings[0].subject).toEqual({ kind: 'k8s', ref: expect.objectContaining({ kind: 'Node', name: 'cnv-1' }) });
    });

    it('stays quiet without the policy section, rather than reading every name as missing', () => {
        const snapshot = loadSnapshot('cnv-1');
        const { group } = placedGroup(snapshot);
        setMatch(snapshot, group.acls[0], 'outport == @pg_gone');
        delete snapshot.database!.addressSets;
        expect(matchRefUnresolved.evaluate(logicalContext(snapshot))).toEqual([]);
    });
});
