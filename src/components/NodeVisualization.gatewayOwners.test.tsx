import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';
import { ClusterUserDefinedNetwork, LogicalTopologySnapshot, NodeNetworkState } from '../types';
import { rememberedCollectorSnapshot } from './collectorApi';
import NodeVisualizationComponent from './NodeVisualization';
import { routed } from './testRouter';

const NodeVisualization = routed(NodeVisualizationComponent);

let mockNodeNetworkStates: NodeNetworkState[] = [];

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    useK8sWatchResource: (resource: { groupVersionKind?: { kind?: string } } | null) =>
        (resource?.groupVersionKind?.kind === 'NodeNetworkState' ? [mockNodeNetworkStates, true] : [[]]),
}));

jest.mock('./collectorApi', () => ({
    ...jest.requireActual('./collectorApi'),
    rememberedCollectorSnapshot: jest.fn(() => null),
}));

const remembered = rememberedCollectorSnapshot as jest.MockedFunction<typeof rememberedCollectorSnapshot>;
const snapshot = cnv1 as unknown as LogicalTopologySnapshot;

const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

/** A second node holding the address the first routes its default route through. */
const peer: NodeNetworkState = {
    metadata: { name: 'worker-2' },
    status: {
        currentState: {
            interfaces: [
                { name: 'br-ex', type: 'ovs-interface', state: 'up', ipv4: { address: [{ ip: '192.0.2.1', 'prefix-length': 24 }] } },
            ],
        },
    },
};

/**
 * The physical drawer names who holds a kernel route's gateway, from what the page
 * already has: every node's NodeNetworkState, and the zone snapshot this tab remembers.
 */
describe('NodeVisualization gateway owners', () => {
    let container: HTMLDivElement;
    let root: Root;
    const nns = fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json');

    beforeEach(() => {
        mockNodeNetworkStates = [nns, peer];
        remembered.mockReset();
        remembered.mockReturnValue(null);
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const openVrf = (collectorEnabled: boolean) => {
        act(() => {
            root.render(
                <NodeVisualization
                    nns={nns}
                    cudns={fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json')}
                    udns={[]} nads={[]} routeAdvertisements={[]}
                    collectorEnabled={collectorEnabled}
                />
            );
        });
        const group = Array.from(container.querySelectorAll('g'))
            .filter((g) => Array.from(g.children).some((c) => c.tagName.toLowerCase() === 'rect'))
            .find((g) => g.querySelector('title')?.textContent === 'example-p-cudn (VRF)');
        act(() => { group!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    };

    const gatewayCell = (address: string) =>
        Array.from(container.querySelectorAll('.pf-v6-c-drawer__panel td[data-label="Gateway"]'))
            .find((cell) => cell.querySelector('code')?.textContent === address)!;
    const ownerOf = (address: string) =>
        gatewayCell(address).querySelector('[data-testid="address-owner"]');

    it('names another node\'s interface from the NodeNetworkStates it watches', () => {
        openVrf(false);
        const owner = ownerOf('192.0.2.1')!;
        expect(owner.textContent).toBe('Interface br-ex on worker-2');
        expect(owner.querySelector('a')?.getAttribute('href')).toBe(
            '/ovn-recon/node-network-state/worker-2?select=iface:br-ex',
        );
    });

    it('asks for no snapshot with the collector off, and leaves the logical gateway bare', () => {
        openVrf(false);
        expect(remembered).not.toHaveBeenCalled();
        expect(gatewayCell('10.1.2.1').textContent).toBe('10.1.2.1');
    });

    it('names the router port from a zone snapshot this tab remembers', () => {
        remembered.mockReturnValue(snapshot);
        openVrf(true);
        expect(remembered).toHaveBeenCalledWith('worker-1');
        expect(ownerOf('10.1.2.1')?.textContent).toBe(
            'Router port trtos-cluster_udn_example.p.cudn_ovn_layer2_switch (example-p-cudn)',
        );
    });

    it('does not read owners from the collector\'s sample data', () => {
        remembered.mockReturnValue({ ...snapshot, metadata: { ...snapshot.metadata, sourceHealth: 'degraded' } });
        openVrf(true);
        expect(gatewayCell('10.1.2.1').textContent).toBe('10.1.2.1');
    });
});
