import fs from 'fs';
import path from 'path';

import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import { LookupHit, LookupResponse, NodeNetworkState } from '../types';
import {
    buildClusterSearchResults,
    clusterViewPath,
    CollectorOutcome,
    coveringGroupsOfHits,
    describeCoverage,
    describeSearched,
    describeSearchQuery,
    detectSearchQuery,
    foldResults,
    logicalViewPath,
    normalizeMac,
    overviewSearchPath,
    physicalViewPath,
    readSearchParam,
    resultOfHit,
    SearchQuery,
    SearchResult,
    searchWatchedResources,
    vmOfLauncherPod,
    withSearchParam,
} from './clusterSearchModel';

// Every address here is from a documentation range (RFC 5737, RFC 3849).

const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

const query = (input: string): SearchQuery => {
    const detected = detectSearchQuery(input);
    if (!detected) throw new Error(`empty query: "${input}"`);
    return detected;
};

const GENERATED_AT = '2026-11-10T12:00:00Z';

const hit = (overrides: Partial<LookupHit> = {}): LookupHit => ({
    node: 'node-a',
    table: 'Logical_Switch_Port',
    rowUuid: `uuid-${Math.random()}`,
    rowName: 'shop_web-7b7bd6f866-nhwtv',
    construct: { kind: 'switch', name: 'node-a', uuid: 'switch-uuid' },
    network: 'default',
    owner: { kind: 'Pod', namespace: 'shop', name: 'web-7b7bd6f866-nhwtv' },
    matchedField: 'addresses',
    matchedValue: '02:00:00:00:00:46 203.0.113.70',
    matchType: 'exact',
    snapshotGeneratedAt: GENERATED_AT,
    ...overrides,
});

const response = (hits: LookupHit[], overrides: Partial<LookupResponse> = {}): LookupResponse => ({
    query: { kind: 'ip', value: '203.0.113.70' },
    hits,
    total: hits.length,
    limit: 200,
    truncated: false,
    zones: Array.from(new Set(hits.map((entry) => entry.node))).map((node) => ({
        node,
        snapshotGeneratedAt: GENERATED_AT,
        sourceHealth: 'healthy',
    })),
    warnings: [],
    ...overrides,
});

const searched = (hits: LookupHit[], overrides: Partial<LookupResponse> = {}): CollectorOutcome =>
    ({ state: 'searched', response: response(hits, overrides) });

const nns = (name: string, interfaces: unknown[], routes: unknown[] = []): NodeNetworkState =>
    ({
        metadata: { name },
        status: { currentState: { interfaces, routes: { running: routes } } },
    }) as unknown as NodeNetworkState;

const node = (name: string, addresses: { type: string; address: string }[] = []): K8sResourceCommon =>
    ({ metadata: { name }, status: { addresses } }) as unknown as K8sResourceCommon;

const NODES = Array.from({ length: 10 }, (_, index) => `node-${String.fromCharCode(97 + index)}`);

describe('detectSearchQuery', () => {
    it('reads an empty box as no query', () => {
        expect(detectSearchQuery('')).toBeNull();
        expect(detectSearchQuery('   \n')).toBeNull();
    });

    it('reads IPv4 and IPv6 addresses', () => {
        expect(detectSearchQuery(' 203.0.113.70 ')).toMatchObject({ kind: 'ip', text: '203.0.113.70', value: '203.0.113.70' });
        expect(detectSearchQuery('2001:db8::10')).toMatchObject({ kind: 'ip', value: '2001:db8::10' });
        // Any spelling of the same address is sent in one canonical form.
        expect(detectSearchQuery('2001:0DB8:0:0:0:0:0:10')).toMatchObject({ kind: 'ip', value: '2001:db8::10' });
        expect(detectSearchQuery('203.000.113.070')).toMatchObject({ kind: 'ip', value: '203.0.113.70' });
    });

    it('reads a CIDR, masked to its network', () => {
        expect(detectSearchQuery('203.0.113.70/26')).toMatchObject({ kind: 'cidr', value: '203.0.113.64/26' });
        expect(detectSearchQuery('2001:db8:1::10/64')).toMatchObject({ kind: 'cidr', value: '2001:db8:1::/64' });
        expect(detectSearchQuery('203.0.113.70/32')).toMatchObject({ kind: 'cidr', value: '203.0.113.70/32' });
    });

    it('reads a MAC in the spellings the collector accepts, as lower-case colon form', () => {
        for (const spelling of ['02:00:00:AA:BB:46', '02-00-00-aa-bb-46', '0200.00aa.bb46']) {
            expect(detectSearchQuery(spelling)).toMatchObject({ kind: 'mac', value: '02:00:00:aa:bb:46' });
        }
        expect(normalizeMac('not a mac')).toBeNull();
        expect(normalizeMac(undefined)).toBeNull();
    });

    it('reads everything else as a name', () => {
        expect(detectSearchQuery('thanos-querier')).toMatchObject({ kind: 'name', value: 'thanos-querier' });
        // Half an address, a mask out of range, twelve bare hex digits: none
        // of them parses as its kind, so none is sent as one.
        expect(detectSearchQuery('203.0.113')).toMatchObject({ kind: 'name' });
        expect(detectSearchQuery('203.0.113.0/33')).toMatchObject({ kind: 'name' });
        expect(detectSearchQuery('020000aabb46')).toMatchObject({ kind: 'name' });
        expect(detectSearchQuery('02:00:00:aa:bb')).toMatchObject({ kind: 'name' });
    });

    it('says how the input was read', () => {
        expect(describeSearchQuery(query('203.0.113.70'))).toBe('IP 203.0.113.70');
        expect(describeSearchQuery(query('203.0.113.70/26'))).toBe('CIDR 203.0.113.64/26');
        expect(describeSearchQuery(query('02-00-00-AA-BB-46'))).toBe('MAC 02:00:00:aa:bb:46');
        expect(describeSearchQuery(query('blue'))).toBe('name "blue"');
    });
});

