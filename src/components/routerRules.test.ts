import { LogicalDatabase, LogicalTopologySnapshot, NATRow, StaticRouteRow } from '../types';
import { comparePrefixes, isDefaultPrefix, isHostAddress, networkCidr, parsePrefix } from './ipPrefix';
import {
    candidateSubnets,
    groupNatRules,
    groupStaticRoutes,
    natTypeCounts,
    nexthopResolverFor,
    podAddressIndex,
} from './routerRules';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';

const database = (cnv1 as unknown as LogicalTopologySnapshot).database as LogicalDatabase;
const routerNamed = (name: string) => database.logicalRouters.find((router) => router.name === name)!;
const natsOf = (name: string): NATRow[] => {
    const byUuid = new Map(database.nats.map((nat) => [nat.uuid, nat]));
    return (routerNamed(name).nat ?? []).map((uuid) => byUuid.get(uuid)!);
};
const routesOf = (name: string): StaticRouteRow[] => {
    const byUuid = new Map(database.staticRoutes.map((route) => [route.uuid, route]));
    return (routerNamed(name).staticRoutes ?? []).map((uuid) => byUuid.get(uuid)!);
};

const snat = (logicalIp: string, extra: Partial<NATRow> = {}): NATRow => ({
    uuid: `snat-${logicalIp}-${extra.externalIp ?? 'x'}`,
    type: 'snat',
    externalIp: '192.0.2.1',
    logicalIp,
    ...extra,
});

describe('ipPrefix', () => {
    it('parses IPv4 and IPv6 addresses and prefixes', () => {
        expect(networkCidr(parsePrefix('10.131.0.1/23')!)).toBe('10.131.0.0/23');
        expect(networkCidr(parsePrefix('fd00:10:244::5/64')!)).toBe('fd00:10:244::/64');
        expect(parsePrefix('10.0.0.5')!.length).toBe(32);
        expect(parsePrefix('::1')!.length).toBe(128);
        expect(parsePrefix('10.0.0.256')).toBeNull();
        expect(parsePrefix('10.0.0.0/33')).toBeNull();
        expect(parsePrefix('dynamic')).toBeNull();
    });

    it('recognizes default routes and host addresses', () => {
        expect(isDefaultPrefix('0.0.0.0/0')).toBe(true);
        expect(isDefaultPrefix('::/0')).toBe(true);
        expect(isDefaultPrefix('10.0.0.0/8')).toBe(false);
        expect(isHostAddress('10.0.0.1')).toBe(true);
        expect(isHostAddress('10.0.0.1/32')).toBe(true);
        expect(isHostAddress('10.0.0.0/24')).toBe(false);
    });

    it('orders numerically, IPv4 before IPv6', () => {
        expect(['10.0.0.10', 'fd00::1', '10.0.0.9', '10.0.0.0/24'].sort(comparePrefixes)).toEqual([
            '10.0.0.0/24',
            '10.0.0.9',
            '10.0.0.10',
            'fd00::1',
        ]);
    });
});

