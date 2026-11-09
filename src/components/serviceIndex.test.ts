import { LoadBalancerRow, LogicalDatabase, LogicalTopologySnapshot } from '../types';
import {
    attachmentSummaryText,
    hasServicesSection,
    loadBalancersFor,
    scopeOf,
    serviceIndexFor,
    serviceOf,
    serviceVipRowMatches,
    serviceVipRows,
    splitBackends,
    summarizeAttachment,
} from './serviceIndex';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';
import ctrl1 from '../../collector/fixtures/snapshots/ctrl-1.json';

const cnv1Db = (cnv1 as unknown as LogicalTopologySnapshot).database as LogicalDatabase;
const ctrl1Db = (ctrl1 as unknown as LogicalTopologySnapshot).database as LogicalDatabase;

const lb = (overrides: Partial<LoadBalancerRow> & { uuid: string; name: string }): LoadBalancerRow => ({
    protocol: 'tcp',
    vips: {},
    externalIds: { 'k8s.ovn.org/kind': 'Service', 'k8s.ovn.org/owner': 'shop/web' },
    ...overrides,
});

/** A small zone: a node switch and its gateway router sharing one group and
 * one direct load balancer each way, plus a UDN switch on empty groups. */
const database = (): LogicalDatabase => ({
    logicalRouters: [
        { uuid: 'gr', name: 'GR_node-a', ports: [], loadBalancer: ['lb-both', 'lb-router'], loadBalancerGroup: ['g-cluster', 'g-router'] },
        { uuid: 'ocr', name: 'ovn_cluster_router', ports: [] },
    ],
    logicalRouterPorts: [],
    logicalSwitches: [
        { uuid: 'sw', name: 'node-a', ports: [], loadBalancer: ['lb-both', 'lb-switch'], loadBalancerGroup: ['g-cluster', 'g-switch'] },
        { uuid: 'udn', name: 'blue_ovn_layer2_switch', ports: [], loadBalancerGroup: ['g-blue', 'g-blue-switch'] },
        { uuid: 'join', name: 'join', ports: [] },
    ],
    logicalSwitchPorts: [],
    nats: [],
    staticRoutes: [],
    loadBalancers: [
        lb({
            uuid: 'lb-web',
            name: 'Service_shop/web_TCP_cluster',
            vips: {
                '172.30.80.5:443': '10.129.5.152:10443,10.130.2.9:10443',
                '172.30.80.5:8080': '',
                '[fd02::5a3c]:443': '[fd01:0:0:5::98]:10443',
            },
            options: { affinity_timeout: '10800', reject: 'true' },
        }),
        lb({
            uuid: 'lb-dns-udp',
            name: 'Service_openshift-dns/dns-default_UDP_cluster',
            protocol: 'udp',
            vips: { '172.30.0.10:53': '10.128.0.5:5353' },
            externalIds: { 'k8s.ovn.org/kind': 'Service', 'k8s.ovn.org/owner': 'openshift-dns/dns-default' },
        }),
        lb({
            uuid: 'lb-dns-tcp',
            name: 'Service_openshift-dns/dns-default_TCP_cluster',
            vips: { '172.30.0.10:53': '10.128.0.5:5353' },
            externalIds: { 'k8s.ovn.org/kind': 'Service', 'k8s.ovn.org/owner': 'openshift-dns/dns-default' },
        }),
        lb({
            uuid: 'lb-both',
            name: 'Service_default/kubernetes_TCP_node_router+switch_node-a',
            vips: { '172.30.0.1:443': '192.168.4.10:6443,192.168.4.11:6443' },
            externalIds: { 'k8s.ovn.org/kind': 'Service', 'k8s.ovn.org/owner': 'default/kubernetes' },
        }),
        lb({
            uuid: 'lb-router',
            name: 'Service_shop/nodeport_TCP_node_router_node-a',
            vips: { '192.168.4.10:30080': '10.129.5.152:8080' },
            externalIds: { 'k8s.ovn.org/kind': 'Service', 'k8s.ovn.org/owner': 'shop/nodeport' },
        }),
        lb({
            uuid: 'lb-switch',
            name: 'Service_shop/nodeport_TCP_node_switch_node-a',
            vips: { '192.168.4.10:30080': '10.129.5.152:8080' },
            externalIds: { 'k8s.ovn.org/kind': 'Service', 'k8s.ovn.org/owner': 'shop/nodeport' },
        }),
    ],
    loadBalancerGroups: [
        { uuid: 'g-cluster', name: 'clusterLBGroup', loadBalancers: ['lb-web', 'lb-dns-udp', 'lb-dns-tcp'] },
        { uuid: 'g-switch', name: 'clusterSwitchLBGroup', loadBalancers: [] },
        { uuid: 'g-router', name: 'clusterRouterLBGroup', loadBalancers: [] },
        { uuid: 'g-blue', name: 'blue_clusterLBGroup', loadBalancers: [] },
        { uuid: 'g-blue-switch', name: 'blue_clusterSwitchLBGroup', loadBalancers: [] },
    ],
});

