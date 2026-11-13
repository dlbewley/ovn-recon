import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, NavigateFunction, Route, Routes, useLocation, useNavigate } from 'react-router';

import { loadItems } from '../insights/testing';
import { BASE_PATH, networkPath, networksPath, nodePhysicalPath } from '../routes';
import type { ClusterUserDefinedNetwork, NetworkAttachmentDefinition, NodeNetworkState } from '../types';
import { networkItemId, nodeItemId } from './explorerTreeModel';
import OvnReconApp from './OvnReconApp';

/**
 * The explorer's network scope (ovn-recon-gbr.6) with the network page's body drawn
 * for real, from the ten-node localnet-coverage capture: the URL opens inside the
 * shell under one heading, a placement row's node link selects that node, and a URL
 * naming a network nobody can see says so instead of loading for good.
 */

const mockWatches: Record<string, unknown[]> = {};
const mockTitles: string[] = [];

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    // The console's sets the document title; recorded here so a clash would show.
    DocumentTitle: ({ children }: { children: string }) => {
        mockTitles.push(children);
        return null;
    },
    useK8sModel: (gvk: { kind: string }) => [{ kind: gvk.kind }, false],
    useK8sWatchResource: (resource: { groupVersionKind: { kind: string } } | null) =>
        (resource ? [mockWatches[resource.groupVersionKind.kind] ?? [], true, undefined] : [undefined, true, undefined]),
}));

jest.mock('./useOvnCollectorFeatureGate', () => ({
    useOvnCollectorFeatureGate: () => ({ enabled: false, loaded: true, loadError: null }),
}));

jest.mock('./NodeNetworkStateDetails', () => ({
    __esModule: true,
    NodeNetworkStateBody: ({ name }: { name: string }) => <div data-testid="physical-body">physical {name}</div>,
}));

const coverage = {
    nns: loadItems<NodeNetworkState>('nns', 'cluster-localnet-coverage.json'),
    cudns: loadItems<ClusterUserDefinedNetwork>('cudn', 'cluster-localnet-coverage.json'),
    nads: loadItems<NetworkAttachmentDefinition>('nad', 'cluster-localnet-coverage.json'),
};

describe('OvnReconApp: the network scope, with the network body', () => {
    let container: HTMLDivElement;
    let root: Root;
    let current: { pathname: string; search: string };
    let navigate: NavigateFunction;

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
        mockTitles.length = 0;
        mockWatches.NodeNetworkState = coverage.nns;
        mockWatches.Node = coverage.nns.map((nns) => ({ metadata: { name: nns.metadata?.name, labels: {} } }));
        mockWatches.ClusterUserDefinedNetwork = coverage.cudns;
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
        for (let round = 0; round < 4; round += 1) {
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

    const byTestId = (id: string): HTMLElement | null => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    const selectedTreeIds = (): string[] =>
        Array.from(container.querySelectorAll('[role="treeitem"][aria-selected="true"]')).map((item) => item.id);

    it('opens a network inside the shell: header, summary and placement, under one heading', async () => {
        await render(networkPath({ kind: 'cudn', name: 'vlan-1924' }));
        expect(byTestId('network-scope-name')?.textContent).toBe('vlan-1924');
        expect(byTestId('network-summary')?.textContent).toContain('physnet-vmdata');
        expect(byTestId('placement-summary')?.textContent).toBe('Wired on 4 of 10 nodes.');
        expect(container.querySelectorAll('h1')).toHaveLength(1);
        expect(container.querySelector('.pf-v6-c-breadcrumb')).toBeNull();
        expect(mockTitles[mockTitles.length - 1]).toBe('OVN Recon - vlan-1924');
        expect(selectedTreeIds()).toEqual([networkItemId({ kind: 'cudn', name: 'vlan-1924' })]);
    });

    it('selects a node from its placement row', async () => {
        await render(networkPath({ kind: 'cudn', name: 'vlan-1924' }));
        const link = byTestId('placement-node-worker-1')!;
        expect(link.getAttribute('href')).toBe(nodePhysicalPath('worker-1'));
        await act(async () => {
            link.click();
        });
        await settle();
        expect(current.pathname).toBe(nodePhysicalPath('worker-1'));
        expect(selectedTreeIds()).toEqual([nodeItemId('worker-1')]);
        expect(byTestId('node-scope-header')).not.toBeNull();
        expect(byTestId('physical-body')?.textContent).toBe('physical worker-1');
    });

    it('says a network nobody can see is not found, rather than loading for good', async () => {
        await render(networkPath({ kind: 'cudn', name: 'no-such-network' }));
        expect(byTestId('network-scope-name')?.textContent).toBe('no-such-network');
        expect(byTestId('network-not-found')?.textContent)
            .toContain('No ClusterUserDefinedNetwork named no-such-network is visible.');
        expect(container.querySelector('[aria-label="Loading the network"]')).toBeNull();
        expect(byTestId('explorer-not-found')).toBeNull();
        expect(selectedTreeIds()).toEqual([]);
        expect(container.querySelectorAll('h1')).toHaveLength(1);

        await act(async () => {
            byTestId('network-not-found')!.querySelector('a')!.click();
        });
        await settle();
        expect(current.pathname).toBe(networksPath());
    });

    it('shows the network once it appears, after reporting it missing', async () => {
        await render(networkPath({ kind: 'cudn', name: 'late' }));
        expect(byTestId('network-not-found')).not.toBeNull();
        mockWatches.ClusterUserDefinedNetwork = [
            ...coverage.cudns,
            {
                apiVersion: 'k8s.ovn.org/v1',
                kind: 'ClusterUserDefinedNetwork',
                metadata: { name: 'late' },
                spec: { network: { topology: 'Layer2', layer2: { role: 'Secondary', subnets: ['10.9.0.0/24'] } } },
            } as unknown as ClusterUserDefinedNetwork,
        ];
        // A fresh watch result: re-render through a hop away and back.
        await act(async () => {
            navigate(networksPath());
        });
        await settle();
        await act(async () => {
            navigate(networkPath({ kind: 'cudn', name: 'late' }));
        });
        await settle();
        expect(byTestId('network-not-found')).toBeNull();
        expect(byTestId('network-summary')?.textContent).toContain('10.9.0.0/24');
    });
});
