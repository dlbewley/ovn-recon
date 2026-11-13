import { clusterLadderPath, constructDetailPath as linksConstructDetailPath, nodeLadderPath } from './components/constructDetailLinks';
import {
    clusterViewPath,
    logicalViewPath as searchLogicalViewPath,
    overviewSearchPath as searchOverviewSearchPath,
    physicalViewPath as searchPhysicalViewPath,
    withSearchParam,
} from './components/clusterSearchModel';
import {
    logicalViewPath as networkLogicalViewPath,
    NETWORKS_PATH as networkModelNetworksPath,
    networkPath as networkModelNetworkPath,
    physicalViewPath as networkPhysicalViewPath,
} from './components/networkPageModel';
import { nodePagePath } from './insights/links';
import {
    BASE_PATH,
    clusterFindingsPath,
    clusterLogicalPath,
    constructDetailPath,
    ExplorerView,
    NETWORKS_PATH,
    networkPath,
    networksPath,
    nodeFindingsPath,
    nodeLogicalPath,
    nodePhysicalPath,
    nodeRoutesPath,
    overviewPath,
    overviewSearchPath,
    searchPath,
    viewForLocation,
} from './routes';

/** Split a built URL into the location the console would hand the shell. */
const locationOf = (url: string) => {
    const at = url.indexOf('?');
    return at < 0 ? { pathname: url, search: '' } : { pathname: url.slice(0, at), search: url.slice(at) };
};

interface Row {
    url: string;
    built: string[];
    view: ExplorerView;
}

/**
 * Every page URL the plugin links to today, each followed by the builders that produce
 * it (routes.ts and the old names that re-export it), and the view it resolves to.
 * The URLs are written out by hand: they are what the links produced before
 * ovn-recon-gbr.2, and none of them may change.
 */
