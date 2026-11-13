import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { matchPath, MemoryRouter, NavigateFunction, Route, Routes, useLocation, useNavigate } from 'react-router';

import {
    BASE_PATH,
    clusterFindingsPath,
    clusterLogicalPath,
    constructDetailPath,
    networkPath,
    networksPath,
    nodeFindingsPath,
    nodeLogicalPath,
    nodePhysicalPath,
    nodeRoutesPath,
    overviewPath,
    overviewSearchPath,
    searchPath,
    SHELL_ROUTES,
    viewForLocation,
} from '../routes';
import { ClusterUserDefinedNetwork, NetworkAttachmentDefinition, NodeNetworkState } from '../types';
import { CLUSTER_ITEM_ID, MORE_NETWORKS_ID, networkItemId, nodeItemId } from './explorerTreeModel';
import OvnReconApp, { TREE_DEFAULT_SIZE } from './OvnReconApp';

/**
 * The explorer shell (ovn-recon-gbr.4), mounted as console 4.22 mounts a non-exact
 * plugin route: `<Route path="/ovn-recon/*">` (usePluginRoutes). The bodies the shell
 * loads on demand are stood in for by stubs that print the props they are handed, so
 * each URL shows which body it reached; the shell, the scope headers and the Cluster
 * scope are drawn for real from the ten-node localnet-coverage capture, with the
 * collector disabled. OvnReconApp.network.test.tsx draws the network body for real.
 */

const items = <T,>(...segments: string[]): T[] => {
    const data = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8'),
    ) as T[] | { items: T[] };
    return Array.isArray(data) ? data : data.items;
};

const mockWatches: Record<string, unknown[]> = {};
const mockGate = { enabled: false, loaded: true, loadError: null as Error | null };

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    // Like the console's, the title goes to the document head, not the page.
    DocumentTitle: () => null,
    useK8sWatchResource: (resource: { groupVersionKind: { kind: string } }) =>
        [mockWatches[resource.groupVersionKind.kind] ?? [], true, undefined],
}));

jest.mock('./useOvnCollectorFeatureGate', () => ({
    useOvnCollectorFeatureGate: () => ({ ...mockGate }),
}));

/** A body stand-in: prints the props the shell hands it, and the query string. */
const mockBodyStub = (label: string) => {
    const Stub: React.FC<Record<string, unknown>> = (props) => {
        const location = useLocation();
        return <div data-testid="passthrough">{label} {JSON.stringify(props)} {location.search}</div>;
    };
    return Stub;
};
jest.mock('./NodeNetworkStateDetails', () => ({
    __esModule: true,
    NodeNetworkStateBody: mockBodyStub('physical'),
    NodeRoutesBody: mockBodyStub('routes'),
}));
jest.mock('./NodeLogicalTopologyDetails', () => ({ __esModule: true, NodeLogicalTopologyBody: mockBodyStub('node-logical') }));
jest.mock('./ConstructDetails', () => ({ __esModule: true, ConstructExplorerBody: mockBodyStub('construct') }));
jest.mock('./NetworkDetails', () => ({ __esModule: true, NetworkExplorerBody: mockBodyStub('network') }));
jest.mock('./ClusterLogicalTopologyDetails', () => ({
    __esModule: true,
    ClusterLogicalTopologyBody: mockBodyStub('cluster-logical'),
}));

const coverage = {
    nns: items<NodeNetworkState>('nns', 'cluster-localnet-coverage.json'),
    cudns: items<ClusterUserDefinedNetwork>('cudn', 'cluster-localnet-coverage.json'),
    nads: items<NetworkAttachmentDefinition>('nad', 'cluster-localnet-coverage.json'),
};

/** Enough extra CUDNs that the tree caps the list. */
const extraCudns = Array.from({ length: 8 }, (_, index): ClusterUserDefinedNetwork => ({
    apiVersion: 'k8s.ovn.org/v1',
    kind: 'ClusterUserDefinedNetwork',
    metadata: { name: `extra-${index}` },
    spec: { network: { topology: 'Layer2', layer2: { role: 'Secondary', subnets: [`10.${index}.0.0/24`] } } },
} as unknown as ClusterUserDefinedNetwork));