describe('the search parameter in the page URL', () => {
    it('reads q, trimmed, and nothing when it is absent', () => {
        expect(readSearchParam('?q=203.0.113.70')).toBe('203.0.113.70');
        expect(readSearchParam('?q=%20blue%20&x=1')).toBe('blue');
        expect(readSearchParam('?x=1')).toBe('');
        expect(readSearchParam('')).toBe('');
    });

    it('writes q, keeping other parameters and the separators of addresses readable', () => {
        expect(withSearchParam('', '203.0.113.0/24')).toBe('?q=203.0.113.0/24');
        expect(withSearchParam('?x=1&q=old&y=%2F', '02:00:00:aa:bb:46')).toBe('?x=1&y=%2F&q=02:00:00:aa:bb:46');
        expect(withSearchParam('?q=old', 'a b&c')).toBe('?q=a%20b%26c');
        expect(readSearchParam(withSearchParam('', 'a b&c=d#e'))).toBe('a b&c=d#e');
    });

    it('removes q for an empty search', () => {
        expect(withSearchParam('?q=old', '  ')).toBe('');
        expect(withSearchParam('?x=1&q=old', '')).toBe('?x=1');
    });

    it('builds the overview path a "Find in cluster" entry opens', () => {
        expect(overviewSearchPath('203.0.113.70')).toBe('/ovn-recon?q=203.0.113.70');
        expect(overviewSearchPath('')).toBe('/ovn-recon');
    });
});

describe('view paths', () => {
    it('selects a switch or router in a node logical view and in the cluster view', () => {
        expect(logicalViewPath('node-a', { kind: 'switch', name: 'node-a' })).toBe('/ovn-recon/ovn/node-a?select=switch:node-a');
        expect(logicalViewPath('node-a', { kind: 'router', name: 'GR_node-a' })).toBe('/ovn-recon/ovn/node-a?select=router:GR_node-a');
        expect(logicalViewPath('node-a')).toBe('/ovn-recon/ovn/node-a');
        expect(clusterViewPath({ kind: 'router', name: 'ovn_cluster_router' })).toBe('/ovn-recon/ovn?select=router:ovn_cluster_router');
    });

    it('selects a canonical node id in the physical view', () => {
        expect(physicalViewPath('node-a', 'iface:br-ex')).toBe('/ovn-recon/node-network-state/node-a?select=iface:br-ex');
        expect(physicalViewPath('node-a', 'vrf:blue')).toBe('/ovn-recon/node-network-state/node-a?select=vrf:blue');
        expect(physicalViewPath('node-a')).toBe('/ovn-recon/node-network-state/node-a');
    });

    it('encodes what a path or a query cannot carry as written', () => {
        expect(logicalViewPath('node a', { kind: 'switch', name: 'a&b c' })).toBe('/ovn-recon/ovn/node%20a?select=switch:a%26b%20c');
    });
});

