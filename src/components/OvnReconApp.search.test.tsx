import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, NavigateFunction, Route, Routes, useLocation, useNavigate } from 'react-router';

import { BASE_PATH, networksPath, nodePhysicalPath, overviewPath, searchPath } from '../routes';
import { ClusterUserDefinedNetwork, LookupHit, LookupResponse, NetworkAttachmentDefinition, NodeNetworkState } from '../types';
import { NETWORKS_GROUP_ID, networkItemId, nodeItemId, NODES_GROUP_ID } from './explorerTreeModel';
import OvnReconApp from './OvnReconApp';

/**
 * Search in the explorer (ovn-recon-gbr.8): the Search results tab stays open while a
 * followed result is looked at, the tree marks what holds results and narrows to them,
 * and clearing the box closes all of it. Drawn from the ten-node localnet-coverage
 * capture, where only the four workers have br-vmdata.
 */

const items = <T,>(...segments: string[]): T[] => {
    const data = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8'),
    ) as T[] | { items: T[] };
    return Array.isArray(data) ? data : data.items;
};

// [data, loaded, error] per kind; absent kinds load as empty.
const mockWatches: Record<string, [unknown, boolean, unknown]> = {};

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    DocumentTitle: () => null,
    useK8sWatchResource: (resource: { groupVersionKind: { kind: string } }) =>
        mockWatches[resource.groupVersionKind.kind] ?? [[], true, undefined],
}));

const mockGate = { enabled: false };
jest.mock('./useOvnCollectorFeatureGate', () => ({
    useOvnCollectorFeatureGate: () => ({ enabled: mockGate.enabled, loaded: true, loadError: null }),
}));

const mockBodyStub = (label: string) => {
    const Stub: React.FC = () => <div data-testid="passthrough">{label}</div>;
    return Stub;
};
jest.mock('./NodeNetworkStateDetails', () => ({
    __esModule: true,
    NodeNetworkStateBody: mockBodyStub('physical'),
    NodeRoutesBody: mockBodyStub('routes'),
}));
jest.mock('./NodeLogicalTopologyDetails', () => ({ __esModule: true, NodeLogicalTopologyBody: mockBodyStub('node-logical') }));
jest.mock('./ConstructDetails', () => ({ __esModule: true, ConstructExplorerBody: mockBodyStub('construct') }));
jest.mock('./NetworkDetails', () => ({ __esModule: true, default: mockBodyStub('network') }));
jest.mock('./ClusterLogicalTopologyDetails', () => ({ __esModule: true, ClusterLogicalTopologyBody: mockBodyStub('cluster-logical') }));

const coverage = {
    nns: items<NodeNetworkState>('nns', 'cluster-localnet-coverage.json'),
    cudns: items<ClusterUserDefinedNetwork>('cudn', 'cluster-localnet-coverage.json'),
    nads: items<NetworkAttachmentDefinition>('nad', 'cluster-localnet-coverage.json'),
};

const WORKERS = ['worker-1', 'worker-2', 'worker-3', 'worker-4'];

/** A collector answer: one switch port on the vlan-1924 CUDN, on worker-3. */
const lookupResponse = (value: string): LookupResponse => {
    const hit: LookupHit = {
        node: 'worker-3',
        table: 'Logical_Switch_Port',
        rowUuid: 'uuid-1',
        rowName: 'vlan-1924_blue_vm-a',
        construct: { kind: 'switch', name: 'cluster_udn_vlan-1924_ovn_layer2_switch', uuid: 'switch-uuid' },
        network: 'cluster_udn_vlan-1924',
        owner: { kind: 'Pod', namespace: 'blue', name: 'virt-launcher-vm-a-abcde' },
        matchedField: 'addresses',
        matchedValue: `02:00:00:00:00:01 ${value}`,
        matchType: 'exact',
        snapshotGeneratedAt: new Date().toISOString(),
    };
    return {
        query: { kind: 'ip', value },
        hits: [hit],
        total: 1,
        limit: 200,
        truncated: false,
        zones: WORKERS.map((node) => ({ node, snapshotGeneratedAt: new Date().toISOString(), sourceHealth: 'healthy' })),
        warnings: [],
    } as LookupResponse;
};