describe('groupNatRules', () => {
    it('folds the per-pod SNAT rows on GR_cnv-1 into one group in the node subnet', () => {
        const nats = natsOf('GR_cnv-1');
        const views = groupNatRules(nats, candidateSubnets(database));
        // The pods' rows fold; the router's own join address stays a row.
        expect(views).toHaveLength(2);
        const [group, join] = views;
        expect(group.kind).toBe('group');
        if (group.kind !== 'group') return;
        expect(group.externalIp).toBe('192.168.4.72');
        expect(group.rules).toHaveLength(nats.length - 1);
        expect(group.coveringSubnet).toBe('10.131.0.0/23');
        expect(join.kind === 'rule' && join.rule.logicalIp).toBe('100.64.0.5');
        expect([...group.logicalIps].sort(comparePrefixes)).toEqual(group.logicalIps);
        // Some rows carry a source port range and some do not: the group
        // reports the range with its share instead of splitting.
        const ranged = group.rules.filter((nat) => nat.externalPortRange).length;
        expect(ranged).toBeGreaterThan(0);
        expect(ranged).toBeLessThan(group.rules.length);
        expect(group.portRanges).toEqual([{ range: '32768-60999', count: ranged }]);
    });

    it('never folds dnat_and_snat or dnat rows, and lists them after the groups', () => {
        const views = groupNatRules([
            snat('10.0.0.2'),
            { uuid: 'fip', type: 'dnat_and_snat', externalIp: '192.0.2.50', logicalIp: '10.0.0.9' },
            snat('10.0.0.1'),
            { uuid: 'd1', type: 'dnat', externalIp: '192.0.2.60', logicalIp: '10.0.0.8' },
            { uuid: 'd2', type: 'dnat', externalIp: '192.0.2.60', logicalIp: '10.0.0.7' },
        ]);
        expect(views.map((view) => (view.kind === 'group' ? `group:${view.rules.length}` : view.rule.uuid))).toEqual([
            'group:2',
            'fip',
            'd2',
            'd1',
        ]);
    });

    it('keeps SNAT rows apart when anything but the logical IP sets them apart', () => {
        const views = groupNatRules([
            snat('10.0.0.1'),
            snat('10.0.0.2'),
            snat('10.0.0.3', { match: 'ip4.dst == 1.1.1.1' }),
            snat('10.0.0.4', { priority: 5 }),
            snat('10.0.0.0/24'),
            snat('10.0.0.5', { logicalPort: 'p' }),
            snat('10.0.0.6', { gatewayPort: 'lrp-a' }),
            snat('10.0.0.7', { externalIp: '192.0.2.2' }),
        ]);
        const groups = views.filter((view) => view.kind === 'group');
        expect(groups).toHaveLength(1);
        expect(views).toHaveLength(7);
    });

    it('splits groups by gateway port and orders larger groups first', () => {
        const views = groupNatRules([
            snat('10.0.0.1', { gatewayPort: 'a' }),
            snat('10.0.0.2', { gatewayPort: 'a' }),
            snat('10.0.1.1', { gatewayPort: 'b' }),
            snat('10.0.1.2', { gatewayPort: 'b' }),
            snat('10.0.1.3', { gatewayPort: 'b' }),
        ]);
        expect(views.map((view) => (view.kind === 'group' ? view.gatewayPort : undefined))).toEqual(['b', 'a']);
    });

    it('splits a bucket by the narrowest known subnet and names it on the group', () => {
        const views = groupNatRules(
            [snat('10.0.0.1'), snat('10.0.1.200'), snat('10.0.4.1'), snat('10.0.4.2'), snat('100.64.0.5')],
            ['10.0.0.1/23', '10.0.0.1/16', '100.64.0.5/16'],
        );
        expect(
            views.map((view) => (view.kind === 'group' ? `${view.coveringSubnet}:${view.rules.length}` : view.rule.logicalIp)),
        ).toEqual(['10.0.0.0/23:2', '10.0.0.0/16:2', '100.64.0.5']);
        const unknown = groupNatRules([snat('10.0.0.1'), snat('10.0.0.2')]);
        expect(unknown[0].kind === 'group' && unknown[0].coveringSubnet).toBeUndefined();
    });

    it('counts rules per type in display order', () => {
        expect(
            natTypeCounts([snat('10.0.0.1'), snat('10.0.0.2'), { uuid: 'f', type: 'dnat_and_snat' }]),
        ).toEqual([
            { type: 'dnat_and_snat', count: 1 },
            { type: 'snat', count: 2 },
        ]);
    });
});