describe('collector hits as results', () => {
    it('links a pod port to the switch that owns it and to the pod', () => {
        const result = resultOfHit(hit());
        expect(result).toMatchObject({
            kind: 'pod-port',
            source: 'collector',
            title: 'shop_web-7b7bd6f866-nhwtv',
            subtitle: 'Switch port on switch node-a',
            network: 'default',
            match: { type: 'exact', field: 'address', value: '02:00:00:00:00:46 203.0.113.70' },
            owner: { kind: 'Pod', namespace: 'shop', name: 'web-7b7bd6f866-nhwtv', href: '/k8s/ns/shop/core~v1~Pod/web-7b7bd6f866-nhwtv' },
        });
        expect(result.places).toEqual([{
            node: 'node-a',
            snapshotGeneratedAt: GENERATED_AT,
            link: { view: 'logical', label: 'Logical view', href: '/ovn-recon/ovn/node-a?select=switch:node-a' },
        }]);
    });

    it('names the VM behind a virt-launcher pod', () => {
        const result = resultOfHit(hit({
            rowName: 'shop_virt-launcher-db-1-x7k2p',
            owner: { kind: 'Pod', namespace: 'shop', name: 'virt-launcher-db-1-x7k2p' },
        }));
        expect(result.owner).toMatchObject({ note: 'VM db-1', href: '/k8s/ns/shop/core~v1~Pod/virt-launcher-db-1-x7k2p' });
        expect(vmOfLauncherPod('web-7b7bd6f866-nhwtv')).toBeUndefined();
    });

    it('keeps a switch port no pod owns apart from the pod ports', () => {
        const result = resultOfHit(hit({ rowName: 'k8s-node-a', owner: undefined }));
        expect(result.kind).toBe('switch-port');
        expect(result.owner).toBeUndefined();
    });

    it('links a router port and a NAT rule to their router', () => {
        const port = resultOfHit(hit({
            table: 'Logical_Router_Port',
            rowName: 'rtoe-GR_node-a',
            construct: { kind: 'router', name: 'GR_node-a', uuid: 'r' },
            owner: undefined,
            matchedField: 'networks',
            matchedValue: '192.0.2.10/24',
        }));
        expect(port).toMatchObject({
            kind: 'router-port',
            subtitle: 'Router port on router GR_node-a',
            match: { field: 'network', value: '192.0.2.10/24' },
        });
        expect(port.places[0].link?.href).toBe('/ovn-recon/ovn/node-a?select=router:GR_node-a');

        const nat = resultOfHit(hit({
            table: 'NAT',
            rowName: undefined,
            construct: { kind: 'router', name: 'GR_node-a', uuid: 'r' },
            owner: undefined,
            matchedField: 'externalIp',
            matchedValue: '192.0.2.10',
        }));
        // NAT rows have no name column: the title says what the row is.
        expect(nat).toMatchObject({ kind: 'nat', title: 'NAT rule', subtitle: 'on router GR_node-a', match: { field: 'external IP' } });
        expect(nat.places[0].link?.href).toBe('/ovn-recon/ovn/node-a?select=router:GR_node-a');
    });

    it('links a Service VIP to its Service, and to no construct', () => {
        const result = resultOfHit(hit({
            table: 'Load_Balancer',
            rowName: 'Service_shop/web_TCP_cluster',
            construct: undefined,
            owner: { kind: 'Service', namespace: 'shop', name: 'web' },
            matchedField: 'vips',
            matchedValue: '198.51.100.10:443',
        }));
        expect(result).toMatchObject({
            kind: 'service-vip',
            subtitle: 'Load balancer',
            match: { field: 'VIP', value: '198.51.100.10:443' },
            owner: { href: '/k8s/ns/shop/core~v1~Service/web' },
        });
        expect(result.construct).toBeUndefined();
        expect(result.places).toEqual([{ node: 'node-a', snapshotGeneratedAt: GENERATED_AT }]);
    });

    it('selects a switch or router that is itself the hit', () => {
        const result = resultOfHit(hit({
            table: 'Logical_Switch',
            rowName: 'cluster_udn_blue_ovn_layer2_switch',
            construct: { kind: 'switch', name: 'cluster_udn_blue_ovn_layer2_switch', uuid: 's' },
            network: 'cluster_udn_blue',
            owner: undefined,
            matchedField: 'externalIds.k8s.ovn.org/network',
            matchedValue: 'cluster_udn_blue',
            matchType: 'substring',
        }));
        expect(result).toMatchObject({ kind: 'construct', subtitle: 'Logical switch', match: { type: 'substring', field: 'network identity' } });
        expect(result.places[0].link?.href).toBe('/ovn-recon/ovn/node-a?select=switch:cluster_udn_blue_ovn_layer2_switch');
    });

    it('leaves an owner kind with no known console page as text', () => {
        const result = resultOfHit(hit({ owner: { kind: 'EgressIP', name: 'egress-a' } }));
        expect(result.owner).toEqual({ kind: 'EgressIP', name: 'egress-a' });
    });
});

describe('folding', () => {
    it('folds the same row seen from several zones into one result listing every zone', () => {
        const remote = NODES.slice(0, 3).map((zone) => hit({
            node: zone,
            rowName: 'shop_virt-launcher-db-1-x7k2p',
            construct: { kind: 'switch', name: 'cluster_udn_blue_ovn_layer2_switch', uuid: `s-${zone}` },
            network: 'cluster_udn_blue',
            owner: { kind: 'Pod', namespace: 'shop', name: 'virt-launcher-db-1-x7k2p' },
        }));
        const folded = foldResults(remote.map(resultOfHit));

        expect(folded).toHaveLength(1);
        expect(folded[0].places.map((place) => place.node)).toEqual(['node-a', 'node-b', 'node-c']);
        expect(folded[0].places.map((place) => place.link?.href)).toEqual([
            '/ovn-recon/ovn/node-a?select=switch:cluster_udn_blue_ovn_layer2_switch',
            '/ovn-recon/ovn/node-b?select=switch:cluster_udn_blue_ovn_layer2_switch',
            '/ovn-recon/ovn/node-c?select=switch:cluster_udn_blue_ovn_layer2_switch',
        ]);
        // Seen from several zones: the cluster view shows it as one card.
        expect(folded[0].links).toEqual([{
            view: 'cluster',
            label: 'Cluster view',
            href: '/ovn-recon/ovn?select=switch:cluster_udn_blue_ovn_layer2_switch',
        }]);
    });

    it('offers no cluster link for a result in one zone', () => {
        expect(foldResults([resultOfHit(hit())])[0].links).toEqual([]);
    });

    it('never folds the same address in two networks: each hit is shown with its network', () => {
        const overlapping = [
            hit({ rowName: 'red_app-1', network: 'cluster_udn_red', construct: { kind: 'switch', name: 'cluster_udn_red_ovn_layer2_switch', uuid: 'a' } }),
            hit({ rowName: 'blue_app-1', network: 'cluster_udn_blue', construct: { kind: 'switch', name: 'cluster_udn_blue_ovn_layer2_switch', uuid: 'b' } }),
            // Even the same port name, when only the network differs.
            hit({ rowName: 'red_app-1', network: 'tenant_green', construct: { kind: 'switch', name: 'cluster_udn_red_ovn_layer2_switch', uuid: 'c' } }),
        ];
        const results = buildClusterSearchResults(query('203.0.113.70'), searched(overlapping), { nodeNetworkStates: [] });

        expect(results.resultCount).toBe(3);
        expect(results.groups).toHaveLength(1);
        expect(results.groups[0].results.map((result) => result.network).sort()).toEqual([
            'cluster_udn_blue', 'cluster_udn_red', 'tenant_green',
        ]);
    });
});

