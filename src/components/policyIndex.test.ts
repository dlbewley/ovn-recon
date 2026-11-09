import { ACLRow, AddressSetRow, LogicalDatabase, PortGroupRow } from '../types';
import {
    compareAcls,
    EMPTY_POLICY_INDEX,
    hasPolicySection,
    matchRefs,
    policyForPort,
    policyIndexFor,
    resolveMatchRefs,
    summarizeSwitchAcls,
    switchAclSummaryText,
    zoneRowFor,
} from './policyIndex';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';
import cnv2 from '../../collector/fixtures/snapshots/cnv-2.json';

const fixtureDatabase = (cnv1 as unknown as { database: LogicalDatabase }).database;
const fixtureWithoutPolicy = (cnv2 as unknown as { database: LogicalDatabase }).database;

const acl = (uuid: string, extra: Partial<ACLRow> = {}): ACLRow => ({
    uuid,
    priority: 1001,
    direction: 'to-lport',
    action: 'allow-related',
    match: 'ip4',
    tier: 2,
    ...extra,
});

const group = (uuid: string, name: string, ports: string[], acls: string[], ownerType = 'NetworkPolicy'): PortGroupRow => ({
    uuid,
    name,
    ports,
    acls,
    externalIds: { 'k8s.ovn.org/owner-type': ownerType, 'k8s.ovn.org/name': name },
});

const addressSet = (uuid: string, name: string, addresses: string[]): AddressSetRow => ({ uuid, name, addresses });

/**
 * Two switches. `red` holds pod-a, pod-b and a router port; `blue` holds
 * pod-c. Groups: policy-web (pod-a, with two ACLs), namespace deny (pod-a and
 * pod-b, one ACL that policy-web also carries), an empty namespace group, a
 * group with members but no ACL, and a group on blue. `red` also has an ACL
 * of its own.
 */
const database = (): LogicalDatabase => ({
    logicalRouters: [],
    logicalRouterPorts: [],
    logicalSwitches: [
        { uuid: 'ls-red', name: 'red', ports: ['pod-a', 'pod-b', 'rtr'], acls: ['acl-node'] },
        { uuid: 'ls-blue', name: 'blue', ports: ['pod-c'] },
        { uuid: 'ls-bare', name: 'bare', ports: [] },
    ],
    logicalSwitchPorts: [
        { uuid: 'pod-a', name: 'shop_a' },
        { uuid: 'pod-b', name: 'shop_b' },
        { uuid: 'rtr', name: 'stor-red', type: 'router' },
        { uuid: 'pod-c', name: 'shop_c' },
    ],
    nats: [],
    staticRoutes: [],
    acls: [
        acl('acl-node', { match: 'ip4.src==10.0.0.2' }),
        acl('acl-web', { direction: 'to-lport', priority: 1001, match: 'ip4.src == {$as_web} && outport == @pg_web' }),
        acl('acl-dns', { direction: 'from-lport', priority: 1001, match: 'ip4.dst == {$as_dns, $as_web} && inport == @pg_web' }),
        acl('acl-deny', { direction: 'to-lport', priority: 1000, action: 'drop', match: 'outport == @pg_deny' }),
        acl('acl-blue', { direction: 'from-lport', match: 'inport == @pg_blue' }),
    ],
    portGroups: [
        group('g-web', 'pg_web', ['pod-a'], ['acl-web', 'acl-dns', 'acl-deny']),
        group('g-deny', 'pg_deny', ['pod-a', 'pod-b'], ['acl-deny'], 'NetpolNamespace'),
        group('g-empty', 'pg_empty', [], [], 'Namespace'),
        group('g-ns', 'pg_ns', ['pod-a', 'pod-b'], [], 'Namespace'),
        group('g-blue', 'pg_blue', ['pod-c'], ['acl-blue']),
    ],
    addressSets: [addressSet('as-1', 'as_web', ['10.0.0.5']), addressSet('as-2', 'as_dns', [])],
});

const uuids = (rows: Array<{ uuid: string }>) => rows.map((row) => row.uuid);

