import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

import type { AddressOwner } from './addressBook';
import AddressOwners from './AddressOwners';
import { openInfoPopover } from './drawerKitTestUtils';
import { KernelRouteTable } from './KernelRouteTable';
import { routed } from './testRouter';

const pod = (network: string): AddressOwner => ({
    kind: 'pod',
    ref: { type: 'resource', resource: { apiVersion: 'v1', kind: 'Pod', namespace: 'blue', name: 'web' } },
    label: 'blue/web',
    node: 'cnv-1',
    network,
    provenance: [{ source: 'Logical_Switch_Port', record: 'blue_web', field: 'addresses', value: '10.0.0.5', zone: 'cnv-1' }],
});

const iface: AddressOwner = {
    kind: 'interface',
    ref: { type: 'interface', node: 'cnv-2', name: 'br-ex', graphId: 'iface:br-ex' },
    label: 'br-ex on cnv-2',
    node: 'cnv-2',
    provenance: [{ source: 'NodeNetworkState', record: 'cnv-2', field: 'br-ex address', value: '192.0.2.2/24' }],
};

const masquerade = (overrides: Partial<AddressOwner> & Pick<AddressOwner, 'masquerade'>): AddressOwner => ({
    kind: 'masquerade',
    ref: { type: 'masquerade', role: overrides.masquerade!.role, networkId: overrides.masquerade!.networkId },
    label: '',
    provenance: [{ source: 'Masquerade formula', record: '169.254.0.0/17', field: 'global role', value: '169.254.0.2' }],
    ...overrides,
});

const gatewayRouter = masquerade({
    ref: { type: 'masquerade', role: 'udn-gateway-router', networkId: 3, network: { kind: 'cudn', name: 'blue' } },
    network: 'cluster_udn_blue',
    masquerade: { role: 'udn-gateway-router', networkId: 3, subnet: '169.254.0.0/17', basis: 'both' },
});

const Owners = routed(AddressOwners);
const Routes = routed(KernelRouteTable);

describe('AddressOwners', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const render = (element: React.ReactElement) => act(() => root.render(element));

    it('draws nothing for an address nobody holds', () => {
        render(<Owners address="10.0.0.5" owners={[]} />);
        expect(container.textContent).toBe('');
    });

    it('names a single owner with a link', () => {
        render(<Owners address="192.0.2.2" owners={[iface]} />);
        const line = container.querySelector('[data-testid="address-owner"]')!;
        expect(line.textContent).toBe('Interface br-ex on cnv-2');
        expect(line.querySelector('a')?.getAttribute('href')).toBe(
            '/ovn-recon/node-network-state/cnv-2?select=iface:br-ex',
        );
    });

    it('says which network a lone owner on a user-defined network is on', () => {
        render(<Owners address="10.0.0.5" owners={[pod('cluster_udn_blue')]} />);
        expect(container.textContent).toBe('Pod blue/web (blue)');
    });

    it('does not pick among several owners, and lists them all by network', async () => {
        render(<Owners address="10.0.0.5" owners={[pod('default'), pod('cluster_udn_blue'), iface]} />);
        expect(container.querySelector('[data-testid="address-owner"]')).toBeNull();
        expect(container.querySelector('a')).toBeNull();
        const button = container.querySelector('button')!;
        expect(button.textContent).toBe('3 possible owners');

        const text = await openInfoPopover(button);
        expect(text).toContain('Default cluster network');
        expect(text).toContain('blue · Logical_Switch_Port blue_web');
        expect(text).toContain('Host network · NodeNetworkState cnv-2');
        expect(document.querySelectorAll('[data-testid="address-owner-list"] li')).toHaveLength(3);
    });

    it('names a global masquerade role, with no link', () => {
        const host = masquerade({ masquerade: { role: 'host', subnet: '169.254.0.0/17', basis: 'derived' } });
        render(<Owners address="169.254.0.2" owners={[host]} />);
        const line = container.querySelector('[data-testid="address-owner"]')!;
        expect(line.textContent).toBe('Host masquerade');
        expect(line.querySelector('a')).toBeNull();
    });

    it('links a network\'s masquerade address to the network', () => {
        render(<Owners address="169.254.0.15" owners={[gatewayRouter]} />);
        const line = container.querySelector('[data-testid="address-owner"]')!;
        expect(line.textContent).toBe('Gateway router masquerade of blue');
        expect(line.querySelector('a')?.getAttribute('href')).toBe('/ovn-recon/networks/cudn/blue');
    });

    it('names the network ID of a masquerade address no single network claims', () => {
        const unclaimed = masquerade({
            masquerade: {
                role: 'udn-management-port',
                networkId: 5,
                subnet: '169.254.0.0/17',
                basis: 'derived',
                ambiguous: ['CUDN green', 'UDN tenant-d/purple'],
            },
        });
        render(<Owners address="169.254.0.20" owners={[unclaimed]} />);
        expect(container.textContent).toBe(
            'Management port masquerade of network ID 5 (claimed by CUDN green and UDN tenant-d/purple)',
        );
    });

    it('lists a masquerade owner first with how it was established', async () => {
        render(<Owners address="169.254.0.15" owners={[gatewayRouter, pod('cluster_udn_blue')]} />);
        const text = await openInfoPopover(container.querySelector('button')!);
        expect(text).toContain('Gateway router masquerade of blue');
        expect(text).toContain('Masquerade subnet 169.254.0.0/17 · observed, and as the masquerade offsets place it');
    });

    it('lets the caller draw an owner it has its own link for', () => {
        render(<Owners address="10.0.0.5" owners={[pod('default')]} renderOwner={() => <b>mine</b>} />);
        expect(container.textContent).toBe('mine');
    });

    it('sits under a kernel route gateway, which keeps its address', () => {
        render(
            <Routes
                routes={[
                    { destination: '203.0.113.0/24', nextHopAddress: '192.0.2.2', nextHopInterface: 'br-ex', tableId: 254 },
                    { destination: '198.51.100.0/24', nextHopAddress: '192.0.2.9', nextHopInterface: 'br-ex', tableId: 254 },
                ]}
                gatewayOwners={(gateway) => (gateway === '192.0.2.2' ? [iface] : [])}
            />,
        );
        const cells = [...container.querySelectorAll('td[data-label="Gateway"]')];
        const held = cells.find((cell) => cell.querySelector('code')?.textContent === '192.0.2.2')!;
        expect(held.querySelector('[data-testid="address-owner"]')?.textContent).toBe('Interface br-ex on cnv-2');
        const free = cells.find((cell) => cell.querySelector('code')?.textContent === '192.0.2.9')!;
        expect(free.textContent).toBe('192.0.2.9');
    });
});