const EXISTING: Row[] = [
    { url: '/ovn-recon', built: [overviewPath(), BASE_PATH, overviewSearchPath(''), overviewSearchPath('   ')], view: { scope: 'cluster', tab: 'nodes', params: {} } },
    {
        url: '/ovn-recon?q=203.0.113.70',
        built: [overviewSearchPath('203.0.113.70'), overviewSearchPath(' 203.0.113.70 '), searchOverviewSearchPath('203.0.113.70')],
        view: { scope: 'cluster', tab: 'search', params: { q: '203.0.113.70' } },
    },
    {
        url: '/ovn-recon?q=10.0.0.0/24',
        built: [overviewSearchPath('10.0.0.0/24')],
        view: { scope: 'cluster', tab: 'search', params: { q: '10.0.0.0/24' } },
    },
    {
        url: '/ovn-recon?q=aa:bb:cc:00:11:22',
        built: [overviewSearchPath('aa:bb:cc:00:11:22')],
        view: { scope: 'cluster', tab: 'search', params: { q: 'aa:bb:cc:00:11:22' } },
    },
    {
        url: '/ovn-recon?q=my%20pod%26x',
        built: [overviewSearchPath('my pod&x')],
        view: { scope: 'cluster', tab: 'search', params: { q: 'my pod&x' } },
    },
    { url: '/ovn-recon/networks', built: [networksPath(), NETWORKS_PATH, networkModelNetworksPath], view: { scope: 'cluster', tab: 'networks', params: {} } },
    { url: '/ovn-recon/ovn', built: [clusterLogicalPath(), clusterLadderPath()], view: { scope: 'cluster', tab: 'logical', params: {} } },
    {
        url: '/ovn-recon/ovn?select=router:ovn_cluster_router',
        built: [
            clusterLogicalPath({ kind: 'router', name: 'ovn_cluster_router' }),
            clusterLadderPath({ kind: 'router', name: 'ovn_cluster_router' }),
            clusterViewPath({ kind: 'router', name: 'ovn_cluster_router' }),
        ],
        view: { scope: 'cluster', tab: 'logical', params: { select: 'router:ovn_cluster_router' } },
    },
    {
        url: '/ovn-recon/ovn?select=physnet:physnet%20a',
        built: [clusterLogicalPath({ kind: 'physnet', name: 'physnet a' })],
        view: { scope: 'cluster', tab: 'logical', params: { select: 'physnet:physnet a' } },
    },
    {
        url: '/ovn-recon/node-network-state/worker-1',
        built: [nodePhysicalPath('worker-1'), nodePagePath('worker-1'), searchPhysicalViewPath('worker-1'), networkPhysicalViewPath('worker-1')],
        view: { scope: 'node', tab: 'physical', params: { node: 'worker-1' } },
    },
    {
        url: '/ovn-recon/node-network-state/worker-1?select=iface:br-ex',
        built: [
            nodePhysicalPath('worker-1', 'iface:br-ex'),
            nodePagePath('worker-1', 'iface:br-ex'),
            searchPhysicalViewPath('worker-1', 'iface:br-ex'),
            networkPhysicalViewPath('worker-1', 'iface:br-ex'),
        ],
        view: { scope: 'node', tab: 'physical', params: { node: 'worker-1', select: 'iface:br-ex' } },
    },
    {
        url: '/ovn-recon/node-network-state/worker-1?select=udn:ns1/blue',
        built: [nodePhysicalPath('worker-1', 'udn:ns1/blue')],
        view: { scope: 'node', tab: 'physical', params: { node: 'worker-1', select: 'udn:ns1/blue' } },
    },
    {
        url: '/ovn-recon/ovn/cnv-1',
        built: [nodeLogicalPath('cnv-1'), nodeLadderPath('cnv-1'), networkLogicalViewPath('cnv-1')],
        view: { scope: 'node', tab: 'logical', params: { node: 'cnv-1' } },
    },
    {
        url: '/ovn-recon/ovn/cnv-1?select=switch:cnv-1',
        built: [
            nodeLogicalPath('cnv-1', { kind: 'switch', name: 'cnv-1' }),
            nodeLadderPath('cnv-1', { kind: 'switch', name: 'cnv-1' }),
            searchLogicalViewPath('cnv-1', { kind: 'switch', name: 'cnv-1' }),
        ],
        view: { scope: 'node', tab: 'logical', params: { node: 'cnv-1', select: 'switch:cnv-1' } },
    },
    {
        url: '/ovn-recon/ovn/cnv-1/router/GR_cnv-1',
        built: [
            constructDetailPath('cnv-1', 'router', 'GR_cnv-1'),
            constructDetailPath('cnv-1', 'router', 'GR_cnv-1', { tab: 'overview' }),
            linksConstructDetailPath('cnv-1', 'router', 'GR_cnv-1'),
        ],
        view: { scope: 'node', tab: 'construct', params: { node: 'cnv-1', kind: 'router', name: 'GR_cnv-1' } },
    },
    {
        url: '/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=ports&q=10.128&port=default_virt-launcher',
        built: [constructDetailPath('cnv-1', 'switch', 'cnv-1', { tab: 'ports', q: '10.128', port: 'default_virt-launcher' })],
        view: {
            scope: 'node',
            tab: 'construct',
            params: { node: 'cnv-1', kind: 'switch', name: 'cnv-1', detailTab: 'ports', q: '10.128', port: 'default_virt-launcher' },
        },
    },
    {
        url: '/ovn-recon/ovn/cnv-1/switch/blue%20net_cnv-1?tab=routes',
        built: [constructDetailPath('cnv-1', 'switch', 'blue net_cnv-1', { tab: 'routes' })],
        view: { scope: 'node', tab: 'construct', params: { node: 'cnv-1', kind: 'switch', name: 'blue net_cnv-1', detailTab: 'routes' } },
    },
    {
        url: '/ovn-recon/networks/cudn/vlan-1924',
        built: [networkPath({ kind: 'cudn', name: 'vlan-1924' }), networkModelNetworkPath({ kind: 'cudn', name: 'vlan-1924' })],
        view: { scope: 'network', tab: 'network', params: { network: { kind: 'cudn', name: 'vlan-1924' } } },
    },
    {
        url: '/ovn-recon/networks/udn/ns1/blue',
        built: [networkPath({ kind: 'udn', namespace: 'ns1', name: 'blue' })],
        view: { scope: 'network', tab: 'network', params: { network: { kind: 'udn', namespace: 'ns1', name: 'blue' } } },
    },
    {
        url: '/ovn-recon/networks/nad/default/vm-igb',
        built: [networkPath({ kind: 'nad', namespace: 'default', name: 'vm-igb' }), networkPath({ kind: 'nad', name: 'vm-igb' })],
        view: { scope: 'network', tab: 'network', params: { network: { kind: 'nad', namespace: 'default', name: 'vm-igb' } } },
    },
];