/** The database as a request without include=services returns it. */
const withoutServices = (full: LogicalDatabase): LogicalDatabase => {
    const ladder = { ...full };
    delete ladder.loadBalancers;
    delete ladder.loadBalancerGroups;
    return ladder;
};

const nodeSwitch = { kind: 'switch', uuid: 'sw', name: 'node-a' };
const gatewayRouter = { kind: 'router', uuid: 'gr', name: 'GR_node-a' };
const udnSwitch = { kind: 'switch', uuid: 'udn', name: 'blue_ovn_layer2_switch' };

describe('serviceIndex', () => {
    describe('splitBackends', () => {
        it('splits the stored comma-separated list', () => {
            expect(splitBackends('10.129.5.152:10443,10.130.2.9:10443')).toEqual([
                '10.129.5.152:10443',
                '10.130.2.9:10443',
            ]);
            expect(splitBackends('[fd01::98]:10443')).toEqual(['[fd01::98]:10443']);
        });

        it('reads an empty value as no backends, not one empty backend', () => {
            expect(splitBackends('')).toEqual([]);
            expect(splitBackends(undefined)).toEqual([]);
        });
    });

    describe('serviceOf', () => {
        it('splits the owner at the first slash and keeps the kind', () => {
            expect(serviceOf(lb({ uuid: 'a', name: 'a' }))).toEqual({ kind: 'Service', namespace: 'shop', name: 'web' });
            expect(
                serviceOf(lb({ uuid: 'a', name: 'a', externalIds: { 'k8s.ovn.org/owner': 'ns/odd/name' } })),
            ).toEqual({ kind: undefined, namespace: 'ns', name: 'odd/name' });
        });

        it('is undefined for a row without a usable owner', () => {
            expect(serviceOf(lb({ uuid: 'a', name: 'a', externalIds: {} }))).toBeUndefined();
            expect(serviceOf(lb({ uuid: 'a', name: 'a', externalIds: undefined }))).toBeUndefined();
            expect(serviceOf(lb({ uuid: 'a', name: 'a', externalIds: { 'k8s.ovn.org/owner': 'no-slash' } }))).toBeUndefined();
            expect(serviceOf(lb({ uuid: 'a', name: 'a', externalIds: { 'k8s.ovn.org/owner': 'trailing/' } }))).toBeUndefined();
        });
    });

    describe('scopeOf', () => {
        const scope = (name: string) => scopeOf(lb({ uuid: 'a', name }));

        it('parses the four name suffixes ovn-kubernetes writes', () => {
            expect(scope('Service_c9s/clabernetes-http_TCP_cluster')).toEqual({ scope: 'cluster' });
            expect(scope('Service_default/kubernetes_TCP_node_router+switch_cnv-1')).toEqual({
                scope: 'node_router+switch',
                node: 'cnv-1',
            });
            expect(scope('Service_openshift-dns/dns-default_UDP_node_router_ctrl-1')).toEqual({
                scope: 'node_router',
                node: 'ctrl-1',
            });
            expect(scope('Service_openshift-dns/dns-default_UDP_node_switch_ctrl-1')).toEqual({
                scope: 'node_switch',
                node: 'ctrl-1',
            });
        });

        it('keeps a node name that carries dots', () => {
            expect(scope('Service_a/b_TCP_node_switch_worker-0.example.test')).toEqual({
                scope: 'node_switch',
                node: 'worker-0.example.test',
            });
        });

        it('returns unknown for a name outside the scheme instead of throwing', () => {
            expect(scope('lb-from-another-cms')).toEqual({ scope: 'unknown' });
            expect(scope('')).toEqual({ scope: 'unknown' });
            expect(scope('Service_a/b_TCP_node_switch_')).toEqual({ scope: 'unknown' });
            expect(scopeOf({ uuid: 'a', vips: {} } as unknown as LoadBalancerRow)).toEqual({ scope: 'unknown' });
        });
    });

    describe('serviceIndexFor', () => {
        it('is undefined without the services section', () => {
            const ladder = withoutServices(database());
            expect(serviceIndexFor(ladder)).toBeUndefined();
            expect(serviceIndexFor(null)).toBeUndefined();
            expect(hasServicesSection(ladder)).toBe(false);
            // Half a section (one table failed to collect) is not a section.
            expect(serviceIndexFor({ ...ladder, loadBalancers: [] })).toBeUndefined();
        });

        it('treats collected, empty tables as a present section', () => {
            const empty = { ...database(), loadBalancers: [], loadBalancerGroups: [] };
            expect(serviceIndexFor(empty)?.lbByUuid.size).toBe(0);
        });

        it('is built once per database object', () => {
            const db = database();
            expect(serviceIndexFor(db)).toBe(serviceIndexFor(db));
            expect(serviceIndexFor(database())).not.toBe(serviceIndexFor(db));
        });

        it('answers which Service a VIP belongs to', () => {
            const index = serviceIndexFor(database())!;
            const [entry] = index.vipIndex.get('172.30.80.5:443')!;
            expect(entry.service).toEqual({ kind: 'Service', namespace: 'shop', name: 'web' });
            expect(entry.loadBalancer.uuid).toBe('lb-web');
            expect(entry.backends).toEqual(['10.129.5.152:10443', '10.130.2.9:10443']);

            expect(index.vipIndex.get('172.30.80.5:8080')![0].backends).toEqual([]);
            expect(index.vipIndex.get('[fd02::5a3c]:443')![0].backends).toEqual(['[fd01:0:0:5::98]:10443']);
            expect(index.vipIndex.get('10.0.0.1:1')).toBeUndefined();
        });

        it('keeps every load balancer that carries the same VIP and port', () => {
            // DNS answers on 53/tcp and 53/udp: two rows, one vips key.
            const entries = serviceIndexFor(database())!.vipIndex.get('172.30.0.10:53')!;
            expect(entries.map((entry) => entry.loadBalancer.protocol).sort()).toEqual(['tcp', 'udp']);
            expect(new Set(entries.map((entry) => entry.service?.name))).toEqual(new Set(['dns-default']));
        });
    });

    describe('loadBalancersFor', () => {
        it('separates direct load balancers from group members', () => {
            const attachment = loadBalancersFor(nodeSwitch, database())!;
            expect(attachment.direct.map((row) => row.uuid)).toEqual(['lb-both', 'lb-switch']);
            expect(attachment.viaGroups.map(({ group, members }) => [group.name, members.length])).toEqual([
                ['clusterLBGroup', 3],
                ['clusterSwitchLBGroup', 0],
            ]);
        });

        it('gives the union of direct and group members as the construct\'s set', () => {
            const summary = summarizeAttachment(loadBalancersFor(nodeSwitch, database())!);
            expect(summary.direct).toBe(2);
            expect(summary.total).toBe(5);
            expect(summary.groups).toEqual([
                { name: 'clusterLBGroup', count: 3 },
                { name: 'clusterSwitchLBGroup', count: 0 },
            ]);
            expect(summary.vipsWithoutEndpoints).toBe(1);
        });

        it('counts a load balancer attached both ways once', () => {
            const db = database();
            db.loadBalancerGroups![0].loadBalancers.push('lb-both');
            const attachment = loadBalancersFor(nodeSwitch, db)!;
            expect(summarizeAttachment(attachment).total).toBe(5);
            const row = serviceVipRows(attachment).find((candidate) => candidate.loadBalancer.uuid === 'lb-both')!;
            expect(row.sources).toEqual(['direct', 'clusterLBGroup']);
        });

        it('resolves routers from their own table', () => {
            const attachment = loadBalancersFor(gatewayRouter, database())!;
            expect(attachment.direct.map((row) => row.uuid)).toEqual(['lb-both', 'lb-router']);
            expect(attachment.viaGroups.map(({ group }) => group.name)).toEqual(['clusterLBGroup', 'clusterRouterLBGroup']);
        });

        it('finds the row by name when the uuid belongs to another zone (cluster view)', () => {
            const attachment = loadBalancersFor({ kind: 'switch', uuid: 'switch:node-a', name: 'node-a' }, database());
            expect(attachment?.direct).toHaveLength(2);
        });

        it('lists empty groups rather than hiding them', () => {
            const attachment = loadBalancersFor(udnSwitch, database())!;
            expect(attachment.direct).toEqual([]);
            expect(attachment.viaGroups.map(({ group, members }) => [group.name, members.length])).toEqual([
                ['blue_clusterLBGroup', 0],
                ['blue_clusterSwitchLBGroup', 0],
            ]);
            expect(serviceVipRows(attachment)).toEqual([]);
        });

        it('returns nothing to resolve for a construct without references', () => {
            const attachment = loadBalancersFor({ kind: 'switch', uuid: 'join', name: 'join' }, database())!;
            expect(attachment).toEqual({ direct: [], viaGroups: [] });
        });

        it('is undefined without the section, for an unknown row, or for a non-NB construct', () => {
            const ladder = withoutServices(database());
            expect(loadBalancersFor(nodeSwitch, ladder)).toBeUndefined();
            expect(loadBalancersFor(nodeSwitch, undefined)).toBeUndefined();
            expect(loadBalancersFor({ kind: 'switch', uuid: 'x', name: 'elsewhere' }, database())).toBeUndefined();
            expect(loadBalancersFor({ kind: 'physnet', uuid: 'sw', name: 'node-a' }, database())).toBeUndefined();
        });

        it('skips references that do not resolve', () => {
            const db = database();
            db.logicalSwitches[0].loadBalancer!.push('gone');
            db.logicalSwitches[0].loadBalancerGroup!.push('gone-group');
            db.loadBalancerGroups![0].loadBalancers.push('gone-member');
            const attachment = loadBalancersFor(nodeSwitch, db)!;
            expect(attachment.direct).toHaveLength(2);
            expect(attachment.viaGroups).toHaveLength(2);
            expect(attachment.viaGroups[0].members).toHaveLength(3);
        });
    });

    describe('serviceVipRows', () => {
        const rows = () => serviceVipRows(loadBalancersFor(nodeSwitch, database())!);

        it('emits one row per VIP, sorted by Service', () => {
            expect(rows().map((row) => `${row.service?.namespace}/${row.service?.name} ${row.protocol} ${row.vip}`)).toEqual([
                'default/kubernetes tcp 172.30.0.1:443',
                'openshift-dns/dns-default tcp 172.30.0.10:53',
                'openshift-dns/dns-default udp 172.30.0.10:53',
                'shop/nodeport tcp 192.168.4.10:30080',
                // Collation puts the bracketed IPv6 key ahead of the digits.
                'shop/web tcp [fd02::5a3c]:443',
                'shop/web tcp 172.30.80.5:443',
                'shop/web tcp 172.30.80.5:8080',
            ]);
        });

        it('carries scope, node, source and split backends', () => {
            const byVip = (vip: string) => rows().find((row) => row.vip === vip)!;
            expect(byVip('172.30.0.1:443')).toMatchObject({
                scope: 'node_router+switch',
                node: 'node-a',
                sources: ['direct'],
                backends: ['192.168.4.10:6443', '192.168.4.11:6443'],
            });
            expect(byVip('172.30.80.5:8080')).toMatchObject({ scope: 'cluster', sources: ['clusterLBGroup'], backends: [] });
        });

        it('defaults an unset protocol to tcp and keeps a load balancer without VIPs visible', () => {
            const db = database();
            db.loadBalancers!.push({ uuid: 'lb-bare', name: 'bare', vips: {} });
            db.logicalSwitches[0].loadBalancer!.push('lb-bare');
            const bare = serviceVipRows(loadBalancersFor(nodeSwitch, db)!).find((row) => row.loadBalancer.uuid === 'lb-bare')!;
            expect(bare).toMatchObject({ protocol: 'tcp', vip: '', backends: [], scope: 'unknown' });
            expect(bare.service).toBeUndefined();
            // A VIP-less row is not a VIP without endpoints.
            expect(summarizeAttachment(loadBalancersFor(nodeSwitch, db)!).vipsWithoutEndpoints).toBe(1);
        });

        it('filters by Service, VIP and backend', () => {
            const match = (query: string) => rows().filter((row) => serviceVipRowMatches(row, query)).map((row) => row.vip);
            expect(match('dns-default')).toEqual(['172.30.0.10:53', '172.30.0.10:53']);
            expect(match('172.30.80.5:443')).toEqual(['172.30.80.5:443']);
            expect(match('10.129.5.152')).toEqual(['192.168.4.10:30080', '172.30.80.5:443']);
            expect(match('fd02::5a3c')).toEqual(['[fd02::5a3c]:443']);
            expect(match('no-such-thing')).toEqual([]);
        });
    });

    describe('attachmentSummaryText', () => {
        it('reads direct and per-group counts', () => {
            expect(attachmentSummaryText(summarizeAttachment(loadBalancersFor(nodeSwitch, database())!))).toBe(
                '2 direct · 3 via clusterLBGroup · 0 via clusterSwitchLBGroup',
            );
        });

        it('says which groups are empty when nothing is programmed', () => {
            expect(attachmentSummaryText(summarizeAttachment(loadBalancersFor(udnSwitch, database())!))).toBe(
                '0 load balancers; groups blue_clusterLBGroup and blue_clusterSwitchLBGroup are empty',
            );
            expect(attachmentSummaryText({ direct: 0, groups: [{ name: 'g', count: 0 }], total: 0, vipsWithoutEndpoints: 0 })).toBe(
                '0 load balancers; group g is empty',
            );
            expect(attachmentSummaryText({ direct: 0, groups: [], total: 0, vipsWithoutEndpoints: 0 })).toBe('0 load balancers');
        });
    });

    describe('over the captured corpus', () => {
        const nodeSwitchOf = (db: LogicalDatabase, name: string) =>
            loadBalancersFor({ kind: 'switch', uuid: db.logicalSwitches.find((row) => row.name === name)!.uuid, name }, db)!;

        it('resolves every reference the node switch and gateway router carry', () => {
            const row = cnv1Db.logicalSwitches.find((candidate) => candidate.name === 'cnv-1')!;
            const attachment = nodeSwitchOf(cnv1Db, 'cnv-1');
            expect(attachment.direct).toHaveLength(row.loadBalancer!.length);
            expect(attachment.viaGroups).toHaveLength(row.loadBalancerGroup!.length);

            const summary = summarizeAttachment(attachment);
            const cluster = summary.groups.find((group) => group.name === 'clusterLBGroup')!;
            expect(cluster.count).toBeGreaterThan(300);
            // No load balancer is both direct and in a group on a real zone.
            expect(summary.total).toBe(summary.direct + cluster.count);
            expect(summary.vipsWithoutEndpoints).toBeGreaterThan(0);
        });

        it('sees the same cluster-scoped rows in every zone and different node-scoped ones', () => {
            const names = (db: LogicalDatabase, node: string, scope: 'cluster' | 'node') =>
                serviceVipRows(nodeSwitchOf(db, node))
                    .filter((row) => (scope === 'cluster' ? row.scope === 'cluster' : row.scope !== 'cluster'))
                    .map((row) => row.loadBalancer.name)
                    .sort();
            expect(names(cnv1Db, 'cnv-1', 'cluster')).toEqual(names(ctrl1Db, 'ctrl-1', 'cluster'));
            expect(names(cnv1Db, 'cnv-1', 'node')).not.toEqual(names(ctrl1Db, 'ctrl-1', 'node'));
            expect(serviceVipRows(nodeSwitchOf(cnv1Db, 'cnv-1')).every((row) => row.scope !== 'unknown')).toBe(true);
            expect(
                serviceVipRows(nodeSwitchOf(cnv1Db, 'cnv-1'))
                    .filter((row) => row.scope !== 'cluster')
                    .every((row) => row.node === 'cnv-1'),
            ).toBe(true);
        });

        it('shows a layer2 UDN switch its empty per-network groups', () => {
            const summary = summarizeAttachment(nodeSwitchOf(cnv1Db, 'cluster_udn_example.p.cudn_ovn_layer2_switch'));
            expect(attachmentSummaryText(summary)).toBe(
                '0 load balancers; groups cluster_udn_example.p.cudn_clusterLBGroup and ' +
                    'cluster_udn_example.p.cudn_clusterSwitchLBGroup are empty',
            );
        });

        it('maps the cluster DNS VIP to its Service over both protocols', () => {
            const entries = serviceIndexFor(cnv1Db)!.vipIndex.get('172.30.0.10:53')!;
            expect(new Set(entries.map((entry) => `${entry.service?.namespace}/${entry.service?.name}`))).toEqual(
                new Set(['openshift-dns/dns-default']),
            );
            expect(new Set(entries.map((entry) => entry.loadBalancer.protocol))).toEqual(new Set(['tcp', 'udp']));
        });
    });
});