/**
 * The shape the lookup was measured to return for one pod address on a
 * ten-node cluster: the pod's port, then three routes or subnets per zone
 * that merely contain the address.
 */
const podAddressHits = (): LookupHit[] => {
    const containment = (overrides: Partial<LookupHit>): LookupHit =>
        hit({ rowName: undefined, owner: undefined, matchType: 'containment', ...overrides });
    return [
        hit(),
        ...NODES.flatMap((zone) => [
            containment({
                node: zone,
                table: 'Logical_Router_Static_Route',
                construct: { kind: 'router', name: 'ovn_cluster_router', uuid: `ocr-${zone}` },
                matchedField: 'ipPrefix',
                matchedValue: '203.0.113.0/24',
            }),
            containment({
                node: zone,
                table: 'Logical_Router_Static_Route',
                construct: { kind: 'router', name: 'ovn_cluster_router', uuid: `ocr-${zone}` },
                matchedField: 'ipPrefix',
                matchedValue: '203.0.113.64/26',
            }),
            containment({
                node: zone,
                table: 'Logical_Router_Static_Route',
                construct: { kind: 'router', name: `GR_${zone}`, uuid: `gr-${zone}` },
                matchedField: 'ipPrefix',
                matchedValue: '203.0.113.0/24',
            }),
        ]),
        containment({
            table: 'Logical_Switch',
            rowName: 'node-a',
            construct: { kind: 'switch', name: 'node-a', uuid: 'switch-uuid' },
            matchedField: 'otherConfig.subnet',
            matchedValue: '203.0.113.64/26',
        }),
    ];
};

describe('exact matches before covering routes', () => {
    it('leads with the exact hit and keeps every containment hit out of the result groups', () => {
        const results = buildClusterSearchResults(query('203.0.113.70'), searched(podAddressHits()), { nodeNetworkStates: [] });

        expect(results.groups.map((group) => group.kind)).toEqual(['pod-port']);
        expect(results.resultCount).toBe(1);
        expect(results.groups[0].results[0].title).toBe('shop_web-7b7bd6f866-nhwtv');
        expect(results.groups.flatMap((group) => group.results).some((result) => result.match.type === 'containment')).toBe(false);
        // All 31 containment hits are accounted for, in the covering groups.
        expect(results.coveringCount).toBe(31);
    });

    it('folds containment hits into one group per router or switch name', () => {
        const { covering } = buildClusterSearchResults(query('203.0.113.70'), searched(podAddressHits()), { nodeNetworkStates: [] });

        // ovn_cluster_router is one group across ten zones; each gateway
        // router and the node switch has its own.
        expect(covering).toHaveLength(12);
        const cluster = covering.find((group) => group.label === 'Router ovn_cluster_router');
        expect(cluster).toMatchObject({ source: 'collector', network: 'default', hitCount: 20, nodes: NODES });
        expect(cluster!.entries.map((entry) => [entry.what, entry.prefix, entry.places.length])).toEqual([
            ['Static route', '203.0.113.64/26', 10],
            ['Static route', '203.0.113.0/24', 10],
        ]);
        expect(cluster!.links).toEqual([{ view: 'cluster', label: 'Cluster view', href: '/ovn-recon/ovn?select=router:ovn_cluster_router' }]);
        expect(cluster!.entries[0].places[1].link?.href).toBe('/ovn-recon/ovn/node-b?select=router:ovn_cluster_router');

        const gateway = covering.find((group) => group.label === 'Router GR_node-c');
        expect(gateway).toMatchObject({ hitCount: 1, nodes: ['node-c'], links: [] });

        const nodeSwitch = covering.find((group) => group.label === 'Switch node-a');
        expect(nodeSwitch!.entries).toEqual([expect.objectContaining({ what: 'Subnet', prefix: '203.0.113.64/26' })]);
    });

    it('orders covering groups most specific first', () => {
        const { covering } = buildClusterSearchResults(query('203.0.113.70'), searched(podAddressHits()), { nodeNetworkStates: [] });
        // /26 holders before the groups that only hold the /24.
        expect(covering.slice(0, 2).map((group) => group.label)).toEqual(['Router ovn_cluster_router', 'Switch node-a']);
        expect(covering[2].label).toBe('Router GR_node-a');
    });

    it('keeps the same router name in two networks as two groups', () => {
        const groups = coveringGroupsOfHits([
            hit({ table: 'NAT', rowName: undefined, owner: undefined, matchType: 'containment', network: 'cluster_udn_red', construct: { kind: 'router', name: 'GR_node-a', uuid: 'a' }, matchedField: 'logicalIp', matchedValue: '203.0.113.0/24' }),
            hit({ table: 'NAT', rowName: undefined, owner: undefined, matchType: 'containment', network: 'cluster_udn_blue', construct: { kind: 'router', name: 'GR_node-a', uuid: 'b' }, matchedField: 'logicalIp', matchedValue: '203.0.113.0/24' }),
        ]);
        expect(groups.map((group) => group.network)).toEqual(['cluster_udn_red', 'cluster_udn_blue']);
        expect(groups[0].entries[0].what).toBe('NAT logical IP');
    });

    it('puts exact matches ahead of substring matches within a group', () => {
        const hits = [
            hit({ rowName: 'shop_web-canary', matchedField: 'name', matchedValue: 'shop_web-canary', matchType: 'substring' }),
            hit({ rowName: 'shop_web', matchedField: 'name', matchedValue: 'shop_web', matchType: 'exact' }),
            hit({ rowName: 'shop_a-web-proxy', matchedField: 'name', matchedValue: 'shop_a-web-proxy', matchType: 'substring' }),
        ];
        const results = buildClusterSearchResults(query('shop_web'), searched(hits), { nodeNetworkStates: [] });
        expect(results.groups[0].results.map((result) => [result.match.type, result.title])).toEqual([
            ['exact', 'shop_web'],
            ['substring', 'shop_a-web-proxy'],
            ['substring', 'shop_web-canary'],
        ]);
    });
});