/** The four paths the explorer adds. Nothing links to them yet. */
const NEW: Row[] = [
    { url: '/ovn-recon/findings', built: [clusterFindingsPath()], view: { scope: 'cluster', tab: 'findings', params: {} } },
    {
        url: '/ovn-recon/search?q=203.0.113.70',
        built: [searchPath('203.0.113.70'), searchPath(' 203.0.113.70 ')],
        view: { scope: 'cluster', tab: 'search', params: { q: '203.0.113.70' } },
    },
    { url: '/ovn-recon/search', built: [searchPath('')], view: { scope: 'cluster', tab: 'search', params: {} } },
    { url: '/ovn-recon/node-network-state/worker-1/routes', built: [nodeRoutesPath('worker-1')], view: { scope: 'node', tab: 'routes', params: { node: 'worker-1' } } },
    { url: '/ovn-recon/node-network-state/worker-1/findings', built: [nodeFindingsPath('worker-1')], view: { scope: 'node', tab: 'findings', params: { node: 'worker-1' } } },
];

describe('routes (ovn-recon-gbr.2)', () => {
    describe.each([
        ['existing', EXISTING],
        ['new', NEW],
    ])('%s URLs', (_label, rows) => {
        it.each(rows.map((row) => [row.url, row] as const))('%s is built unchanged', (url, row) => {
            for (const built of row.built) expect(built).toBe(url);
        });

        it.each(rows.map((row) => [row.url, row] as const))('%s resolves to its view', (url, row) => {
            expect(viewForLocation(locationOf(url))).toEqual(row.view);
        });
    });

    it('builds the overview search exactly as the search box writes ?q=', () => {
        for (const text of ['', ' ', '203.0.113.70', 'a b', 'x&y=z', 'ns1/pod:80', '100%', 'é']) {
            expect(overviewSearchPath(text)).toBe(`/ovn-recon${withSearchParam('', text)}`);
            expect(searchPath(text)).toBe(`/ovn-recon/search${withSearchParam('', text)}`);
        }
    });

    it('encodes path segments', () => {
        expect(nodePhysicalPath('a/b')).toBe('/ovn-recon/node-network-state/a%2Fb');
        expect(nodeLogicalPath('a b')).toBe('/ovn-recon/ovn/a%20b');
        expect(nodeRoutesPath('a/b')).toBe('/ovn-recon/node-network-state/a%2Fb/routes');
        expect(viewForLocation({ pathname: '/ovn-recon/node-network-state/a%2Fb/routes' }))
            .toEqual({ scope: 'node', tab: 'routes', params: { node: 'a/b' } });
    });

    it('maps the overview aliases and a trailing slash to the Nodes tab', () => {
        const nodes = { scope: 'cluster', tab: 'nodes', params: {} };
        expect(viewForLocation({ pathname: '/ovn-recon/node-network-state' })).toEqual(nodes);
        expect(viewForLocation({ pathname: '/ovn-recon/' })).toEqual(nodes);
        expect(viewForLocation({ pathname: '/ovn-recon', search: '?q=' })).toEqual(nodes);
        expect(viewForLocation({ pathname: '/ovn-recon/node-network-state', search: '?q=br-ex' }))
            .toEqual({ scope: 'cluster', tab: 'search', params: { q: 'br-ex' } });
    });

    it('keeps ?select= on whatever view carries it', () => {
        expect(viewForLocation({ pathname: '/ovn-recon/networks/cudn/blue', search: '?select=cudn:blue' }))
            .toEqual({ scope: 'network', tab: 'network', params: { network: { kind: 'cudn', name: 'blue' }, select: 'cudn:blue' } });
    });

    it.each([
        '/',
        '/k8s/cluster/nodes',
        '/ovn-reconx',
        '/ovn-recon/nope',
        '/ovn-recon/search/extra',
        '/ovn-recon/findings/extra',
        '/ovn-recon/node-network-state/worker-1/bogus',
        '/ovn-recon/node-network-state/worker-1/routes/extra',
        '/ovn-recon/ovn/cnv-1/switch',
        '/ovn-recon/ovn/cnv-1/switch/cnv-1/extra',
        '/ovn-recon/networks/cudn',
        '/ovn-recon/networks/udn/only-name',
        '/ovn-recon/networks/pod/a/b',
    ])('serves nothing at %s', (pathname) => {
        expect(viewForLocation({ pathname })).toBeNull();
    });
});
