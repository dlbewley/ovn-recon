import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { clone, loadFixture, loadItems } from '../insights/testing';
import type { ClusterUserDefinedNetwork, NetworkAttachmentDefinition, NodeNetworkState, UserDefinedNetwork } from '../types';
import NetworkDetails from './NetworkDetails';
import { TestRouter } from './testRouter';

// Mutable so tests can vary what each watch returns; jest.mock factories may only
// close over identifiers prefixed `mock`.
const mockWatches: Record<string, unknown[]> = {};
const mockModels: Record<string, { kind: string } | undefined> = {};
const mockGate = { enabled: true, loaded: true, loadError: undefined as Error | undefined };

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    DocumentTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useK8sModel: (gvk: { kind: string }) => [mockModels[gvk.kind], false],
    useK8sWatchResource: (resource: { groupVersionKind: { kind: string } } | null) =>
        (resource ? [mockWatches[resource.groupVersionKind.kind] ?? [], true, undefined] : [undefined, true, undefined]),
}));

jest.mock('./useOvnCollectorFeatureGate', () => ({
    useOvnCollectorFeatureGate: () => ({ ...mockGate }),
}));

const KINDS = ['NodeNetworkState', 'ClusterUserDefinedNetwork', 'UserDefinedNetwork', 'NetworkAttachmentDefinition', 'RouteAdvertisements'];

const coverageCudns = loadItems<ClusterUserDefinedNetwork>('cudn', 'cluster-localnet-coverage.json');
const coverageNads = loadItems<NetworkAttachmentDefinition>('nad', 'cluster-localnet-coverage.json');
const coverageNns = loadItems<NodeNetworkState>('nns', 'cluster-localnet-coverage.json');