describe('searchWatchedResources', () => {
    const routesNode = fixture<NodeNetworkState>('nns', 'kernel-routes.json');
    const vrfNode = fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json');
    const titles = (results: SearchResult[]) => results.map((result) => result.title);

    it('finds an interface by address and links the physical view with it selected', () => {
        const { results } = searchWatchedResources(query('198.51.100.20'), { nodeNetworkStates: [routesNode] });
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            kind: 'node-interface',
            source: 'cluster',
            title: 'ens4',
            subtitle: 'ethernet · up',
            match: { type: 'exact', field: 'address', value: '198.51.100.20/24' },
        });
        expect(results[0].places).toEqual([{
            node: 'worker-routes',
            link: { view: 'physical', label: 'Physical view', href: '/ovn-recon/node-network-state/worker-routes?select=iface:ens4' },
        }]);
    });

    it('finds an IPv6 address in any spelling', () => {
        const { results } = searchWatchedResources(query('2001:DB8:1:0::10'), { nodeNetworkStates: [routesNode] });
        expect(results.map((result) => [result.title, result.match.value])).toEqual([['br-ex', '2001:db8:1::10/64']]);
    });

    it('selects the bridge for an internal port that shares its name', () => {
        // br-ex is both an ovs-bridge and the ovs-interface holding the
        // node address. The port sits in a lane the physical view hides by
        // default; the bridge of the same name is what it draws.
        const { results } = searchWatchedResources(query('192.0.2.10'), { nodeNetworkStates: [routesNode] });
        expect(results).toHaveLength(1);
        expect(results[0].subtitle).toBe('ovs-interface · up');
        expect(results[0].places[0].link?.href).toBe('/ovn-recon/node-network-state/worker-routes?select=iface:br-ex');
    });

    it('marks an address that is also the Node address', () => {
        const { results } = searchWatchedResources(query('192.0.2.10'), {
            nodeNetworkStates: [routesNode],
            nodes: [node('worker-routes', [{ type: 'InternalIP', address: '192.0.2.10' }, { type: 'Hostname', address: 'worker-routes' }])],
        });
        expect(results).toHaveLength(1);
        expect(results[0].match).toEqual({ type: 'exact', field: 'address', value: '192.0.2.10/24', note: 'node InternalIP' });
    });

    it('reports a Node address that no reported interface holds', () => {
        const { results } = searchWatchedResources(query('192.0.2.99'), {
            nodeNetworkStates: [routesNode],
            nodes: [node('node-z', [{ type: 'InternalIP', address: '192.0.2.99' }])],
        });
        expect(results).toEqual([expect.objectContaining({
            kind: 'node-interface',
            title: 'node-z',
            match: { type: 'exact', field: 'InternalIP', value: '192.0.2.99' },
            places: [{ node: 'node-z', link: { view: 'physical', label: 'Physical view', href: '/ovn-recon/node-network-state/node-z' } }],
        })]);
    });

    it('finds interfaces by MAC, whatever the case, and by permanent MAC', () => {
        const state = nns('node-a', [
            { name: 'eno1', type: 'ethernet', state: 'up', 'mac-address': '02:00:00:AA:BB:01' },
            { name: 'bond0', type: 'bond', state: 'up', 'mac-address': '02:00:00:AA:BB:01' },
            { name: 'eno2', type: 'ethernet', state: 'up', 'mac-address': '02:00:00:AA:BB:01', 'permanent-mac-address': '02:00:00:AA:BB:02' },
        ]);
        expect(titles(searchWatchedResources(query('02-00-00-aa-bb-01'), { nodeNetworkStates: [state] }).results))
            .toEqual(['eno1', 'bond0', 'eno2']);
        const permanent = searchWatchedResources(query('0200.00aa.bb02'), { nodeNetworkStates: [state] }).results;
        expect(permanent.map((result) => [result.title, result.match.field])).toEqual([['eno2', 'permanent MAC']]);
    });

    it('finds interfaces by name and alternative name, and selects a VRF under its own id', () => {
        const state = nns('node-a', [
            { name: 'blue', type: 'vrf', state: 'up', vrf: { port: ['ovn-k8s-mp7'], 'route-table-id': 1007 } },
            { name: 'ovn-k8s-mp7', type: 'ovs-interface', state: 'up' },
            { name: 'eno1', type: 'ethernet', state: 'up', 'alt-names': [{ name: 'enp1s0-blue' }] },
            { name: 'eno2', type: 'ethernet', state: 'down' },
        ]);
        const { results } = searchWatchedResources(query('BLUE'), { nodeNetworkStates: [state] });
        expect(results.map((result) => [result.title, result.match.type, result.match.field, result.places[0].link?.href])).toEqual([
            ['blue', 'exact', 'name', '/ovn-recon/node-network-state/node-a?select=vrf:blue'],
            ['eno1', 'substring', 'alternative name', '/ovn-recon/node-network-state/node-a?select=iface:eno1'],
        ]);
        // A port names the VRF it is enslaved to, where a collector hit names its network.
        const port = searchWatchedResources(query('ovn-k8s-mp7'), { nodeNetworkStates: [state] }).results[0];
        expect(port.context).toBe('VRF blue');
    });

    it('folds the same interface on several nodes into one result listing every node', () => {
        const states = ['node-a', 'node-b', 'node-c'].map((name) => nns(name, [{ name: 'br-ex', type: 'ovs-bridge', state: 'up' }]));
        const results = buildClusterSearchResults(query('br-ex'), { state: 'disabled' }, { nodeNetworkStates: states });
        expect(results.resultCount).toBe(1);
        const [bridge] = results.groups[0].results;
        expect(bridge.places.map((place) => place.link?.href)).toEqual([
            '/ovn-recon/node-network-state/node-a?select=iface:br-ex',
            '/ovn-recon/node-network-state/node-b?select=iface:br-ex',
            '/ovn-recon/node-network-state/node-c?select=iface:br-ex',
        ]);
        // The cluster view is a collector view: no link to it from a node interface.
        expect(bridge.links).toEqual([]);
    });

    it('turns kernel routes that contain the address into covering entries of their node, longest prefix first', () => {
        const { results, covering } = searchWatchedResources(query('203.0.113.70'), { nodeNetworkStates: [routesNode] });
        expect(results).toEqual([]);
        expect(covering).toHaveLength(1);
        expect(covering[0]).toMatchObject({ source: 'cluster', label: 'Kernel routes on worker-routes', nodes: ['worker-routes'], hitCount: 3 });
        expect(covering[0].entries.map((entry) => [entry.what, entry.prefix, entry.detail])).toEqual([
            ['Kernel route', '203.0.113.64/26', 'via 192.0.2.252 dev br-ex · Table 254 (main)'],
            // The ECMP pair at metric 20 is one route with two next hops.
            ['Kernel route', '203.0.113.0/24', 'via 192.0.2.254 dev br-ex, via 198.51.100.254 dev ens4 · Table 254 (main)'],
            ['Kernel route', '203.0.113.0/24', 'via 192.0.2.253 dev br-ex · Table 254 (main)'],
        ]);
        expect(covering[0].entries[0].places[0].link?.href).toBe('/ovn-recon/node-network-state/worker-routes?select=iface:br-ex');
    });

    it('never counts a default route as covering an address', () => {
        // 192.0.2.200 is inside the on-link 192.0.2.0/24 only; both default
        // routes of the family cover it and say nothing.
        const { covering } = searchWatchedResources(query('192.0.2.200'), { nodeNetworkStates: [routesNode] });
        expect(covering[0].entries.map((entry) => entry.prefix)).toEqual(['192.0.2.0/24']);
        expect(covering[0].entries[0].detail).toBe('on-link dev br-ex · Table 254 (main)');
    });

    it('relates a CIDR to kernel routes and interface addresses the way the collector does', () => {
        const { results, covering } = searchWatchedResources(query('203.0.113.0/24'), { nodeNetworkStates: [routesNode] });
        expect(results.map((result) => [result.kind, result.title, result.match.type, result.context])).toEqual([
            ['route', '203.0.113.64/26', 'within', 'Table 254 (main)'],
            ['route', '203.0.113.0/24', 'exact', 'Table 254 (main)'],
            ['route', '203.0.113.0/24', 'exact', 'Table 254 (main)'],
        ]);
        expect(results[0].subtitle).toBe('Kernel route · via 192.0.2.252 dev br-ex');
        expect(covering).toEqual([]);

        // A narrower CIDR is covered by the /24 and the /26 routes; the
        // interface address inside 198.51.100.0/24 is found by a query for it.
        expect(searchWatchedResources(query('203.0.113.64/28'), { nodeNetworkStates: [routesNode] }).covering[0].entries.map((entry) => entry.prefix))
            .toEqual(['203.0.113.64/26', '203.0.113.0/24', '203.0.113.0/24']);
        const inside = searchWatchedResources(query('198.51.100.0/24'), { nodeNetworkStates: [routesNode] }).results;
        expect(inside.filter((result) => result.kind === 'node-interface').map((result) => [result.title, result.match.type, result.match.value]))
            .toEqual([['ens4', 'within', '198.51.100.20/24']]);
    });

    it('treats a host route to the searched address as an exact match, and selects the VRF of a VRF table', () => {
        const { results } = searchWatchedResources(query('169.254.0.16'), { nodeNetworkStates: [vrfNode] });
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            kind: 'route',
            title: '169.254.0.16/32',
            match: { type: 'exact', field: 'destination' },
            context: 'Table 5775 · VRF example-p-cudn',
        });
        expect(results[0].places[0].link?.href).toBe('/ovn-recon/node-network-state/worker-1?select=vrf:example-p-cudn');
    });

    it('searches kernel routes for addresses only', () => {
        expect(searchWatchedResources(query('br-ex'), { nodeNetworkStates: [routesNode] }).covering).toEqual([]);
        expect(searchWatchedResources(query('02:00:00:00:00:04'), { nodeNetworkStates: [routesNode] }).results.map((result) => result.kind))
            .toEqual(['node-interface']);
    });
});

