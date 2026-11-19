import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { clone, loadFixture, loadItems } from '../insights/testing';
import type { ClusterUserDefinedNetwork, NetworkAttachmentDefinition, NodeNetworkState, UserDefinedNetwork } from '../types';
import { NETOBSERV_FULL, withNetobserv } from '../linkOut/testCapabilities';
import { CLUSTER_DEFAULT_NETWORK_TEXT } from './clusterDefaultNetwork';
import type { NetworkAddress } from './networkPageModel';
import { NetworkExplorerBody } from './NetworkDetails';
import { NetworkScopeHeader } from './NetworkScope';
import type { NetworkView } from './networkScopeModel';
import NetworksTable from './NetworksTable';
import { overviewNetworkRows } from './overviewModel';
import { TestRouter } from './testRouter';
import { constructDetailPath } from '../routes';
import type { ExplorerData } from './useExplorerData';

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

// "Nothing loaded" unless a test says otherwise, as jest.setup.js gives every suite.
const mockCapabilities = jest.fn();
jest.mock('../linkOut/useConsoleCapabilities', () => ({
    useConsoleCapabilities: () => mockCapabilities() ?? jest.requireActual('../linkOut/registry').NO_CAPABILITIES,
}));

jest.mock('./useOvnCollectorFeatureGate', () => ({
    useOvnCollectorFeatureGate: () => ({ ...mockGate }),
}));

const KINDS = ['NodeNetworkState', 'ClusterUserDefinedNetwork', 'UserDefinedNetwork', 'NetworkAttachmentDefinition', 'RouteAdvertisements'];

const coverageCudns = loadItems<ClusterUserDefinedNetwork>('cudn', 'cluster-localnet-coverage.json');
const coverageNads = loadItems<NetworkAttachmentDefinition>('nad', 'cluster-localnet-coverage.json');
const coverageNns = loadItems<NodeNetworkState>('nns', 'cluster-localnet-coverage.json');

const NMSTATE_SENTENCE = 'This cluster does not serve NodeNetworkState (it comes with the Kubernetes NMState Operator), '
    + 'so where this network is wired cannot be shown.';

