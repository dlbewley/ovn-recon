import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { ClusterUserDefinedNetwork, NodeNetworkState } from '../types';
import OvnReconOverview from './OvnReconOverview';
import { TestRouter } from './testRouter';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';

const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

// Mutable so tests can vary what each watch returns; jest.mock factories may
// only close over identifiers prefixed `mock`.
const mockWatches: Record<string, unknown[]> = {};
const mockGate = { enabled: true, loaded: true, loadError: undefined as Error | undefined };

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    DocumentTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useK8sWatchResource: (resource: { groupVersionKind: { kind: string } }) =>
        [mockWatches[resource.groupVersionKind.kind] ?? [], true, undefined],
}));

jest.mock('./useOvnCollectorFeatureGate', () => ({
    useOvnCollectorFeatureGate: () => ({ ...mockGate }),
}));

describe('OvnReconOverview', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        mockGate.enabled = true;
        mockGate.loaded = true;
        const bonded = fixture<NodeNetworkState>('nns', 'bonded-lldp.json');
        const basic = fixture<NodeNetworkState>('nns', 'basic-host.json');
        mockWatches.NodeNetworkState = [bonded, basic];
        mockWatches.Node = [
            { metadata: { name: bonded.metadata?.name, labels: { 'node-role.kubernetes.io/worker': '' } } },
            { metadata: { name: basic.metadata?.name, labels: { 'node-role.kubernetes.io/control-plane': '' } } },
        ];
        mockWatches.ClusterUserDefinedNetwork = fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json');
        mockWatches.UserDefinedNetwork = [];
        mockWatches.NetworkAttachmentDefinition = [];
        mockWatches.RouteAdvertisements = [{}];
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                metadata: { schemaVersion: '2', generatedAt: new Date().toISOString(), sourceHealth: 'healthy' },
                snapshots: [{ ...cnv1, metadata: { ...cnv1.metadata, generatedAt: new Date().toISOString() } }],
                warnings: [{ code: 'X', message: 'one warning' }],
            }),
        }) as unknown as typeof fetch;
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        jest.restoreAllMocks();
    });

    // The search box reads and writes the page URL, so the page needs a router.
    const render = async (initialEntry = '/ovn-recon') => {
        await act(async () => {
            root.render(
                <TestRouter initialEntry={initialEntry}>
                    <OvnReconOverview />
                </TestRouter>,
            );
        });
        await act(async () => {
            await Promise.resolve();
        });
    };

    const text = () => container.textContent ?? '';
    const row = (name: string) => container.querySelector(`[data-testid="overview-node-${name}"]`);

    const collectorStatus = () => container.querySelector('[data-testid="overview-collector-status"]');
    // PatternFly mounts the popover in document.body.
    const openCollectorDetails = async (): Promise<string> => {
        const button = Array.from(collectorStatus()!.querySelectorAll('button'))
            .find((candidate) => candidate.textContent === 'Collector details');
        expect(button).toBeDefined();
        await act(async () => {
            button!.click();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        return document.querySelector('[data-testid="overview-collector-details"]')?.textContent ?? '';
    };

    it('states the collector in one line, with the rest behind Collector details', async () => {
        await render();

        const collector = collectorStatus();
        expect(collector).not.toBeNull();
        expect(collector!.textContent).toContain('Cluster logical topology');
        expect(collector!.textContent).toContain('Fresh');
        expect(collector!.textContent).toContain('Assembled from 1 node');
        expect(collector!.textContent).toContain('1 collector warning');
        expect(collector!.querySelector('a[href="/ovn-recon/ovn"]')!.textContent).toBe('Open cluster view');
        // The line itself stays short: the warning's text is in the popover.
        expect(collector!.textContent).not.toContain('one warning');

        const details = await openCollectorDetails();
        expect(details).toContain('Source healthhealthy');
        expect(details).toContain('Node databases1');
        expect(details).toContain('Oldest snapshot');
        expect(details).toContain('X: one warning');
    });

    it('lists the networks in a table where the counts were, and the fleet with the nodes', async () => {
        await render();

        const networks = container.querySelector('[data-testid="overview-networks-card"]');
        expect(networks!.querySelector('a[href="/ovn-recon/networks"]')!.textContent).toBe('Networks');
        const cudns = fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json');
        expect(networks!.querySelectorAll('[data-testid^="overview-network-cudn-"]')).toHaveLength(cudns.length);
        expect(Array.from(networks!.querySelectorAll('th')).map((th) => th.textContent))
            .toEqual(['Name', 'Kind', 'Topology', 'Role', 'Nodes wired', 'Findings']);
        expect(networks!.querySelector('dl')).toBeNull();

        const nodes = container.querySelector('[data-testid="overview-nodes-card"]');
        expect(nodes!.textContent).toContain('2 nodes with NodeNetworkState');
        const fleet = container.querySelector('[data-testid="overview-fleet-summary"]');
        expect(fleet!.textContent).toContain('29 bridge mappings across');
        expect(fleet!.textContent).toContain('1 node reports LLDP neighbors');
    });

    it('gives each node its role, counts and the three views', async () => {
        await render();

        const bonded = row('worker-2.example.com');
        expect(bonded).not.toBeNull();
        expect(bonded!.textContent).toContain('worker');
        expect(bonded!.textContent).toContain('13 up / 31');
        expect(bonded!.textContent).toContain('br-ex');
        expect(bonded!.textContent).not.toContain('br-int');
        expect(bonded!.querySelector('a[href="/ovn-recon/node-network-state/worker-2.example.com"]')).not.toBeNull();
        expect(bonded!.querySelector('a[href="/ovn-recon/ovn/worker-2.example.com"]')).not.toBeNull();
        expect(bonded!.querySelector('a[href="/k8s/cluster/nmstate.io~v1beta1~NodeNetworkState/worker-2.example.com"]')).not.toBeNull();

        const basic = row(fixture<NodeNetworkState>('nns', 'basic-host.json').metadata!.name!);
        expect(basic!.textContent).toContain('control plane');
        expect(basic!.textContent).toContain('4 up / 4');
    });

    it('says the collector is not enabled, and drops the logical links, when the gate is off', async () => {
        mockGate.enabled = false;
        await render();

        expect(collectorStatus()!.textContent).toContain('Collector not enabled');
        expect(collectorStatus()!.textContent).not.toContain('Fresh');
        expect(container.querySelector('a[href^="/ovn-recon/ovn"]')).toBeNull();
        expect(global.fetch).not.toHaveBeenCalled();
        expect(await openCollectorDetails()).toContain('spec.collector.enabled');
        // The other cards and the table are unaffected.
        expect(container.querySelector('[data-testid="overview-networks-card"]')).not.toBeNull();
        expect(row('worker-2.example.com')).not.toBeNull();
    });

    it('says nothing about the collector until the gate is known', async () => {
        mockGate.loaded = false;
        await render();

        expect(collectorStatus()!.textContent).toBe('Cluster logical topologyLoading...');
        expect(collectorStatus()!.querySelector('button')).toBeNull();
    });

    it('filters the node table by name', async () => {
        await render();
        const input = container.querySelector<HTMLInputElement>('input[aria-label="Filter nodes by name"]');
        expect(input).not.toBeNull();

        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            setter?.call(input, 'example');
            input!.dispatchEvent(new Event('input', { bubbles: true }));
        });

        expect(row('worker-2.example.com')).not.toBeNull();
        expect(container.querySelectorAll('[data-testid^="overview-node-"]')).toHaveLength(1);
        expect(text()).toContain('1 of 2 nodes');
    });

    it('leads with the cluster search, above the cards', async () => {
        await render();

        const search = container.querySelector('[data-testid="overview-search"]');
        const networks = container.querySelector('[data-testid="overview-networks-card"]');
        expect(search).not.toBeNull();
        expect(search!.compareDocumentPosition(networks!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // Nothing is searched until a search is submitted.
        expect(container.querySelector('[data-testid="search-results"]')).toBeNull();
        expect((global.fetch as jest.Mock).mock.calls.some(([url]) => String(url).includes('/lookup/'))).toBe(false);
    });

    it('searches the NodeNetworkStates it already watches, and says so when the collector is off', async () => {
        mockGate.enabled = false;
        await render('/ovn-recon?q=bond2');

        const group = container.querySelector('[data-testid="search-group-node-interface"]');
        expect(group).not.toBeNull();
        expect(group!.textContent).toContain('bond2');
        expect(group!.querySelector('a[href="/ovn-recon/node-network-state/worker-2.example.com?select=iface:bond2"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="search-partial"]')!.textContent).toContain('the collector is not enabled');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('shows the collector as unreachable without hiding the rest of the page', async () => {
        (global.fetch as jest.Mock).mockRejectedValue(new Error('boom'));
        await render();

        expect(collectorStatus()!.textContent).toContain('Collector unreachable');
        expect(collectorStatus()!.querySelector('a[href="/ovn-recon/ovn"]')).not.toBeNull();
        expect(await openCollectorDetails()).toContain('The collector did not answer: ');
        expect(row('worker-2.example.com')).not.toBeNull();
    });
});