describe('OvnReconApp search (ovn-recon-gbr.8)', () => {
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
        Object.keys(mockWatches).forEach((key) => delete mockWatches[key]);
        mockWatches.NodeNetworkState = [coverage.nns, true, undefined];
        mockWatches.Node = [coverage.nns.map((nns) => ({ metadata: { name: nns.metadata?.name, labels: {} } })), true, undefined];
        mockWatches.ClusterUserDefinedNetwork = [coverage.cudns, true, undefined];
        mockWatches.NetworkAttachmentDefinition = [coverage.nads, true, undefined];
        global.fetch = jest.fn((url: string) => {
            const lookup = /\/lookup\/ip\/([^/]+)$/.exec(String(url));
            if (lookup) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve(lookupResponse(decodeURIComponent(lookup[1]))),
                    text: () => Promise.resolve(''),
                } as unknown as Response);
            }
            return Promise.reject(new Error('not served in this test'));
        }) as unknown as typeof fetch;
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        jest.restoreAllMocks();
    });

    const settle = async () => {
        for (let round = 0; round < 5; round += 1) {
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

    const go = async (to: string | number) => {
        await act(async () => {
            if (typeof to === 'number') navigate(to);
            else navigate(to);
        });
        await settle();
    };

    const byTestId = (id: string): HTMLElement | null => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    const marked = (): string[] => Array.from(container.querySelectorAll('[data-testid^="explorer-tree-matches-"]'))
        .map((element) => element.getAttribute('data-testid')!.replace('explorer-tree-matches-', ''));
    const mark = (id: string): string | null => byTestId(`explorer-tree-matches-${id}`)?.getAttribute('title') ?? null;
    const clusterTabs = (): string[] => Array.from(container.querySelectorAll('[data-testid^="cluster-tab-"]'))
        .map((tab) => tab.getAttribute('data-testid')!.replace('cluster-tab-', ''));
    const searchBox = (): HTMLInputElement => byTestId('explorer-search')!.querySelector('input')!;
    const switchInput = (): HTMLInputElement | null =>
        container.querySelector<HTMLInputElement>('#explorer-tree-matches-only');
    const groupMembers = (groupId: string): string[] => Array.from(
        byTestId(`explorer-tree-${groupId}`)?.closest('[role="treeitem"]')?.querySelectorAll('[role="group"] [role="treeitem"]') ?? [],
    ).map((item) => item.id);
    const click = async (element: Element | null) => {
        expect(element).not.toBeNull();
        await act(async () => {
            (element as HTMLElement).click();
        });
        await settle();
    };
    const clearBox = async () => {
        await click(byTestId('explorer-search')!.querySelector('button[aria-label="Reset"]'));
    };

    describe('with the collector disabled: node interfaces and kernel routes only', () => {
        it('marks the nodes that hold results, and keeps the search open while a result is followed', async () => {
            await render(searchPath('br-vmdata'));
            expect(marked()).toEqual(WORKERS.map(nodeItemId));
            expect(mark(nodeItemId('worker-1'))).toBe('1 search match');
            expect(clusterTabs()).toContain('search');

            // Follow a result: its link opens that node's graph with the interface selected.
            const link = Array.from(container.querySelectorAll<HTMLAnchorElement>('a'))
                .find((anchor) => anchor.getAttribute('href') === nodePhysicalPath('worker-2', 'iface:br-vmdata'));
            await click(link ?? null);
            expect(current).toEqual({ pathname: nodePhysicalPath('worker-2'), search: '?select=iface:br-vmdata' });
            // The search is still open: the box holds it and the tree still marks.
            expect(searchBox().value).toBe('br-vmdata');
            expect(marked()).toEqual(WORKERS.map(nodeItemId));

            // On Cluster the Search results tab is still there, and leads back.
            await go(networksPath());
            expect(clusterTabs()).toEqual(['nodes', 'networks', 'findings', 'search']);
            expect(byTestId('cluster-tab-search')?.getAttribute('href')).toBe(searchPath('br-vmdata'));

            // Back, twice, returns to the results.
            await go(-1);
            await go(-1);
            expect(current).toEqual({ pathname: `${BASE_PATH}/search`, search: '?q=br-vmdata' });
        });

        it('narrows the tree to what holds results with "Search matches only"', async () => {
            await render(searchPath('br-vmdata'));
            await click(switchInput());
            expect(groupMembers(NODES_GROUP_ID)).toEqual(WORKERS.map(nodeItemId));
            // No network holds a result of a node-interface search.
            expect(groupMembers(NETWORKS_GROUP_ID)).toEqual([]);
            await click(switchInput());
            expect(groupMembers(NODES_GROUP_ID)).toHaveLength(coverage.nns.length);
        });

        it('closes the tab, the marks and the switch when the box is cleared, from any page', async () => {
            await render(searchPath('br-vmdata'));
            await click(switchInput());
            await go(nodePhysicalPath('worker-1'));
            await clearBox();
            expect(current.pathname).toBe(nodePhysicalPath('worker-1'));
            expect(marked()).toEqual([]);
            expect(switchInput()).toBeNull();
            expect(groupMembers(NODES_GROUP_ID)).toHaveLength(coverage.nns.length);
            await go(overviewPath());
            expect(clusterTabs()).not.toContain('search');
        });

        it('cleared on the results tab, goes to the Nodes tab', async () => {
            await render(searchPath('br-vmdata'));
            await clearBox();
            expect(current).toEqual({ pathname: overviewPath(), search: '' });
            expect(clusterTabs()).not.toContain('search');
        });

        it('marks nothing for a search with no results', async () => {
            await render(searchPath('no-such-interface'));
            expect(marked()).toEqual([]);
            expect(switchInput()).toBeNull();
            expect(clusterTabs()).toContain('search');
        });
    });

    describe('with the collector enabled', () => {
        beforeEach(() => {
            mockGate.enabled = true;
        });

        it('marks the node and the CUDN a collector hit is on, and a closed group with their sum', async () => {
            await render(searchPath('198.51.100.7'));
            const cudn = networkItemId({ kind: 'cudn', name: 'vlan-1924' });
            expect(mark(nodeItemId('worker-3'))).toBe('1 search match');
            // Networks is closed: the group carries the mark.
            expect(mark(NETWORKS_GROUP_ID)).toBe('1 search match');
            await click(byTestId(`explorer-tree-${NETWORKS_GROUP_ID}`));
            expect(mark(cudn)).toBe('1 search match');
            expect(marked()).toEqual([nodeItemId('worker-3'), cudn]);
        });
    });
});