describe('policyIndexFor', () => {
    it('is empty with present=false when the section is absent', () => {
        const without = { ...database(), acls: undefined, portGroups: undefined, addressSets: undefined };
        for (const index of [policyIndexFor(without), policyIndexFor(undefined), policyIndexFor(null)]) {
            expect(index).toBe(EMPTY_POLICY_INDEX);
            expect(index.present).toBe(false);
            expect(index.aclByUuid.size).toBe(0);
            expect(index.portGroupByUuid.size).toBe(0);
            expect(index.portGroupByName.size).toBe(0);
            expect(index.addressSetByName.size).toBe(0);
            expect(index.portGroupsByPort.size).toBe(0);
            expect(index.aclsByPortGroup.size).toBe(0);
            expect(index.aclsBySwitch.size).toBe(0);
        }
        expect(hasPolicySection(without)).toBe(false);
        // Lookups on the empty index answer "nothing", not an error.
        expect(policyForPort(EMPTY_POLICY_INDEX, 'pod-a')).toEqual({ groups: [], acls: [] });
    });

    it('tells a collected, empty section from an absent one', () => {
        const empty = { ...database(), acls: [], portGroups: [], addressSets: [] };
        const index = policyIndexFor(empty);
        expect(index.present).toBe(true);
        expect(index.aclByUuid.size).toBe(0);
        expect(summarizeSwitchAcls(index.aclsBySwitch.get('ls-red'))).toEqual({ direct: 0, viaGroups: 0, groups: 0, total: 0 });
    });

    it('needs both acls and portGroups, and tolerates missing address sets', () => {
        expect(hasPolicySection({ ...database(), portGroups: undefined })).toBe(false);
        expect(hasPolicySection({ ...database(), acls: undefined })).toBe(false);
        const index = policyIndexFor({ ...database(), addressSets: undefined });
        expect(index.present).toBe(true);
        expect(index.addressSetByName.size).toBe(0);
        expect(resolveMatchRefs(index, index.aclByUuid.get('acl-web')!).addressSets).toEqual([{ name: 'as_web', row: undefined }]);
    });

    it('is built once per database object', () => {
        const db = database();
        expect(policyIndexFor(db)).toBe(policyIndexFor(db));
        expect(policyIndexFor(database())).not.toBe(policyIndexFor(db));
    });

    it('indexes rows by uuid and by the names a match uses', () => {
        const index = policyIndexFor(database());
        expect(index.present).toBe(true);
        expect(index.aclByUuid.get('acl-web')?.priority).toBe(1001);
        expect(index.portGroupByUuid.get('g-web')?.name).toBe('pg_web');
        expect(index.portGroupByName.get('pg_deny')?.uuid).toBe('g-deny');
        expect(index.addressSetByName.get('as_web')?.addresses).toEqual(['10.0.0.5']);
    });

    it('maps a port to the groups it is a member of', () => {
        const index = policyIndexFor(database());
        expect(uuids(index.portGroupsByPort.get('pod-a') ?? []).sort()).toEqual(['g-deny', 'g-ns', 'g-web']);
        expect(uuids(index.portGroupsByPort.get('pod-b') ?? []).sort()).toEqual(['g-deny', 'g-ns']);
        expect(uuids(index.portGroupsByPort.get('pod-c') ?? [])).toEqual(['g-blue']);
        // A port in no group, and a uuid this zone does not hold.
        expect(index.portGroupsByPort.get('rtr')).toBeUndefined();
        expect(index.portGroupsByPort.get('other-zone-port')).toBeUndefined();
    });

    it('maps a group to its ACLs through Port_Group.acls', () => {
        const index = policyIndexFor(database());
        expect(uuids(index.aclsByPortGroup.get('g-web') ?? [])).toEqual(['acl-dns', 'acl-web', 'acl-deny']);
        expect(uuids(index.aclsByPortGroup.get('g-deny') ?? [])).toEqual(['acl-deny']);
        expect(index.aclsByPortGroup.get('g-empty')).toEqual([]);
        // A dangling ACL reference is dropped, not an error.
        const dangling = database();
        dangling.portGroups![0].acls.push('gone');
        expect(policyIndexFor(dangling).aclsByPortGroup.get('g-web')).toHaveLength(3);
    });

    it('collects the ACLs on a switch: its own plus those of groups with a port there, each once', () => {
        const index = policyIndexFor(database());
        const red = index.aclsBySwitch.get('ls-red')!;
        expect(uuids(red.direct)).toEqual(['acl-node']);
        // g-ns has members on red but no ACL, g-empty no members: neither counts.
        expect(red.viaGroups.map((entry) => [entry.group.uuid, entry.ports, entry.acls.length])).toEqual([
            ['g-deny', 2, 1],
            ['g-web', 1, 3],
        ]);
        // acl-deny arrives through two groups and is listed once.
        expect(uuids(red.all)).toEqual(['acl-dns', 'acl-node', 'acl-web', 'acl-deny']);
        expect(summarizeSwitchAcls(red)).toEqual({ direct: 1, viaGroups: 3, groups: 2, total: 4 });
        expect(switchAclSummaryText(summarizeSwitchAcls(red))).toBe('1 direct · 3 via 2 port groups');

        const blue = index.aclsBySwitch.get('ls-blue')!;
        expect(blue.direct).toEqual([]);
        expect(uuids(blue.all)).toEqual(['acl-blue']);
        expect(switchAclSummaryText(summarizeSwitchAcls(blue))).toBe('1 via 1 port group');

        expect(switchAclSummaryText(summarizeSwitchAcls(index.aclsBySwitch.get('ls-bare')))).toBe('No ACLs');
        expect(switchAclSummaryText(summarizeSwitchAcls(undefined))).toBe('No ACLs');
    });
});

