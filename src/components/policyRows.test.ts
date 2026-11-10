import { LogicalDatabase, LogicalTopologySnapshot } from '../types';
import { matchRefs, policyForPort, policyIndexFor } from './policyIndex';
import { portPolicyCounts, referencedAddressSets, switchAclRows, switchPortGroups } from './policyRows';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';

const database = (cnv1 as unknown as LogicalTopologySnapshot).database as LogicalDatabase;
const index = policyIndexFor(database);
const nodeSwitch = database.logicalSwitches.find((row) => row.name === 'cnv-1')!;

describe('policyRows on the cnv-1 node switch', () => {
    it('lists every ACL that applies on the switch, each with how it got there', () => {
        const rows = switchAclRows(index, database, nodeSwitch.uuid);
        const all = index.aclsBySwitch.get(nodeSwitch.uuid)!.all;
        expect(rows.map((row) => row.acl.uuid)).toEqual(all.map((acl) => acl.uuid));
        for (const row of rows) {
            expect(row.direct || row.via.length > 0).toBe(true);
            expect(row.portsHere).toBeGreaterThan(0);
            expect(row.portsHere).toBeLessThanOrEqual(nodeSwitch.ports.length);
        }
        const direct = rows.filter((row) => row.direct);
        expect(direct.length).toBe(index.aclsBySwitch.get(nodeSwitch.uuid)!.direct.length);
        for (const row of direct) expect(row.portsHere).toBe(nodeSwitch.ports.length);
    });

    it('narrows to the ACLs on one port', () => {
        const [portUuid, policy] = nodeSwitch.ports
            .map((uuid) => [uuid, policyForPort(index, uuid)] as const)
            .find(([, candidate]) => candidate.acls.length > 1)!;
        const rows = switchAclRows(index, database, nodeSwitch.uuid, portUuid);
        expect(rows.map((row) => row.acl.uuid)).toEqual(policy.acls.map((applied) => applied.acl.uuid));
        expect(portPolicyCounts(index, portUuid)).toEqual({ groups: policy.groups.length, acls: policy.acls.length });
    });

    it('lists the port groups with a port here, ACLs or not, and counts the rest', () => {
        const { here, elsewhere } = switchPortGroups(index, database, nodeSwitch.uuid);
        expect(here.length + elsewhere).toBe(database.portGroups!.length);
        const switchPorts = new Set(nodeSwitch.ports);
        for (const row of here) {
            expect(row.portsHere.length).toBeGreaterThan(0);
            expect(row.portsHere.every((uuid) => switchPorts.has(uuid))).toBe(true);
        }
        // Groups without ACLs are listed too: more than reach the switch's ACL list.
        expect(here.length).toBeGreaterThan(index.aclsBySwitch.get(nodeSwitch.uuid)!.viaGroups.length);
        expect(elsewhere).toBeGreaterThan(0);
    });

    it('lists each address set the ACLs name, once', () => {
        const acls = index.aclsBySwitch.get(nodeSwitch.uuid)!.all;
        const names = new Set(acls.flatMap((acl) => matchRefs(acl).addressSets));
        const sets = referencedAddressSets(index, acls);
        expect(sets.map((set) => set.name).sort()).toEqual([...names].sort());
        expect(sets.some((set) => set.row)).toBe(true);
    });
});
