import { LoadBalancerRow, LogicalDatabase, LogicalTopologySnapshot, LookupHit } from '../types';
import {
    attachmentSummaryText,
    declaredVipClass,
    groupServices,
    hasServicesSection,
    inferVipClass,
    isLookupAddress,
    KubeServiceLike,
    loadBalancersFor,
    parseVip,
    podOwnerFromLookup,
    scopeOf,
    sectionOf,
    serviceFacetCounts,
    serviceGroupMatches,
    serviceIndexFor,
    serviceOf,
    serviceVipRows,
    splitBackends,
    splitSummaryText,
    summarizeAttachment,
    summarizeSplit,
    vipClassContext,
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

/**
 * A zone for the one-row-per-Service view (ovn-recon-dp7.6), on documentation
 * addresses: the node at 192.0.2.10 on 192.0.2.0/24 with a second address
 * 198.51.100.10 that only its node ports reveal, a service network of
 * 172.30.0.0/16, and a LoadBalancer address 192.0.2.200.
 */
const splitDatabase = (): LogicalDatabase => ({
    logicalRouters: [
        {
            uuid: 'gr',
            name: 'GR_node-a',
            ports: ['rtoe'],
            loadBalancer: ['lb-api', 'lb-shop-np', 'lb-dns-router'],
            loadBalancerGroup: ['g-cluster'],
            externalIds: { physical_ip: '192.0.2.10', physical_ips: '192.0.2.10' },
        },
    ],
    logicalRouterPorts: [
        { uuid: 'rtoe', name: 'rtoe-GR_node-a', networks: ['192.0.2.10/24'], externalIds: { 'gateway-physical-ip': 'yes' } },
    ],
    logicalSwitches: [
        {
            uuid: 'sw',
            name: 'node-a',
            ports: [],
            loadBalancer: ['lb-api', 'lb-shop-np', 'lb-dns-switch', 'lb-etp-local'],
            loadBalancerGroup: ['g-cluster', 'g-switch'],
        },
    ],
    logicalSwitchPorts: [],
    nats: [],
    staticRoutes: [
        { uuid: 'masq', ipPrefix: '169.254.0.0/17', nexthop: '169.254.0.4', externalIds: { 'k8s.ovn.org/node-masquerade-subnet': '' } },
    ],
    loadBalancers: [
        lb({
            uuid: 'lb-api',
            name: 'Service_default/kubernetes_TCP_node_router+switch_node-a',
            vips: { '172.30.0.1:443': '192.0.2.11:6443,192.0.2.12:6443' },
            externalIds: { 'k8s.ovn.org/kind': 'Service', 'k8s.ovn.org/owner': 'default/kubernetes' },
        }),
        lb({
            uuid: 'lb-shop-np',
            name: 'Service_shop/web_TCP_node_router+switch_node-a',
            vips: {
                '192.0.2.10:30443': '10.129.0.5:8443',
                '198.51.100.10:30443': '10.129.0.5:8443',
            },
        }),
        lb({
            uuid: 'lb-shop',
            name: 'Service_shop/web_TCP_cluster',
            vips: {
                '172.30.80.5:443': '10.129.0.5:8443,10.130.0.9:8443',
                '172.30.80.5:80': '10.129.0.5:8080,10.130.0.9:8080',
                '192.0.2.200:443': '10.129.0.5:8443,10.130.0.9:8443',
                '[fd02::5]:443': '[fd01::5]:8443',
            },
            options: { affinity_timeout: '10800', reject: 'true' },
        }),
        lb({
            uuid: 'lb-ext',
            name: 'Service_shop/legacy_TCP_cluster',
            vips: { '172.30.90.9:8080': '', '203.0.113.7:8080': '' },
            externalIds: { 'k8s.ovn.org/kind': 'Service', 'k8s.ovn.org/owner': 'shop/legacy' },
        }),
        lb({
            uuid: 'lb-dns-udp',
            name: 'Service_openshift-dns/dns-default_UDP_cluster',
            protocol: 'udp',
            vips: { '172.30.0.10:53': '10.128.0.5:5353' },
            externalIds: { 'k8s.ovn.org/kind': 'Service', 'k8s.ovn.org/owner': 'openshift-dns/dns-default' },
        }),
        lb({
            uuid: 'lb-dns-switch',
            name: 'Service_openshift-dns/dns-default_TCP_node_switch_node-a',
            vips: { '172.30.0.10:53': '10.128.0.5:5353' },
            externalIds: { 'k8s.ovn.org/kind': 'Service', 'k8s.ovn.org/owner': 'openshift-dns/dns-default' },
        }),
        lb({
            uuid: 'lb-dns-router',
            name: 'Service_openshift-dns/dns-default_TCP_node_router_node-a',
            vips: { '172.30.0.10:53': '10.128.0.5:5353' },
            externalIds: { 'k8s.ovn.org/kind': 'Service', 'k8s.ovn.org/owner': 'openshift-dns/dns-default' },
        }),
        lb({
            uuid: 'lb-etp-local',
            name: 'Service_shop/local_TCP_node_switch_node-a',
            vips: { '169.254.0.3:31000': '10.129.0.7:80' },
            externalIds: { 'k8s.ovn.org/kind': 'Service', 'k8s.ovn.org/owner': 'shop/local' },
        }),
        lb({
            uuid: 'lb-tmpl',
            name: 'Service_shop/tmpl_TCP_node_switch_template_IPv4',
            vips: { '^NODEIP_IPv4_0:32000': '^shop_tmpl_TCP_32000_v4' },
            externalIds: { 'k8s.ovn.org/kind': 'Service', 'k8s.ovn.org/owner': 'shop/tmpl' },
        }),
    ],
    loadBalancerGroups: [
        { uuid: 'g-cluster', name: 'clusterLBGroup', loadBalancers: ['lb-shop', 'lb-ext', 'lb-dns-udp'] },
        { uuid: 'g-switch', name: 'clusterSwitchLBGroup', loadBalancers: ['lb-tmpl'] },
    ],
});

const SERVICE_NETWORKS = ['172.30.0.0/16', 'fd02::/112'];

describe('serviceIndex one row per Service (dp7.6)', () => {
    const splitSwitch = { kind: 'switch', uuid: 'sw', name: 'node-a' };
    const splitRouter = { kind: 'router', uuid: 'gr', name: 'GR_node-a' };

    describe('parseVip', () => {
        it('splits IPv4, bracketed IPv6, bare and template keys', () => {
            expect(parseVip('172.30.0.1:443')).toEqual({ address: '172.30.0.1', port: 443 });
            expect(parseVip('[fd02::5]:443')).toEqual({ address: 'fd02::5', port: 443 });
            expect(parseVip('[fd02::5]')).toEqual({ address: 'fd02::5' });
            expect(parseVip('172.30.0.1')).toEqual({ address: '172.30.0.1' });
            expect(parseVip('fd02::5')).toEqual({ address: 'fd02::5' });
            expect(parseVip('^NODEIP_IPv4_0:32000')).toEqual({ address: '^NODEIP_IPv4_0', port: 32000 });
        });
    });

    describe('vipClassContext', () => {
        it("learns the node's addresses from physical_ips, the external port and shared node ports", () => {
            const context = vipClassContext(splitDatabase(), SERVICE_NETWORKS);
            const nodePort = (address: string) =>
                inferVipClass(`${address}:30443`, 'node_router+switch', 'shop/web', context).vipClass;
            expect(nodePort('192.0.2.10')).toBe('NodePort');
            // Not on any router: known only because it carries the same node
            // port as 192.0.2.10 on the same node-scoped load balancer.
            expect(nodePort('198.51.100.10')).toBe('NodePort');
            expect(context.externalSubnets).toHaveLength(1);
            expect([...context.servicesWithNodePorts].sort()).toEqual(['shop/local', 'shop/tmpl', 'shop/web']);
        });

        it('does not take the service network or the masquerade range for node addresses', () => {
            const db = splitDatabase();
            db.logicalRouters[0].externalIds!.physical_ips = '192.0.2.10,169.254.0.15';
            const context = vipClassContext(db, SERVICE_NETWORKS);
            expect(context.nodeAddresses.size).toBe(2);
        });
    });

    describe('inferVipClass', () => {
        const context = vipClassContext(splitDatabase(), SERVICE_NETWORKS);
        const infer = (vip: string, scope: Parameters<typeof inferVipClass>[1], service: string) =>
            inferVipClass(vip, scope, service, context);

        it('reads a service-network address as a ClusterIP, on either scope and family', () => {
            expect(infer('172.30.80.5:443', 'cluster', 'shop/web')).toMatchObject({ vipClass: 'ClusterIP', basis: 'inferred' });
            expect(infer('[fd02::5]:443', 'cluster', 'shop/web').vipClass).toBe('ClusterIP');
            // Host-network endpoints put a ClusterIP on a node-scoped row.
            expect(infer('172.30.0.1:443', 'node_router+switch', 'default/kubernetes').vipClass).toBe('ClusterIP');
        });

        it('reads node, masquerade and template addresses as node ports', () => {
            expect(infer('192.0.2.10:30443', 'node_router+switch', 'shop/web').vipClass).toBe('NodePort');
            expect(infer('169.254.0.3:31000', 'node_switch', 'shop/local')).toMatchObject({
                vipClass: 'NodePort',
                reason: expect.stringContaining('masquerade'),
            });
            expect(infer('^NODEIP_IPv4_0:32000', 'unknown', 'shop/tmpl').vipClass).toBe('NodePort');
        });

        it('tells a LoadBalancer address from an ExternalIP by whether the Service has node ports', () => {
            expect(infer('192.0.2.200:443', 'cluster', 'shop/web')).toMatchObject({ vipClass: 'LoadBalancer', basis: 'inferred' });
            expect(infer('203.0.113.7:8080', 'cluster', 'shop/legacy').vipClass).toBe('ExternalIP');
            // A node address on a cluster-scoped row is an external IP someone
            // set to the node's address, not a node port.
            expect(infer('192.0.2.10:8080', 'cluster', 'shop/legacy').vipClass).toBe('ExternalIP');
        });

        it('without the service network, counts only the external subnet as external', () => {
            const fallback = vipClassContext(splitDatabase());
            expect(fallback.serviceNetworks).toHaveLength(0);
            expect(inferVipClass('192.0.2.200:443', 'cluster', 'shop/web', fallback).vipClass).toBe('LoadBalancer');
            expect(inferVipClass('172.30.80.5:443', 'cluster', 'shop/web', fallback)).toMatchObject({
                vipClass: 'ClusterIP',
                reason: expect.stringContaining('not known'),
            });
            // Outside every known subnet: indistinguishable from a ClusterIP.
            expect(inferVipClass('203.0.113.7:8080', 'cluster', 'shop/legacy', fallback).vipClass).toBe('ClusterIP');
        });
    });

    describe('declaredVipClass', () => {
        const web: KubeServiceLike = {
            spec: {
                type: 'LoadBalancer',
                clusterIPs: ['172.30.80.5', 'fd02:0:0:0::5'],
                externalIPs: ['203.0.113.9'],
                ports: [{ port: 443, nodePort: 30443, protocol: 'TCP' }],
            },
            status: { loadBalancer: { ingress: [{ ip: '192.0.2.200' }] } },
        };

        it('names each class from the Service, matching IPv6 by value', () => {
            expect(declaredVipClass('172.30.80.5:443', 'tcp', web)).toMatchObject({ vipClass: 'ClusterIP', basis: 'declared' });
            expect(declaredVipClass('[fd02::5]:443', 'tcp', web)?.vipClass).toBe('ClusterIP');
            expect(declaredVipClass('203.0.113.9:443', 'tcp', web)?.vipClass).toBe('ExternalIP');
            expect(declaredVipClass('192.0.2.200:443', 'tcp', web)?.vipClass).toBe('LoadBalancer');
            expect(declaredVipClass('198.51.100.10:30443', 'tcp', web)?.vipClass).toBe('NodePort');
        });

        it('says nothing for an address or port the Service does not name', () => {
            expect(declaredVipClass('198.51.100.10:30443', 'udp', web)).toBeUndefined();
            expect(declaredVipClass('10.0.0.1:443', 'tcp', web)).toBeUndefined();
            expect(declaredVipClass('172.30.80.5:443', 'tcp', { spec: { clusterIP: '172.30.80.5' } })?.vipClass).toBe(
                'ClusterIP',
            );
        });
    });

    describe('sectionOf', () => {
        it('puts direct node-scoped rows here and everything shared cluster-wide', () => {
            expect(sectionOf('node_switch', ['direct'])).toBe('node');
            expect(sectionOf('unknown', ['direct'])).toBe('node');
            expect(sectionOf('cluster', ['direct'])).toBe('cluster');
            expect(sectionOf('cluster', ['clusterLBGroup'])).toBe('cluster');
            // A template row parses as node-scoped but arrives through a group.
            expect(sectionOf('node_switch', ['clusterSwitchLBGroup'])).toBe('cluster');
        });
    });

    describe('groupServices', () => {
        const groups = (construct = splitSwitch, declared?: Map<string, KubeServiceLike>) =>
            groupServices(
                loadBalancersFor(construct, splitDatabase())!,
                vipClassContext(splitDatabase(), SERVICE_NETWORKS),
                declared,
            );
        const find = (list: ReturnType<typeof groups>, key: string) => list.find((group) => group.key === key)!;

        it('makes one row per Service and section, node section first', () => {
            expect(groups().map((group) => group.key)).toEqual([
                'node|default/kubernetes',
                'node|openshift-dns/dns-default',
                'node|shop/local',
                'node|shop/web',
                'cluster|openshift-dns/dns-default',
                'cluster|shop/legacy',
                'cluster|shop/tmpl',
                'cluster|shop/web',
            ]);
            // The gateway router sees its own node-scoped variant of DNS.
            expect(find(groups(splitRouter), 'node|openshift-dns/dns-default').loadBalancers.map((row) => row.uuid)).toEqual([
                'lb-dns-router',
            ]);
        });

        it('folds a Service with several ports, addresses and families into one row', () => {
            const web = find(groups(), 'cluster|shop/web');
            expect(web.vips.map((vip) => vip.vip)).toEqual([
                '172.30.80.5:80',
                '172.30.80.5:443',
                '192.0.2.200:443',
                '[fd02::5]:443',
            ]);
            expect(web.ports).toEqual([
                { port: 80, protocol: 'tcp' },
                { port: 443, protocol: 'tcp' },
            ]);
            expect(web.classes).toEqual([
                { vipClass: 'ClusterIP', inferred: true },
                { vipClass: 'LoadBalancer', inferred: true },
            ]);
            // Endpoints, not address:port pairs.
            expect(web.backendCount).toBe(3);
            expect(web.vipsWithoutEndpoints).toBe(0);
            expect(web.sources).toEqual(['clusterLBGroup']);

            const nodePorts = find(groups(), 'node|shop/web');
            expect(nodePorts.classes).toEqual([{ vipClass: 'NodePort', inferred: true }]);
            expect(nodePorts.ports).toEqual([{ port: 30443, protocol: 'tcp' }]);
        });

        it('merges protocols of one Service and counts VIPs without endpoints', () => {
            const dns = find(groups(), 'node|openshift-dns/dns-default');
            expect(dns.protocols).toEqual(['tcp']);
            expect(find(groups(), 'cluster|openshift-dns/dns-default').protocols).toEqual(['udp']);
            const legacy = find(groups(), 'cluster|shop/legacy');
            expect(legacy.vipsWithoutEndpoints).toBe(2);
            expect(legacy.backendCount).toBe(0);
        });

        it('switches a VIP to its declared class once the Service has been read', () => {
            const declared = new Map<string, KubeServiceLike>([
                ['shop/web', { spec: { type: 'NodePort', clusterIPs: ['172.30.80.5'], externalIPs: ['192.0.2.200'], ports: [{ port: 443, nodePort: 30443 }] } }],
            ]);
            const web = find(groups(splitSwitch, declared), 'cluster|shop/web');
            const classOf = (vip: string) => web.vips.find((entry) => entry.vip === vip)!.classification;
            expect(classOf('172.30.80.5:443')).toMatchObject({ vipClass: 'ClusterIP', basis: 'declared' });
            expect(classOf('192.0.2.200:443')).toMatchObject({ vipClass: 'ExternalIP', basis: 'declared' });
            // Not named by the Service (the IPv6 ClusterIP is missing from
            // this copy): stays inferred.
            expect(classOf('[fd02::5]:443')).toMatchObject({ vipClass: 'ClusterIP', basis: 'inferred' });
            expect(web.classes).toEqual([
                { vipClass: 'ClusterIP', inferred: true },
                { vipClass: 'ExternalIP', inferred: false },
            ]);
            expect(find(groups(splitSwitch, declared), 'node|shop/web').classes).toEqual([
                { vipClass: 'NodePort', inferred: false },
            ]);
        });
    });

    describe('facets', () => {
        const all = groupServices(
            loadBalancersFor(splitSwitch, splitDatabase())!,
            vipClassContext(splitDatabase(), SERVICE_NETWORKS),
        );
        const keys = (facets: Parameters<typeof serviceGroupMatches>[1]) =>
            all.filter((group) => serviceGroupMatches(group, facets)).map((group) => group.key);

        it('narrows by type, protocol, namespace and missing endpoints', () => {
            expect(keys({ vipClass: 'NodePort' })).toEqual(['node|shop/local', 'node|shop/web', 'cluster|shop/tmpl']);
            expect(keys({ vipClass: 'LoadBalancer' })).toEqual(['cluster|shop/web']);
            expect(keys({ protocol: 'udp' })).toEqual(['cluster|openshift-dns/dns-default']);
            expect(keys({ namespace: 'default' })).toEqual(['node|default/kubernetes']);
            expect(keys({ withoutEndpoints: true })).toEqual(['cluster|shop/legacy']);
        });

        it('asks the VIP facets of one VIP together', () => {
            // shop/legacy has an ExternalIP and a VIP without endpoints, and
            // they are the same VIP; shop/web's LoadBalancer VIP has endpoints.
            expect(keys({ vipClass: 'ExternalIP', withoutEndpoints: true })).toEqual(['cluster|shop/legacy']);
            expect(keys({ vipClass: 'LoadBalancer', withoutEndpoints: true })).toEqual([]);
            expect(keys({ vipClass: 'NodePort', protocol: 'udp' })).toEqual([]);
        });

        it('matches text in the Service, load balancer names, VIPs and backends', () => {
            expect(keys({ query: 'DNS-default' })).toEqual(['node|openshift-dns/dns-default', 'cluster|openshift-dns/dns-default']);
            expect(keys({ query: '192.0.2.200' })).toEqual(['cluster|shop/web']);
            expect(keys({ query: '10.130.0.9' })).toEqual(['cluster|shop/web']);
            expect(keys({ query: '_node_router+switch_' })).toEqual(['node|default/kubernetes', 'node|shop/web']);
            expect(keys({ query: '  ' })).toHaveLength(all.length);
        });

        it('counts the rows each facet value keeps', () => {
            const counts = serviceFacetCounts(all);
            expect(Object.fromEntries(counts.classes)).toEqual({ ClusterIP: 5, NodePort: 3, LoadBalancer: 1, ExternalIP: 1 });
            expect(Object.fromEntries(counts.protocols)).toEqual({ tcp: 7, udp: 1 });
            expect(counts.namespaces.get('shop')).toBe(5);
            expect(counts.withoutEndpoints).toBe(1);
        });
    });

    describe('split summary', () => {
        it('counts load balancers here and cluster-wide, and the VIPs without endpoints', () => {
            const attachment = loadBalancersFor(splitSwitch, splitDatabase())!;
            expect(summarizeSplit(attachment)).toEqual({ here: 4, clusterWide: 4, total: 8, vipsWithoutEndpoints: 2 });
            expect(splitSummaryText(attachment)).toBe('4 here · 4 cluster-wide · 2 VIPs without endpoints');
            expect(splitSummaryText(loadBalancersFor(splitRouter, splitDatabase())!)).toBe(
                '3 here · 3 cluster-wide · 2 VIPs without endpoints',
            );
        });

        it('keeps naming the empty groups when nothing is programmed', () => {
            expect(splitSummaryText(loadBalancersFor(udnSwitch, database())!)).toBe(
                '0 load balancers; groups blue_clusterLBGroup and blue_clusterSwitchLBGroup are empty',
            );
        });
    });

    describe('podOwnerFromLookup', () => {
        const hit = (overrides: Partial<LookupHit>): LookupHit => ({
            node: 'node-b',
            table: 'Logical_Switch_Port',
            rowUuid: 'lsp-1',
            rowName: 'shop_web-1',
            network: 'default',
            owner: { kind: 'Pod', namespace: 'shop', name: 'web-1' },
            matchedField: 'addresses',
            matchedValue: '10.130.0.9',
            matchType: 'exact',
            snapshotGeneratedAt: '2026-11-10T00:00:00Z',
            ...overrides,
        });

        it('names the pod of the one switch port holding the address', () => {
            expect(podOwnerFromLookup({ hits: [hit({}), hit({ matchedField: 'portSecurity' })] })).toEqual({
                namespace: 'shop',
                pod: 'web-1',
                node: 'node-b',
                port: 'shop_web-1',
            });
            // Containment hits (routes, subnets) say nothing about an owner.
            expect(
                podOwnerFromLookup({ hits: [hit({}), hit({ table: 'Logical_Router_Static_Route', matchType: 'containment' })] })?.pod,
            ).toBe('web-1');
        });

        it('resolves to nothing for two ports, a non-pod port or no port', () => {
            expect(podOwnerFromLookup({ hits: [hit({}), hit({ rowUuid: 'lsp-2', node: 'node-c' })] })).toBeUndefined();
            expect(podOwnerFromLookup({ hits: [hit({ owner: undefined })] })).toBeUndefined();
            expect(podOwnerFromLookup({ hits: [] })).toBeUndefined();
        });

        it('looks up addresses, not templates or prefixes', () => {
            expect(isLookupAddress('10.130.0.9')).toBe(true);
            expect(isLookupAddress('fd01::5')).toBe(true);
            expect(isLookupAddress('^shop_tmpl_TCP_32000_v4')).toBe(false);
            expect(isLookupAddress('10.130.0.0/24')).toBe(false);
        });
    });

    describe('over the cnv-1 fixture', () => {
        const switchRow = cnv1Db.logicalSwitches.find((row) => row.name === 'cnv-1')!;
        const attachment = loadBalancersFor({ kind: 'switch', uuid: switchRow.uuid, name: 'cnv-1' }, cnv1Db)!;
        const context = vipClassContext(cnv1Db, ['172.30.0.0/16', 'fd02::/112']);
        const all = groupServices(attachment, context);

        it('lists one row per Service per section, fewer rows than VIPs', () => {
            const vipRows = serviceVipRows(attachment).length;
            const services = new Set(all.map((group) => group.label));
            expect(all.length).toBeLessThan(vipRows);
            expect(all.filter((group) => group.section === 'node')).toHaveLength(
                new Set(attachment.direct.map((row) => `${serviceOf(row)!.namespace}/${serviceOf(row)!.name}`)).size,
            );
            // A Service is at most two rows: one per section.
            expect(all.length).toBeLessThanOrEqual(2 * services.size);
            expect(all[0].section).toBe('node');
        });

        it('states the split the way the bead measured it', () => {
            const split = summarizeSplit(attachment);
            expect(split.here).toBe(attachment.direct.length);
            expect(split.here + split.clusterWide).toBe(split.total);
            expect(splitSummaryText(attachment)).toMatch(/^22 here · \d{3} cluster-wide · \d+ VIPs without endpoints$/);
        });

        it('classifies every VIP, with node ports on both node addresses and LoadBalancer addresses outside the service network', () => {
            const vips = all.flatMap((group) => group.vips);
            const classes = new Set(vips.map((vip) => vip.classification.vipClass));
            expect(classes).toEqual(new Set(['ClusterIP', 'NodePort', 'LoadBalancer']));
            const nodePorts = vips.filter((vip) => vip.classification.vipClass === 'NodePort');
            // Every node port listens on two addresses of the node.
            expect(new Set(nodePorts.map((vip) => vip.address)).size).toBe(2);
            expect(nodePorts.every((vip) => (vip.port ?? 0) >= 30000)).toBe(true);
            const clusterIps = vips.filter((vip) => vip.classification.vipClass === 'ClusterIP');
            expect(clusterIps.every((vip) => vip.address.startsWith('172.30.') || vip.address.startsWith('fd02:'))).toBe(true);
        });
    });
});