describe('NetworkDetails', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        mockGate.enabled = true;
        KINDS.forEach((kind) => { mockModels[kind] = { kind }; });
        mockWatches.NodeNetworkState = coverageNns;
        mockWatches.ClusterUserDefinedNetwork = coverageCudns;
        mockWatches.UserDefinedNetwork = [];
        mockWatches.NetworkAttachmentDefinition = coverageNads;
        mockWatches.RouteAdvertisements = [];
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const render = async (path: string) => {
        await act(async () => {
            root.render(
                <TestRouter initialEntry={path}>
                    <NetworkDetails />
                </TestRouter>,
            );
        });
    };

    const text = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';
    const links = () => Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));

    it('lists every network with the nodes it is wired on', async () => {
        await render('/ovn-recon/networks');
        const rows = container.querySelectorAll('[data-testid^="network-row-"]');
        expect(rows).toHaveLength(6);
        expect(text('network-row-cudn-vlan-1924')).toContain('4 of 10');
        expect(text('network-row-cudn-vlan-333')).toContain('0 of 10');
        expect(text('network-row-cudn-machinenet')).toContain('10 of 10');
        expect(links()).toContain('/ovn-recon/networks/cudn/vlan-1924');
    });

    it('shows a Localnet CUDN wired on some nodes, without a finding', async () => {
        await render('/ovn-recon/networks/cudn/vlan-1924');
        expect(container.querySelector('h1')?.textContent).toBe('vlan-1924');
        expect(text('network-summary')).toContain('physnet-vmdata');
        expect(text('placement-summary')).toBe('Wired on 4 of 10 nodes.');
        expect(container.querySelectorAll('tr[data-testid^="placement-"]')).toHaveLength(10);
        expect(text('placement-worker-1')).toContain('Wired');
        expect(text('placement-worker-1')).toContain('ens224 (ethernet), up, MTU 1500');
        expect(text('placement-worker-1')).toContain('1924');
        expect(text('placement-control-1')).toContain('No bridge mapping names physnet-vmdata.');
        expect(links()).toContain('/ovn-recon/node-network-state/worker-1?select=ovn:physnet-vmdata');
        expect(links()).toContain('/ovn-recon/ovn/worker-1');
        expect(links()).toContain('/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/vlan-1924');
        expect(container.querySelector('[data-testid="network-findings"]')).toBeNull();
        expect(text('network-conditions')).toContain('NetworkCreated');
    });

    it('shows the localnet-unmapped finding once for a network mapped on no node', async () => {
        await render('/ovn-recon/networks/cudn/vlan-333');
        expect(container.querySelectorAll('[data-testid="network-finding-localnet-unmapped"]')).toHaveLength(1);
        expect(text('network-finding-localnet-unmapped')).toContain('which no node maps to a bridge');
        expect(text('placement-summary')).toBe('Wired on 0 of 10 nodes.');
    });

    it('shows a Primary Layer2 CUDN with its VRF on each node', async () => {
        const worker1 = loadFixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json');
        const worker2 = clone(worker1);
        worker2.metadata = { name: 'worker-2' };
        mockWatches.NodeNetworkState = [worker1, worker2];
        mockWatches.ClusterUserDefinedNetwork = loadItems<ClusterUserDefinedNetwork>('cudn', 'primary-cudn-vrf.json');
        mockWatches.NetworkAttachmentDefinition = [];
        await render('/ovn-recon/networks/cudn/example-p-cudn');
        expect(text('placement-summary')).toBe('Wired on 2 of 2 nodes.');
        expect(text('placement-worker-2')).toContain('example-p-cudn');
        expect(text('placement-worker-2')).toContain('inferred');
        expect(text('placement-worker-2')).toContain('ovn-k8s-mp3');
        expect(links()).toContain('/ovn-recon/node-network-state/worker-2?select=vrf:example-p-cudn');
    });

    it('shows a namespaced UDN', async () => {
        const udn: UserDefinedNetwork = {
            metadata: { name: 'tenant-blue', namespace: 'blue' },
            spec: { topology: 'Layer2', layer2: { role: 'Secondary', subnets: ['10.20.0.0/24'] } },
        };
        mockWatches.UserDefinedNetwork = [udn];
        await render('/ovn-recon/networks/udn/blue/tenant-blue');
        expect(container.querySelector('h1')?.textContent).toBe('blue/tenant-blue');
        expect(text('network-summary')).toContain('10.20.0.0/24');
        expect(text('placement-summary')).toContain('checks nothing node-local for a Secondary Layer2 network');
        expect(links()).toContain('/k8s/ns/blue/k8s.ovn.org~v1~UserDefinedNetwork/tenant-blue');
    });

    it('shows a NAD with no CUDN', async () => {
        mockWatches.NetworkAttachmentDefinition = [...coverageNads, ...loadItems<NetworkAttachmentDefinition>('nad', 'sriov.json')];
        await render('/ovn-recon/networks/nad/default/vm-igb');
        expect(container.querySelector('h1')?.textContent).toBe('default/vm-igb');
        expect(text('network-summary')).toContain('sriov');
        expect(text('placement-summary')).toContain('checks nothing node-local');
        expect(container.querySelector('[data-testid="network-owner"]')).toBeNull();
    });

    it('names the CUDN behind a generated NAD', async () => {
        await render('/ovn-recon/networks/nad/demo-mirror/vlan-1924');
        expect(text('network-owner')).toContain('Generated by ClusterUserDefinedNetwork vlan-1924');
        expect(links()).toContain('/ovn-recon/networks/cudn/vlan-1924');
    });

    it('renders an empty state for an unknown name', async () => {
        await render('/ovn-recon/networks/cudn/no-such-network');
        expect(text('network-not-found')).toContain('No network named no-such-network');
    });

    it('renders the summary without the matrix when NodeNetworkState is not served', async () => {
        mockModels.NodeNetworkState = undefined;
        await render('/ovn-recon/networks/cudn/vlan-1924');
        expect(text('network-summary')).toContain('physnet-vmdata');
        expect(text('placement-unavailable')).toContain('does not serve NodeNetworkState');
        expect(container.querySelector('[data-testid="placement-summary"]')).toBeNull();
        // Without NodeNetworkState the mapped-nowhere rule has nothing to read.
        expect(container.querySelector('[data-testid="network-findings"]')).toBeNull();
    });

    it('leaves out the logical links when the collector is off', async () => {
        mockGate.enabled = false;
        await render('/ovn-recon/networks/cudn/vlan-1924');
        expect(links()).not.toContain('/ovn-recon/ovn/worker-1');
    });
});