describe('merging collector and cluster hits', () => {
    const state = nns(
        'node-a',
        [
            { name: 'br-ex', type: 'ovs-bridge', state: 'up' },
            { name: 'br-ex', type: 'ovs-interface', state: 'up', 'mac-address': '02:00:00:00:00:0a', ipv4: { address: [{ ip: '192.0.2.10', 'prefix-length': 24 }] } },
        ],
        [
            { destination: '192.0.2.0/24', 'next-hop-address': '0.0.0.0', 'next-hop-interface': 'br-ex', 'table-id': 254 },
            { destination: '0.0.0.0/0', 'next-hop-address': '192.0.2.1', 'next-hop-interface': 'br-ex', 'table-id': 254 },
        ],
    );
    const sources = { nodeNetworkStates: [state], nodes: [node('node-a', [{ type: 'InternalIP', address: '192.0.2.10' }])] };
    const hits = [
        hit({
            table: 'Logical_Router_Port',
            rowName: 'rtoe-GR_node-a',
            construct: { kind: 'router', name: 'GR_node-a', uuid: 'r' },
            owner: undefined,
            matchedField: 'networks',
            matchedValue: '192.0.2.10/24',
        }),
        hit({
            table: 'NAT',
            rowName: undefined,
            construct: { kind: 'router', name: 'GR_node-a', uuid: 'r' },
            owner: undefined,
            matchedField: 'externalIp',
            matchedValue: '192.0.2.10',
        }),
        hit({
            table: 'Logical_Router_Static_Route',
            rowName: undefined,
            construct: { kind: 'router', name: 'GR_node-a', uuid: 'r' },
            owner: undefined,
            matchedField: 'ipPrefix',
            matchedValue: '192.0.2.0/24',
            matchType: 'containment',
        }),
    ];

    it('groups hits from both sources by kind, in page order', () => {
        const results = buildClusterSearchResults(query('192.0.2.10'), searched(hits), sources);

        expect(results.groups.map((group) => [group.kind, group.label, group.results.map((result) => result.source)])).toEqual([
            ['router-port', 'Router ports', ['collector']],
            ['nat', 'NAT rules', ['collector']],
            ['node-interface', 'Node interfaces', ['cluster']],
        ]);
        expect(results.resultCount).toBe(3);
        expect(results.groups[2].results[0]).toMatchObject({ title: 'br-ex', match: { note: 'node InternalIP' } });
    });

    it('keeps covering hits from both sources together, apart from the results', () => {
        const results = buildClusterSearchResults(query('192.0.2.10'), searched(hits), sources);
        expect(results.covering.map((group) => [group.source, group.label])).toEqual([
            ['collector', 'Router GR_node-a'],
            ['cluster', 'Kernel routes on node-a'],
        ]);
        expect(results.coveringCount).toBe(2);
    });

    it('still answers from the cluster when the collector did not', () => {
        for (const outcome of [
            { state: 'disabled' },
            { state: 'unreachable', message: 'boom' },
            { state: 'rejected', message: 'not an IP address' },
        ] as CollectorOutcome[]) {
            const results = buildClusterSearchResults(query('192.0.2.10'), outcome, sources);
            expect(results.groups.map((group) => group.kind)).toEqual(['node-interface']);
            expect(results.covering.map((group) => group.label)).toEqual(['Kernel routes on node-a']);
            expect(results.coverage.partial).toBe(true);
        }
    });

    it('mixes collector and cluster routes in one group for a CIDR, exact first', () => {
        const cidrHits = [
            hit({
                table: 'Logical_Router_Static_Route',
                rowName: undefined,
                construct: { kind: 'router', name: 'GR_node-a', uuid: 'r' },
                owner: undefined,
                matchedField: 'ipPrefix',
                matchedValue: '192.0.2.128/25',
                matchType: 'within',
            }),
        ];
        const results = buildClusterSearchResults(query('192.0.2.0/24'), searched(cidrHits, { query: { kind: 'cidr', value: '192.0.2.0/24' } }), sources);
        const routes = results.groups.find((group) => group.kind === 'route');
        expect(routes!.results.map((result) => [result.source, result.match.type, result.title])).toEqual([
            ['cluster', 'exact', '192.0.2.0/24'],
            ['collector', 'within', 'Static route'],
        ]);
    });
});