describe('podAddressIndex', () => {
    it('resolves a pod address from Logical_Switch_Port addresses', () => {
        const ownerOf = podAddressIndex(database);
        expect(ownerOf('10.131.1.193')).toEqual({
            namespace: 'hive',
            pod: 'hiveadmission-6b44465788-fnxq7',
            port: 'hive_hiveadmission-6b44465788-fnxq7',
        });
        expect(ownerOf('10.131.1.193/32')?.pod).toBe('hiveadmission-6b44465788-fnxq7');
        expect(ownerOf('203.0.113.1')).toBeUndefined();
    });

    it('resolves nothing when two pod ports claim the address', () => {
        const ownerOf = podAddressIndex({
            ...database,
            logicalSwitchPorts: [
                { uuid: 'a', name: 'ns_a', addresses: ['0a:58:00:00:00:01 10.9.0.1'] },
                { uuid: 'b', name: 'net_ns_b', addresses: ['0a:58:00:00:00:02 10.9.0.1'] },
            ],
        });
        expect(ownerOf('10.9.0.1')).toBeUndefined();
    });
});

describe('groupStaticRoutes', () => {
    it('puts dst-ip routes before src-ip routes and the default route first', () => {
        const groups = groupStaticRoutes([
            { uuid: '1', ipPrefix: '10.128.0.0/14', nexthop: '100.64.0.5', policy: 'src-ip' },
            { uuid: '2', ipPrefix: '10.130.0.0/23', nexthop: '100.88.0.4' },
            { uuid: '3', ipPrefix: '0.0.0.0/0', nexthop: '192.168.4.1' },
            { uuid: '4', ipPrefix: '10.128.0.0/23', nexthop: '100.88.0.2', policy: 'dst-ip' },
            { uuid: '5', ipPrefix: '10.0.0.0/8', nexthop: '10.1.1.1', routeTable: 'rt-blue' },
        ]);
        expect(groups.map((group) => group.policy)).toEqual(['dst-ip', 'src-ip']);
        expect(groups[0].routes.map((route) => route.uuid)).toEqual(['3', '4', '2', '5']);
        expect(groups[1].routes.map((route) => route.uuid)).toEqual(['1']);
    });

    it('omits an empty group', () => {
        expect(groupStaticRoutes([{ uuid: '1', ipPrefix: '0.0.0.0/0' }]).map((g) => g.policy)).toEqual(['dst-ip']);
    });
});

describe('nexthopResolverFor', () => {
    it('resolves a transit next hop on ovn_cluster_router to the remote node', () => {
        const resolve = nexthopResolverFor(database, 'ovn_cluster_router');
        const route = routesOf('ovn_cluster_router').find((r) => r.ipPrefix === '10.130.0.0/23')!;
        expect(resolve(route)).toEqual({ kind: 'node', node: 'ctrl-3', port: 'tstor-ctrl-3', via: 'rtots-cnv-1' });
    });

    it('resolves a join next hop to the gateway router port', () => {
        const resolve = nexthopResolverFor(database, 'ovn_cluster_router');
        const route = routesOf('ovn_cluster_router').find((r) => r.policy === 'src-ip')!;
        expect(resolve(route)).toEqual({
            kind: 'router-port',
            port: 'rtoj-GR_cnv-1',
            router: 'GR_cnv-1',
            via: 'rtoj-ovn_cluster_router',
        });
    });

    it('falls back to the on-link port when the owner is outside the database', () => {
        const resolve = nexthopResolverFor(database, 'GR_cnv-1');
        const route = routesOf('GR_cnv-1').find((r) => r.ipPrefix === '0.0.0.0/0')!;
        expect(resolve(route)).toEqual({ kind: 'on-link', via: 'rtoe-GR_cnv-1' });
    });

    it('resolves nothing without a database or a next hop', () => {
        expect(nexthopResolverFor(null, 'x')({ uuid: 'r', ipPrefix: '0.0.0.0/0', nexthop: '1.1.1.1' })).toBeUndefined();
        expect(nexthopResolverFor(database, 'GR_cnv-1')({ uuid: 'r', ipPrefix: '0.0.0.0/0' })).toBeUndefined();
    });
});