describe('policyForPort', () => {
    it('lists the port groups and the ACLs that apply, group ACLs plus the switch ACLs', () => {
        const index = policyIndexFor(database());
        const policy = policyForPort(index, 'pod-a');
        expect(uuids(policy.groups)).toEqual(['g-ns', 'g-deny', 'g-web']);
        // Sorted by direction, then priority descending; acl-deny once.
        expect(policy.acls.map((applied) => [applied.acl.uuid, applied.group?.uuid])).toEqual([
            ['acl-dns', 'g-web'],
            ['acl-node', undefined],
            ['acl-web', 'g-web'],
            ['acl-deny', 'g-deny'],
        ]);
    });

    it('gives a port in no group the switch ACLs alone', () => {
        const policy = policyForPort(policyIndexFor(database()), 'rtr');
        expect(policy.groups).toEqual([]);
        expect(policy.acls.map((applied) => applied.acl.uuid)).toEqual(['acl-node']);
    });
});

describe('compareAcls', () => {
    it('orders by direction, then tier, then priority descending', () => {
        const rows = [
            acl('d', { direction: 'to-lport', priority: 1000 }),
            acl('c', { direction: 'to-lport', priority: 1001 }),
            acl('b', { direction: 'from-lport', priority: 1000 }),
            acl('a', { direction: 'from-lport', priority: 1050, tier: 0 }),
            acl('e', { direction: 'from-lport', priority: 1100 }),
        ];
        expect(uuids([...rows].sort(compareAcls))).toEqual(['a', 'e', 'b', 'c', 'd']);
    });
});