describe('coverage', () => {
    const states = ['node-a', 'node-b', 'node-c'].map((name) => nns(name, []));
    const sources = { nodeNetworkStates: states, nodes: ['node-a', 'node-b', 'node-c'].map((name) => node(name)) };

    it('is complete when every known node has a searched zone', () => {
        const zones = ['node-a', 'node-b', 'node-c'].map((name, index) => ({
            node: name,
            snapshotGeneratedAt: `2026-11-10T12:0${index}:00Z`,
            sourceHealth: 'healthy',
        }));
        const coverage = describeCoverage(searched([], { zones }), sources);
        expect(coverage).toEqual({
            collector: 'searched',
            zonesSearched: 3,
            oldestSnapshotAt: '2026-11-10T12:00:00Z',
            unsearchedNodes: [],
            warnings: [],
            nodesWithState: 3,
            partial: false,
        });
        expect(describeSearched(coverage)).toBe('3 collector zone snapshots and the NodeNetworkState of 3 nodes');
        // A note about the snapshots stays next to them.
        expect(describeSearched(coverage, 'oldest collected 45s ago'))
            .toBe('3 collector zone snapshots (oldest collected 45s ago) and the NodeNetworkState of 3 nodes');
    });

    it('names the nodes the collector did not search and passes its warnings on', () => {
        const warnings = [{ code: 'ZONE_NOT_CACHED', message: 'node-c has no cached snapshot and was not searched' }];
        const coverage = describeCoverage(
            searched([], {
                zones: [{ node: 'node-a', snapshotGeneratedAt: GENERATED_AT, sourceHealth: 'healthy' }],
                warnings,
            }),
            sources,
        );
        expect(coverage).toMatchObject({ zonesSearched: 1, unsearchedNodes: ['node-b', 'node-c'], warnings, partial: true });
        expect(describeSearched(coverage)).toBe('1 collector zone snapshot and the NodeNetworkState of 3 nodes');
    });

    it('falls back to the NodeNetworkState names when no Node list is in hand', () => {
        const coverage = describeCoverage(
            searched([], { zones: [{ node: 'node-b', snapshotGeneratedAt: GENERATED_AT, sourceHealth: 'healthy' }] }),
            { nodeNetworkStates: states },
        );
        expect(coverage.unsearchedNodes).toEqual(['node-a', 'node-c']);
    });

    it('is partial when the collector searched nothing', () => {
        const warnings = [{ code: 'LOOKUP_CACHE_DISABLED', message: 'no snapshot cache is configured' }];
        const coverage = describeCoverage(searched([], { zones: [], warnings }), { nodeNetworkStates: [] });
        expect(coverage).toMatchObject({ zonesSearched: 0, partial: true, warnings });
        expect(coverage.oldestSnapshotAt).toBeUndefined();
    });

    it('reports hits cut by the limit', () => {
        const hits = [hit(), hit({ rowName: 'shop_other' })];
        const coverage = describeCoverage(searched(hits, { total: 412, limit: 2, truncated: true }), { nodeNetworkStates: [] });
        expect(coverage.truncated).toEqual({ shown: 2, total: 412 });
        expect(coverage.partial).toBe(true);
    });

    it('says why the collector half is missing', () => {
        expect(describeCoverage({ state: 'disabled' }, sources)).toMatchObject({ collector: 'disabled', partial: true, zonesSearched: 0 });
        expect(describeCoverage({ state: 'unreachable', message: 'boom' }, sources)).toMatchObject({ collector: 'unreachable', collectorMessage: 'boom', partial: true });
        const rejected = describeCoverage({ state: 'rejected', message: '"x" is not an IP address' }, sources);
        expect(rejected).toMatchObject({ collector: 'rejected', collectorMessage: '"x" is not an IP address', partial: true });
        expect(describeSearched(rejected)).toBe('the NodeNetworkState of 3 nodes');
    });
});