/**
 * One network as the explorer draws it: the shell's network header (name, console
 * links, owner) over the network body (findings, summary, placement by node), and
 * the cluster Networks tab's table that replaced the old list page.
 */
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

    const inputs = () => ({
        cudns: mockWatches.ClusterUserDefinedNetwork as ClusterUserDefinedNetwork[],
        udns: mockWatches.UserDefinedNetwork as UserDefinedNetwork[],
        nads: mockWatches.NetworkAttachmentDefinition as NetworkAttachmentDefinition[],
        routeAdvertisements: [],
    });

    /** The network scope: the shell's header, from the watches the shell would hold, over the body. */
    const render = async (address: NetworkAddress) => {
        const view = { scope: 'network', tab: 'network', params: { network: address } } as unknown as NetworkView;
        const data = { networkInputs: inputs(), networksLoaded: true, networkRows: [] } as unknown as ExplorerData;
        await act(async () => {
            root.render(
                <TestRouter initialEntry="/ovn-recon">
                    <NetworkScopeHeader view={view} data={data} />
                    <NetworkExplorerBody address={address} />
                </TestRouter>,
            );
        });
    };

    /** The cluster Networks tab's table, with every network's placement. */
    const renderList = async () => {
        const rows = overviewNetworkRows(inputs(), mockWatches.NodeNetworkState as NodeNetworkState[], []);
        await act(async () => {
            root.render(
                <TestRouter initialEntry="/ovn-recon/networks">
                    <NetworksTable rows={rows} loaded inputs={inputs()} />
                </TestRouter>,
            );
        });
    };

    const text = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';
    const links = () => Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));

    it('lists every network with the nodes it is wired on', async () => {
        await renderList();
        const rows = container.querySelectorAll('tr[data-testid^="overview-network-"]');
        expect(rows).toHaveLength(6);
        expect(text('overview-network-cudn-vlan-1924')).toContain('4 of 10');
        expect(text('overview-network-cudn-vlan-333')).toContain('0 of 10');
        expect(text('overview-network-cudn-machinenet')).toContain('10 of 10');
        expect(links()).toContain('/ovn-recon/networks/cudn/vlan-1924');
    });

    it('shows a Localnet CUDN wired on some nodes, without a finding', async () => {
        await render({ kind: 'cudn', name: 'vlan-1924' });
        expect(text('network-summary')).toContain('physnet-vmdata');
        expect(text('placement-summary')).toBe('Wired on 4 of 10 nodes.');
        expect(container.querySelectorAll('tr[data-testid^="placement-"]')).toHaveLength(10);
        expect(text('placement-worker-1')).toContain('Wired');
        expect(text('placement-worker-1')).toContain('ens224 (ethernet), up, MTU 1500');
        expect(text('placement-worker-1')).toContain('1924');
        // Short names stay on one line beside the explorer's tree.
        expect(container.querySelector('[data-testid="placement-worker-1"] td[data-label="Bridge"]')?.className).toContain('pf-m-nowrap');
        expect(text('placement-control-1')).toContain('No bridge mapping names physnet-vmdata.');
        // The node name opens the node; the Physical link opens it on the network's mapping.
        expect(links()).toContain('/ovn-recon/node-network-state/worker-1');
        expect(links()).toContain('/ovn-recon/node-network-state/worker-1?select=ovn:physnet-vmdata');
        expect(links()).toContain('/ovn-recon/ovn/worker-1');
        expect(links()).toContain('/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/vlan-1924');
        expect(container.querySelector('[data-testid="network-findings"]')).toBeNull();
        expect(text('network-conditions')).toContain('NetworkCreated');
    });

    it('shows the localnet-unmapped finding once for a network mapped on no node', async () => {
        await render({ kind: 'cudn', name: 'vlan-333' });
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
        await render({ kind: 'cudn', name: 'example-p-cudn' });
        expect(text('placement-summary')).toBe('Wired on 2 of 2 nodes.');
        expect(text('placement-worker-2')).toContain('example-p-cudn');
        expect(text('placement-worker-2')).toContain('inferred');
        expect(text('placement-worker-2')).toContain('ovn-k8s-mp3');
        expect(links()).toContain('/ovn-recon/node-network-state/worker-2?select=vrf:example-p-cudn');
    });

    describe('a primary network\'s ID and masquerade IPs (ovn-recon-2n6.3)', () => {
        const gatewayRouterPath = constructDetailPath(
            'worker-1', 'router', 'GR_cluster_udn_example.p.cudn_worker-1', { tab: 'routes' },
        );

        beforeEach(() => {
            mockWatches.NodeNetworkState = [loadFixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json')];
            mockWatches.ClusterUserDefinedNetwork = loadItems<ClusterUserDefinedNetwork>('cudn', 'primary-cudn-vrf.json');
            mockWatches.NetworkAttachmentDefinition = [{
                metadata: {
                    name: 'example-p-cudn',
                    namespace: 'example',
                    annotations: { 'k8s.ovn.org/network-id': '3' },
                    ownerReferences: [{ apiVersion: 'k8s.ovn.org/v1', kind: 'ClusterUserDefinedNetwork', name: 'example-p-cudn', uid: 'x' }],
                },
                spec: { config: JSON.stringify({ type: 'ovn-k8s-cni-overlay', name: 'cluster_udn_example-p-cudn', topology: 'layer2', role: 'primary' }) },
            }];
        });

        it('shows the network ID and the masquerade pair with roles in the summary', async () => {
            await render({ kind: 'cudn', name: 'example-p-cudn' });
            const summary = text('network-summary');
            expect(summary).toContain('Network ID');
            expect(summary).toContain('169.254.0.15');
            expect(summary).toContain('Gateway router masquerade, IPv4, derived');
            expect(summary).toContain('169.254.0.16');
            expect(summary).toContain('Management port masquerade, IPv4, derived');
        });

        it('links a wired row to its gateway router on Routes and NAT with the collector on, not off', async () => {
            await render({ kind: 'cudn', name: 'example-p-cudn' });
            expect(container.querySelector('[data-testid="placement-gateway-router-worker-1"]')?.getAttribute('href'))
                .toBe(gatewayRouterPath);
            mockGate.enabled = false;
            await render({ kind: 'cudn', name: 'example-p-cudn' });
            expect(links()).not.toContain(gatewayRouterPath);
        });
    });

    it('offers a network\'s traffic in its header only when Network Observability can answer', async () => {
        const traffic = () => Array.from(container.querySelectorAll('[data-testid="secondary-links"] a'))
            .map((a) => [a.textContent, a.getAttribute('href')]);
        try {
            await render({ kind: 'cudn', name: 'vlan-1924' });
            expect(traffic()).toEqual([]);
            mockCapabilities.mockReturnValue(NETOBSERV_FULL);
            await render({ kind: 'cudn', name: 'vlan-1924' });
            expect(traffic()).toEqual([['View traffic', '/netflow-traffic?filters=udns%3Dvlan-1924']]);
            mockCapabilities.mockReturnValue(withNetobserv({ loki: true, nodeMetrics: true, features: new Set() }));
            await render({ kind: 'cudn', name: 'vlan-1924' });
            expect(traffic()).toEqual([]);
        } finally {
            mockCapabilities.mockReset();
        }
    });

    it('shows a namespaced UDN', async () => {
        const udn: UserDefinedNetwork = {
            metadata: { name: 'tenant-blue', namespace: 'blue' },
            spec: { topology: 'Layer2', layer2: { role: 'Secondary', subnets: ['10.20.0.0/24'] } },
        };
        mockWatches.UserDefinedNetwork = [udn];
        await render({ kind: 'udn', namespace: 'blue', name: 'tenant-blue' });
        expect(text('network-summary')).toContain('10.20.0.0/24');
        expect(text('placement-summary')).toContain('checks nothing node-local for a Secondary Layer2 network');
        expect(links()).toContain('/k8s/ns/blue/k8s.ovn.org~v1~UserDefinedNetwork/tenant-blue');
    });

    it('shows a NAD with no CUDN', async () => {
        mockWatches.NetworkAttachmentDefinition = [...coverageNads, ...loadItems<NetworkAttachmentDefinition>('nad', 'sriov.json')];
        await render({ kind: 'nad', namespace: 'default', name: 'vm-igb' });
        expect(text('network-summary')).toContain('sriov');
        expect(text('placement-summary')).toContain('checks nothing node-local');
        expect(container.querySelector('[data-testid="network-owner"]')).toBeNull();
    });

    it('names the CUDN behind a generated NAD', async () => {
        await render({ kind: 'nad', namespace: 'demo-mirror', name: 'vlan-1924' });
        expect(text('network-owner')).toContain('Generated by ClusterUserDefinedNetwork vlan-1924');
        expect(links()).toContain('/ovn-recon/networks/cudn/vlan-1924');
    });

    describe('the cluster default network', () => {
        const defaultNad: NetworkAttachmentDefinition = {
            metadata: { name: 'default', namespace: 'openshift-ovn-kubernetes' },
            spec: { config: '{"cniVersion":"0.4.0","name":"ovn-kubernetes","type":"ovn-k8s-cni-overlay"}' },
        };

        beforeEach(() => {
            mockWatches.NetworkAttachmentDefinition = [...coverageNads, defaultNad];
        });

        it('is named for what it is in the list, not given an unknown topology', async () => {
            await renderList();
            const row = text('overview-network-nad-openshift-ovn-kubernetes-default');
            expect(row).toContain('Cluster default network');
            expect(row).not.toContain('Unknown');
        });

        it('says what it is on its page', async () => {
            await render({ kind: 'nad', namespace: 'openshift-ovn-kubernetes', name: 'default' });
            expect(text('network-summary')).toContain('Cluster default network');
            expect(text('network-summary')).not.toContain('Unknown');
            expect(text('placement-summary')).toContain('checks nothing node-local for the cluster default network;');
            // Described with NodeNetworkState served too, and nothing is said to be missing.
            expect(text('cluster-default-description')).toBe(CLUSTER_DEFAULT_NETWORK_TEXT);
            expect(container.querySelector('[data-testid="placement-unavailable"]')).toBeNull();
        });

        describe('without NodeNetworkState', () => {
            const address: NetworkAddress = { kind: 'nad', namespace: 'openshift-ovn-kubernetes', name: 'default' };

            beforeEach(() => {
                mockModels.NodeNetworkState = undefined;
            });

            it('describes the network and says only what is lost', async () => {
                await render(address);
                expect(text('cluster-default-description')).toBe(CLUSTER_DEFAULT_NETWORK_TEXT);
                expect(text('placement-unavailable')).toBe(
                    'This cluster does not serve NodeNetworkState (it comes with the Kubernetes NMState Operator), '
                    + 'so the per-node physical detail (br-ex, uplinks) cannot be drawn.',
                );
                expect(container.textContent).not.toContain('cannot be shown');
            });

            it('names the namespaces with a primary UDN', async () => {
                mockWatches.UserDefinedNetwork = [
                    {
                        metadata: { name: 'tenant', namespace: 'blue' },
                        spec: { topology: 'Layer2', layer2: { role: 'Primary', subnets: ['10.20.0.0/24'] } },
                    },
                ];
                await render(address);
                expect(text('cluster-default-description')).toBe(
                    `${CLUSTER_DEFAULT_NETWORK_TEXT} Namespace with a primary UDN: blue.`,
                );
                expect(container.textContent).not.toContain('cannot be shown');
            });
        });
    });

    describe('a network that was not created', () => {
        const failed = (): ClusterUserDefinedNetwork[] => {
            const cudns = clone(coverageCudns);
            const target = cudns.find((cudn) => cudn.metadata?.name === 'vlan-333')!;
            target.status = {
                conditions: [{
                    type: 'NetworkCreated',
                    status: 'False',
                    reason: 'NetworkAttachmentDefinitionSyncError',
                    message: 'failed to create NetworkAttachmentDefinition in namespace demo',
                }],
            };
            return cudns;
        };

        beforeEach(() => {
            mockWatches.ClusterUserDefinedNetwork = failed();
        });

        it('leads its page with the failed condition and its message', async () => {
            await render({ kind: 'cudn', name: 'vlan-333' });
            const alert = container.querySelector('[data-testid="network-not-created"]')!;
            expect(alert.textContent).toContain('This network was not created: NetworkAttachmentDefinitionSyncError');
            expect(alert.textContent).toContain('failed to create NetworkAttachmentDefinition in namespace demo');
            // Before the summary, and before the findings.
            const summary = container.querySelector('[data-testid="network-summary"]')!;
            const findings = container.querySelector('[data-testid="network-findings"]')!;
            expect(alert.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
            expect(alert.compareDocumentPosition(findings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        });

        it('marks its row in the list, and no other', async () => {
            await renderList();
            expect(container.querySelectorAll('[data-testid="overview-network-not-created"]')).toHaveLength(1);
            expect(text('overview-network-cudn-vlan-333')).toContain('Not created');
            expect(text('overview-network-cudn-vlan-1924')).not.toContain('Not created');
        });

        it('says nothing on a network whose condition is True', async () => {
            await render({ kind: 'cudn', name: 'vlan-1924' });
            expect(container.querySelector('[data-testid="network-not-created"]')).toBeNull();
        });
    });

    it('lays the summary out one line per fact', async () => {
        await render({ kind: 'cudn', name: 'vlan-1924' });
        const list = container.querySelector('[data-testid="network-summary"] [data-testid="fact-rows"]')!;
        expect(list.className).toContain('pf-m-horizontal');
    });

    it('renders an empty state for an unknown name', async () => {
        await render({ kind: 'cudn', name: 'no-such-network' });
        expect(text('network-not-found')).toContain('No ClusterUserDefinedNetwork named no-such-network is visible.');
        expect(container.querySelector('[data-testid="network-not-found"] a')?.getAttribute('href')).toBe('/ovn-recon/networks');
    });

    it('renders the summary without the matrix when NodeNetworkState is not served', async () => {
        mockModels.NodeNetworkState = undefined;
        await render({ kind: 'cudn', name: 'vlan-1924' });
        expect(text('network-summary')).toContain('physnet-vmdata');
        expect(text('placement-unavailable')).toBe(NMSTATE_SENTENCE);
        expect(container.querySelector('[data-testid="cluster-default-description"]')).toBeNull();
        expect(container.querySelector('[data-testid="placement-summary"]')).toBeNull();
        // Without NodeNetworkState the mapped-nowhere rule has nothing to read.
        expect(container.querySelector('[data-testid="network-findings"]')).toBeNull();
    });

    it('keeps the NodeNetworkState sentence for a UDN and a NAD', async () => {
        mockModels.NodeNetworkState = undefined;
        mockWatches.UserDefinedNetwork = [{
            metadata: { name: 'tenant-blue', namespace: 'blue' },
            spec: { topology: 'Layer2', layer2: { role: 'Secondary', subnets: ['10.20.0.0/24'] } },
        }];
        mockWatches.NetworkAttachmentDefinition = [...coverageNads, ...loadItems<NetworkAttachmentDefinition>('nad', 'sriov.json')];
        await render({ kind: 'udn', namespace: 'blue', name: 'tenant-blue' });
        expect(text('placement-unavailable')).toBe(NMSTATE_SENTENCE);
        await render({ kind: 'nad', namespace: 'default', name: 'vm-igb' });
        expect(text('placement-unavailable')).toBe(NMSTATE_SENTENCE);
    });

    it('leaves out the logical links when the collector is off', async () => {
        mockGate.enabled = false;
        await render({ kind: 'cudn', name: 'vlan-1924' });
        expect(links()).not.toContain('/ovn-recon/ovn/worker-1');
    });
});