describe('OvnReconApp, the explorer shell', () => {
    let container: HTMLDivElement;
    let root: Root;
    let navigate: NavigateFunction;
    let current: { pathname: string; search: string };

    const Probe: React.FC = () => {
        navigate = useNavigate();
        const location = useLocation();
        current = { pathname: location.pathname, search: location.search };
        return null;
    };

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        window.localStorage.clear();
        mockGate.enabled = false;
        mockGate.loaded = true;
        mockWatches.NodeNetworkState = coverage.nns;
        mockWatches.Node = coverage.nns.map((nns) => ({
            metadata: {
                name: nns.metadata?.name,
                labels: { [`node-role.kubernetes.io/${nns.metadata?.name?.startsWith('control') ? 'control-plane' : 'worker'}`]: '' },
            },
        }));
        mockWatches.ClusterUserDefinedNetwork = [...coverage.cudns, ...extraCudns];
        mockWatches.UserDefinedNetwork = [];
        mockWatches.NetworkAttachmentDefinition = coverage.nads;
        mockWatches.RouteAdvertisements = [];
        mockWatches.NodeNetworkConfigurationEnactment = [];
        global.fetch = jest.fn().mockRejectedValue(new Error('no collector in this test')) as unknown as typeof fetch;
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        jest.restoreAllMocks();
    });

    const settle = async () => {
        for (let round = 0; round < 3; round += 1) {
            await act(async () => {
                await Promise.resolve();
            });
        }
    };

    const render = async (initialEntry: string) => {
        await act(async () => {
            root.render(
                <MemoryRouter initialEntries={[initialEntry]}>
                    <Probe />
                    <Routes>
                        <Route path={`${BASE_PATH}/*`} element={<OvnReconApp />} />
                    </Routes>
                </MemoryRouter>,
            );
        });
        await settle();
    };

    const go = async (to: string) => {
        await act(async () => {
            navigate(to);
        });
        await settle();
    };

    const byTestId = (id: string): HTMLElement | null =>
        container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    const passthrough = (): string | null => byTestId('passthrough')?.textContent ?? null;
    const activeTab = (): string | null =>
        container.querySelector('[data-testid="cluster-tabs"] .pf-m-current')?.textContent ?? null;
    const tabKeys = (): string[] =>
        Array.from(container.querySelectorAll('[data-testid^="cluster-tab-"]'))
            .map((tab) => tab.getAttribute('data-testid')!.replace('cluster-tab-', ''));
    const treeItem = (id: string): HTMLElement | null => byTestId(`explorer-tree-${id}`);
    const selectedTreeIds = (): string[] =>
        Array.from(container.querySelectorAll('[role="treeitem"][aria-selected="true"]')).map((item) => item.id);
    const click = async (element: Element | null) => {
        expect(element).not.toBeNull();
        await act(async () => {
            (element as HTMLElement).click();
        });
        await settle();
    };
    const type = async (input: HTMLInputElement, value: string) => {
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    };

    describe('layout, with the collector disabled', () => {
        it('lands on Cluster > Nodes: a title row over the tree and the node table', async () => {
            await render(overviewPath());

            const shell = byTestId('ovn-recon-explorer')!;
            const titleRow = byTestId('explorer-title-row')!;
            // The title row comes first, then the drawer with the tree at its start.
            expect(shell.firstElementChild).toBe(titleRow);
            expect(titleRow.querySelector('h1')?.textContent).toBe('OVN Recon');
            expect(byTestId('explorer-collector-status')?.textContent).toContain('Collector not enabled');
            expect(byTestId('explorer-search')?.querySelector('input')?.getAttribute('aria-label'))
                .toBe('Find an IP, CIDR, MAC or name in the cluster');
            expect(container.querySelectorAll('h1')).toHaveLength(1);

            const drawer = container.querySelector('.pf-v6-c-drawer')!;
            expect(drawer.classList).toContain('pf-m-inline');
            expect(drawer.classList).toContain('pf-m-panel-left');
            const panel = byTestId('explorer-tree-panel')!;
            expect(panel.classList).toContain('pf-m-resizable');
            expect(panel.getAttribute('style')).toContain(TREE_DEFAULT_SIZE);
            const splitter = panel.querySelector('[role="separator"]')!;
            expect(splitter.getAttribute('aria-label')).toBe('Resize the tree');
            expect(splitter.getAttribute('tabindex')).toBe('0');

            // The tree: a filter, then Cluster (selected), Nodes (open) and Networks.
            expect(panel.querySelector('input')?.getAttribute('aria-label')).toBe('Filter the tree by name');
            expect(selectedTreeIds()).toEqual([CLUSTER_ITEM_ID]);
            expect(treeItem(nodeItemId('control-1'))?.textContent).toBe('control-1control plane');
            expect(treeItem(nodeItemId('worker-1'))?.textContent).toBe('worker-1worker');
            expect(treeItem('nodes')?.closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('true');
            expect(treeItem('networks')?.closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('false');

            // The scope: its header, its tabs (no Logical topology while the collector is off) and the table.
            const content = container.querySelector('.pf-v6-c-drawer__content')!;
            expect(content.querySelector('h2')?.textContent).toBe('Cluster');
            expect(tabKeys()).toEqual(['nodes', 'networks', 'findings']);
            expect(activeTab()).toMatch(/^Nodes10$/);
            expect(content.querySelectorAll('[data-testid^="overview-node-"]')).toHaveLength(10);
            expect(content.textContent).not.toContain('Logical');
            expect(passthrough()).toBeNull();
        });

        it('shows the Logical topology tab when the collector is on', async () => {
            mockGate.enabled = true;
            await render(overviewPath());
            expect(tabKeys()).toEqual(['nodes', 'networks', 'findings', 'logical']);
        });

        it('collapses the tree to a rail and back, keeping its filter and moving focus', async () => {
            await render(overviewPath());
            const filter = byTestId('explorer-tree-panel')!.querySelector('input')!;
            await type(filter, 'worker');
            expect(treeItem(nodeItemId('control-1'))).toBeNull();

            await click(byTestId('explorer-tree-collapse'));
            expect(byTestId('explorer-tree-panel')).toBeNull();
            expect(byTestId('explorer-tree')).toBeNull();
            expect(byTestId('explorer-rail')?.getAttribute('style')).toContain('48px');
            expect(byTestId('explorer-tree-collapse')).toBeNull();
            expect(document.activeElement).toBe(byTestId('explorer-tree-expand'));
            // The content keeps its place.
            expect(container.querySelectorAll('[data-testid^="overview-node-"]')).toHaveLength(10);

            await click(byTestId('explorer-tree-expand'));
            expect(byTestId('explorer-rail')).toBeNull();
            expect((byTestId('explorer-tree-panel')!.querySelector('input') as HTMLInputElement).value).toBe('worker');
            expect(treeItem(nodeItemId('control-1'))).toBeNull();
            expect(treeItem(nodeItemId('worker-1'))).not.toBeNull();
            expect(document.activeElement).toBe(byTestId('explorer-tree-collapse'));
        });
    });

    describe('routes the shell serves', () => {
        const node = 'worker-1';
        const cases: [string, string, { tab?: string; page?: RegExp; selected: string | null }][] = [
            ['the overview', overviewPath(), { tab: 'cluster-tab-nodes', selected: CLUSTER_ITEM_ID }],
            ['the overview alias', `${BASE_PATH}/${SHELL_ROUTES.nodesAlias}`, { tab: 'cluster-tab-nodes', selected: CLUSTER_ITEM_ID }],
            ['networks', networksPath(), { tab: 'cluster-tab-networks', selected: CLUSTER_ITEM_ID }],
            ['findings', clusterFindingsPath(), { tab: 'cluster-tab-findings', selected: CLUSTER_ITEM_ID }],
            ['the cluster ladder', clusterLogicalPath(), {
                tab: 'cluster-tab-logical', page: /^cluster-logical/, selected: CLUSTER_ITEM_ID,
            }],
            ['search', searchPath('10.0.0.1'), { tab: 'cluster-tab-search', selected: CLUSTER_ITEM_ID }],
            ['a node', nodePhysicalPath(node, 'iface:br-ex'), {
                tab: 'node-tab-physical',
                page: /^physical \{"name":"worker-1","inExplorer":true\} \?select=iface(:|%3A)br-ex$/,
                selected: nodeItemId(node),
            }],
            ['a node\'s routes', nodeRoutesPath(node), {
                tab: 'node-tab-routes', page: /^routes \{"name":"worker-1"\}/, selected: nodeItemId(node),
            }],
            ['a node zone', nodeLogicalPath(node), {
                tab: 'node-tab-logical',
                page: /^node-logical \{"name":"worker-1","hideHostSelect":true,"flush":true\}/,
                selected: nodeItemId(node),
            }],
            ['a construct', constructDetailPath(node, 'switch', 'join', { tab: 'ports', q: 'abc' }), {
                tab: 'node-tab-logical',
                page: /^construct \{"node":"worker-1","kind":"switch","name":"join"\} \?tab=ports&q=abc$/,
                selected: nodeItemId(node),
            }],
            ['a CUDN', networkPath({ kind: 'cudn', name: 'vlan-1924' }), {
                page: /^network \{"address":\{"kind":"cudn","name":"vlan-1924"\}\}/,
                selected: networkItemId({ kind: 'cudn', name: 'vlan-1924' }),
            }],
            ['a UDN', networkPath({ kind: 'udn', namespace: 'team', name: 'blue' }), {
                page: /^network \{"address":\{"kind":"udn","namespace":"team","name":"blue"\}\}/, selected: null,
            }],
            ['a NAD', networkPath({ kind: 'nad', namespace: 'default', name: 'vlan-999' }), {
                page: /^network \{"address":\{"kind":"nad","namespace":"default","name":"vlan-999"\}\}/, selected: null,
            }],
        ];

        it.each(cases)('serves %s', async (_name, url, expected) => {
            await render(url);
            expect(byTestId('explorer-not-found')).toBeNull();
            expect(byTestId('explorer-tree')).not.toBeNull();
            if (expected.tab) {
                expect(container.querySelector('nav .pf-m-current [data-testid]')?.getAttribute('data-testid'))
                    .toBe(expected.tab);
            } else {
                // A network has one view: a header and no tabs.
                expect(byTestId('network-scope-header')).not.toBeNull();
                expect(container.querySelector('nav[aria-label$="views"], nav[aria-label^="Views of"]')).toBeNull();
            }
            if (expected.page) expect(passthrough()).toMatch(expected.page);
            else expect(passthrough()).toBeNull();
            // A network the tree does not list (the UDN, and the NAD a CUDN generated) selects nothing visible.
            expect(selectedTreeIds()).toEqual(expected.selected ? [expected.selected] : []);
        });

        it('draws each Cluster tab from the shared data', async () => {
            await render(networksPath());
            expect(container.querySelectorAll('[data-testid^="overview-network-findings-"]').length).toBeGreaterThan(10);
            expect(container.textContent).toContain('Physical network or subnets');

            await go(clusterFindingsPath());
            expect(byTestId('overview-findings-card')).not.toBeNull();

            await go(searchPath('10.0.0.1'));
            expect(byTestId('search-status')?.textContent ?? container.textContent).toContain('10.0.0.1');
        });

        it('sends an old /ovn-recon?q= link to the search tab', async () => {
            await render(overviewSearchPath('10.0.0.1'));
            expect(current).toEqual({ pathname: `${BASE_PATH}/search`, search: '?q=10.0.0.1' });
            expect(activeTab()).toBe('Search results');
        });

        it.each([
            ['an unknown path', `${BASE_PATH}/nope`],
            ['a node tab that arrives in ovn-recon-gbr.7', nodeFindingsPath('worker-1')],
            ['a construct path one level too deep', `${constructDetailPath('worker-1', 'switch', 'join')}/x`],
        ])('says page not found for %s, with the tree still there', async (_name, url) => {
            await render(url);
            expect(byTestId('explorer-not-found')?.textContent).toContain('Page not found');
            expect(byTestId('explorer-tree')).not.toBeNull();
        });

        it('matches each pattern to the paths the builders make, as viewForLocation reads them', () => {
            const built: [string, string][] = [
                [SHELL_ROUTES.networks, networksPath()],
                [SHELL_ROUTES.findings, clusterFindingsPath()],
                [SHELL_ROUTES.clusterLogical, clusterLogicalPath()],
                [SHELL_ROUTES.search, `${BASE_PATH}/search`],
                [SHELL_ROUTES.nodePhysical, nodePhysicalPath('a b')],
                [SHELL_ROUTES.nodeRoutes, nodeRoutesPath('a b')],
                [SHELL_ROUTES.nodeLogical, nodeLogicalPath('a b')],
                [SHELL_ROUTES.construct, constructDetailPath('a b', 'router', 'r/1').split('?')[0]],
                [SHELL_ROUTES.cudn, networkPath({ kind: 'cudn', name: 'c' })],
                [SHELL_ROUTES.udn, networkPath({ kind: 'udn', namespace: 'n', name: 'u' })],
                [SHELL_ROUTES.nad, networkPath({ kind: 'nad', namespace: 'n', name: 'd' })],
            ];
            built.forEach(([pattern, pathname]) => {
                expect(matchPath(`${BASE_PATH}/${pattern}`, pathname)).not.toBeNull();
                expect(viewForLocation({ pathname })).not.toBeNull();
            });
        });
    });

    describe('the tree', () => {
        it('navigates to the existing URL of what is selected, without remounting', async () => {
            await render(overviewPath());
            const filter = byTestId('explorer-tree-panel')!.querySelector('input')!;
            await type(filter, 'w');

            await click(treeItem(nodeItemId('worker-2')));
            expect(current.pathname).toBe(nodePhysicalPath('worker-2'));
            expect(passthrough()).toMatch(/^physical \{"name":"worker-2","inExplorer":true\}/);
            expect(selectedTreeIds()).toEqual([nodeItemId('worker-2')]);

            await click(treeItem(CLUSTER_ITEM_ID));
            expect(current.pathname).toBe(overviewPath());
            // The shell stayed mounted: the filter is still typed.
            expect((byTestId('explorer-tree-panel')!.querySelector('input') as HTMLInputElement).value).toBe('w');
        });

        it('stays on the current tab when the selected item is chosen again', async () => {
            await render(nodeLogicalPath('worker-1'));
            await click(treeItem(nodeItemId('worker-1')));
            expect(current.pathname).toBe(nodeLogicalPath('worker-1'));
            await go(networksPath());
            await click(treeItem(CLUSTER_ITEM_ID));
            expect(current.pathname).toBe(networksPath());
        });

        it('lists networks findings first, capped, and shows the rest on request', async () => {
            await render(overviewPath());
            await click(treeItem('networks')?.closest('button') ?? treeItem('networks'));
            const networkIds = () => Array.from(
                treeItem('networks')!.closest('[role="treeitem"]')!.querySelectorAll('[role="group"] [role="treeitem"]'),
            ).map((item) => item.id);
            const shown = networkIds();
            expect(shown).toHaveLength(11);
            expect(shown[10]).toBe(MORE_NETWORKS_ID);
            expect(treeItem(MORE_NETWORKS_ID)?.textContent).toMatch(/^Show \d+ more$/);

            await click(treeItem(MORE_NETWORKS_ID));
            expect(networkIds()).not.toContain(MORE_NETWORKS_ID);
            expect(networkIds().length).toBeGreaterThan(10);
            expect(current.pathname).toBe(overviewPath());

            const cudn = treeItem(networkItemId({ kind: 'cudn', name: 'extra-0' }))!;
            expect(cudn.textContent).toBe('extra-0CUDN');
            await click(cudn);
            expect(current.pathname).toBe(networkPath({ kind: 'cudn', name: 'extra-0' }));
        });
    });

    describe('the node scope (ovn-recon-gbr.5)', () => {
        const nodeTabIds = (): string[] =>
            Array.from(container.querySelectorAll('[data-testid^="node-tab-"]'))
                .map((tab) => tab.getAttribute('data-testid')!.replace('node-tab-', ''));

        it('heads a node with its name as a switcher, its role, its counts and its NodeNetworkState', async () => {
            await render(nodePhysicalPath('worker-1'));
            const header = byTestId('node-scope-header')!;
            expect(header.querySelector('h2')?.textContent).toBe('worker-1');
            expect(byTestId('node-switcher')?.getAttribute('aria-label')).toBe('Node worker-1: switch node');
            expect(byTestId('node-scope-facts')?.textContent).toMatch(/^worker · \d+ up \/ \d+ interfaces · \d+ bridge mappings?$/);
            const nns = Array.from(header.querySelectorAll('a')).find((link) => link.textContent === 'NodeNetworkState');
            expect(nns?.getAttribute('href')).toBe('/k8s/cluster/nmstate.io~v1beta1~NodeNetworkState/worker-1');
            // One heading per level: the page's h1 is the title row's.
            expect(container.querySelectorAll('h1')).toHaveLength(1);
        });

        it('links each tab to the node\'s own URL; Logical only with the collector on', async () => {
            await render(nodePhysicalPath('worker-1', 'iface:br-ex'));
            expect(nodeTabIds()).toEqual(['physical', 'routes']);
            mockGate.enabled = true;
            await render(nodePhysicalPath('worker-1', 'iface:br-ex'));
            expect(nodeTabIds()).toEqual(['physical', 'logical', 'routes']);
            const href = (key: string) => byTestId(`node-tab-${key}`)?.getAttribute('href');
            expect([href('physical'), href('logical'), href('routes')])
                .toEqual([nodePhysicalPath('worker-1'), nodeLogicalPath('worker-1'), nodeRoutesPath('worker-1')]);

            await click(byTestId('node-tab-routes'));
            expect(current).toEqual({ pathname: nodeRoutesPath('worker-1'), search: '' });
            expect(passthrough()).toMatch(/^routes \{"name":"worker-1"\}/);
            await click(byTestId('node-tab-logical'));
            expect(current.pathname).toBe(nodeLogicalPath('worker-1'));
            expect(selectedTreeIds()).toEqual([nodeItemId('worker-1')]);
        });

        it('switches node on the same tab, keeping the selection', async () => {
            await render(nodePhysicalPath('worker-1', 'iface:br-ex'));
            await click(byTestId('node-switcher'));
            await click(document.querySelector('[data-testid="node-switcher-worker-3"] button'));
            expect(current).toEqual({ pathname: nodePhysicalPath('worker-3'), search: '?select=iface:br-ex' });
            expect(passthrough()).toMatch(/^physical \{"name":"worker-3","inExplorer":true\} \?select=iface:br-ex$/);
            expect(selectedTreeIds()).toEqual([nodeItemId('worker-3')]);
        });

        it('switches a construct page to the same construct in the other node\'s zone', async () => {
            await render(constructDetailPath('worker-1', 'router', 'GR_worker-1', { tab: 'policy' }));
            await click(byTestId('node-switcher'));
            await click(document.querySelector('[data-testid="node-switcher-control-2"] button'));
            expect(current.pathname + current.search)
                .toBe(constructDetailPath('control-2', 'router', 'GR_control-2', { tab: 'policy' }));
        });

        it('lists every node with a NodeNetworkState in the switcher, with its role', async () => {
            await render(nodeRoutesPath('worker-1'));
            await click(byTestId('node-switcher'));
            const options = Array.from(document.querySelectorAll('[data-testid^="node-switcher-"]'));
            expect(options).toHaveLength(10);
            expect(document.querySelector('[data-testid="node-switcher-control-1"]')?.textContent).toBe('control-1control plane');
        });
    });

    describe('the network scope (ovn-recon-gbr.6)', () => {
        it('heads a CUDN with its name, kind, facts and console link, with no tabs', async () => {
            await render(networkPath({ kind: 'cudn', name: 'vlan-1924' }));
            const header = byTestId('network-scope-header')!;
            expect(header.querySelector('h2')?.textContent).toBe('vlan-1924');
            expect(header.querySelector('.pf-v6-c-label')?.textContent).toBe('CUDN');
            expect(byTestId('network-scope-facts')?.textContent).toMatch(/^Localnet( · \w+)? · wired on 4 of 10 nodes$/);
            expect(byTestId('network-console-link')?.getAttribute('href'))
                .toBe('/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/vlan-1924');
            expect(byTestId('network-owner')).toBeNull();
            // One heading per level: the page's h1 is the title row's.
            expect(container.querySelectorAll('h1')).toHaveLength(1);
            expect(container.querySelector('[role="tablist"]')).toBeNull();
            // The tree opens Networks to show the selection.
            expect(treeItem('networks')?.closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('true');
            expect(selectedTreeIds()).toEqual([networkItemId({ kind: 'cudn', name: 'vlan-1924' })]);
        });

        it('names the network behind a generated NAD, which the tree does not list', async () => {
            await render(networkPath({ kind: 'nad', namespace: 'demo-mirror', name: 'vlan-1924' }));
            expect(byTestId('network-scope-name')?.textContent).toBe('demo-mirror/vlan-1924');
            expect(byTestId('network-owner')?.textContent).toBe('Generated by ClusterUserDefinedNetwork vlan-1924');
            await click(byTestId('network-owner')!.querySelector('a'));
            expect(current.pathname).toBe(networkPath({ kind: 'cudn', name: 'vlan-1924' }));
            expect(selectedTreeIds()).toEqual([networkItemId({ kind: 'cudn', name: 'vlan-1924' })]);
        });

        it('keeps a missing network\'s name in the header, with no facts or links', async () => {
            await render(networkPath({ kind: 'udn', namespace: 'team', name: 'blue' }));
            expect(byTestId('network-scope-name')?.textContent).toBe('team/blue');
            expect(byTestId('network-scope-facts')).toBeNull();
            expect(byTestId('network-console-link')).toBeNull();
        });

        it('lists the network in the tree even past the cap, and selecting another opens it', async () => {
            await render(networkPath({ kind: 'cudn', name: 'extra-7' }));
            expect(selectedTreeIds()).toEqual([networkItemId({ kind: 'cudn', name: 'extra-7' })]);
            await click(treeItem(networkItemId({ kind: 'cudn', name: 'vlan-333' })));
            expect(current.pathname).toBe(networkPath({ kind: 'cudn', name: 'vlan-333' }));
            expect(byTestId('network-scope-name')?.textContent).toBe('vlan-333');
            expect(passthrough()).toMatch(/^network \{"address":\{"kind":"cudn","name":"vlan-333"\}\}/);
        });
    });

    describe('the search box', () => {
        it('opens a search at its own path from any page, leaving the page\'s own ?q= alone', async () => {
            await render(constructDetailPath('worker-1', 'switch', 'join', { q: 'port-filter' }));
            const input = byTestId('explorer-search')!.querySelector('input')!;
            expect(input.value).toBe('');
            await type(input, '10.128.0.5');
            await act(async () => {
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            });
            await settle();
            expect(current).toEqual({ pathname: `${BASE_PATH}/search`, search: '?q=10.128.0.5' });
            expect(activeTab()).toBe('Search results');

            await act(async () => {
                navigate(-1);
            });
            await settle();
            expect(passthrough()).toContain('?q=port-filter');
        });
    });
});