describe('matchRefs', () => {
    it('parses port group and address set references', () => {
        expect(matchRefs('ip4.dst == {$a10082001586233910081} && tcp && tcp.dst==5353 && inport == @a2488624212041051076')).toEqual({
            portGroups: ['a2488624212041051076'],
            addressSets: ['a10082001586233910081'],
        });
        expect(matchRefs(acl('x', { match: 'outport == @pg_a && ip4.src == {$as_a, $as_b} && ip4.dst == $as_a' }))).toEqual({
            portGroups: ['pg_a'],
            addressSets: ['as_a', 'as_b'],
        });
        expect(matchRefs('(ip4.src == $a1 && ip4.dst == $a1)')).toEqual({ portGroups: [], addressSets: ['a1'] });
    });

    it('finds none in a match without references, and ignores quoted port names', () => {
        expect(matchRefs('ip4.src==10.131.0.2')).toEqual({ portGroups: [], addressSets: [] });
        expect(matchRefs('outport=="macvrf-net@1" && arp && inport == @pg')).toEqual({ portGroups: ['pg'], addressSets: [] });
        expect(matchRefs('')).toEqual({ portGroups: [], addressSets: [] });
    });

    it('resolves names against the index and leaves unknown names without a row', () => {
        const index = policyIndexFor(database());
        const resolved = resolveMatchRefs(index, 'ip4.dst == {$as_dns, $as_gone} && inport == @pg_web && outport == @pg_gone');
        expect(resolved.portGroups.map((ref) => [ref.name, ref.row?.uuid])).toEqual([
            ['pg_web', 'g-web'],
            ['pg_gone', undefined],
        ]);
        expect(resolved.addressSets.map((ref) => [ref.name, ref.row?.uuid])).toEqual([
            ['as_dns', 'as-2'],
            ['as_gone', undefined],
        ]);
    });
});

describe('zoneRowFor', () => {
    it('finds a row by uuid, then by name, as the merged cluster view needs', () => {
        const rows = database().logicalSwitches;
        expect(zoneRowFor(rows, { uuid: 'ls-red', name: 'whatever' })?.name).toBe('red');
        expect(zoneRowFor(rows, { uuid: 'another-zone-uuid', name: 'blue' })?.uuid).toBe('ls-blue');
        expect(zoneRowFor(rows, { uuid: 'x', name: 'y' })).toBeUndefined();
        expect(zoneRowFor(undefined, { uuid: 'x', name: 'y' })).toBeUndefined();
    });
});

describe('policy index over the captured fixture', () => {
    const index = policyIndexFor(fixtureDatabase);
    const switchByName = (name: string) => fixtureDatabase.logicalSwitches.find((row) => row.name === name)!;
    const portByName = (name: string) => fixtureDatabase.logicalSwitchPorts.find((row) => row.name === name)!;

    it('is present on cnv-1 and absent on a fixture without the section', () => {
        expect(index.present).toBe(true);
        expect(policyIndexFor(fixtureWithoutPolicy).present).toBe(false);
    });

    it('resolves every match reference by name', () => {
        for (const row of fixtureDatabase.acls ?? []) {
            const resolved = resolveMatchRefs(index, row);
            for (const ref of [...resolved.portGroups, ...resolved.addressSets]) expect(ref.row).toBeDefined();
        }
    });

    it('sees the node switch through its own ACL and the port groups of its pods', () => {
        const summary = summarizeSwitchAcls(index.aclsBySwitch.get(switchByName('cnv-1').uuid));
        expect(summary.direct).toBe(1);
        expect(summary.groups).toBeGreaterThan(10);
        expect(summary.viaGroups).toBeGreaterThan(summary.groups);
        expect(summary.total).toBe(summary.direct + summary.viaGroups);
    });

    it('gives a pod in a namespace with NetworkPolicies its policy groups and ACLs', () => {
        const pod = portByName('openshift-monitoring_alertmanager-main-1');
        const policy = policyForPort(index, pod.uuid);
        const types = policy.groups.map((row) => row.externalIds?.['k8s.ovn.org/owner-type']);
        expect(types).toEqual(expect.arrayContaining(['Namespace', 'NetpolNamespace', 'NetworkPolicy']));
        expect(policy.acls.length).toBeGreaterThan(4);
        // The node ACL set on the switch applies to every port on it.
        expect(policy.acls.some((applied) => applied.group === undefined)).toBe(true);
        // Display order: from-lport before to-lport.
        const directions = policy.acls.map((applied) => applied.acl.direction);
        expect(directions.lastIndexOf('from-lport')).toBeLessThan(directions.indexOf('to-lport'));
    });

    it('puts the management port in the cluster port group only', () => {
        const groups = index.portGroupsByPort.get(portByName('k8s-cnv-1').uuid) ?? [];
        expect(groups.map((row) => row.externalIds?.['k8s.ovn.org/name'])).toEqual(['clusterPortGroup']);
    });
});
