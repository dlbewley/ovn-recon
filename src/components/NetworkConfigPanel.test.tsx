import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';

import { networkPath } from '../routes';
import type { NetworkAttachmentDefinition } from '../types';
import { buildCnoConfigModel, CnoConfigInputs, NO_CNO_CONFIG_INPUTS, Source } from './cnoConfigModel';
import NetworkConfigPanel from './NetworkConfigPanel';

/**
 * The Network config tab's masquerade subnet card (ovn-recon-n7r.4): the subnet in
 * effect, its capacity, and the address layout behind a toggle.
 */

const fixture = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'network-config', 'default.json'), 'utf-8'),
);

const ok = <T,>(data: T): Source<T> => ({ status: 'ok', data });
const absent: Source<never> = { status: 'absent' };

const nad = (namespace: string, name: string, networkName: string, networkId: string): NetworkAttachmentDefinition => ({
    apiVersion: 'k8s.cni.cncf.io/v1',
    kind: 'NetworkAttachmentDefinition',
    metadata: { namespace, name, annotations: { 'k8s.ovn.org/network-id': networkId } },
    spec: { config: JSON.stringify({ name: networkName, role: 'primary', topology: 'layer2', type: 'ovn-k8s-cni-overlay' }) },
});

const inputs = (extra: Partial<CnoConfigInputs> = {}): CnoConfigInputs => ({
    ...NO_CNO_CONFIG_INPUTS,
    operatorNetwork: ok(fixture.operatorNetwork),
    configNetwork: ok(fixture.configNetwork),
    clusterOperator: ok(fixture.clusterOperator),
    featureGate: ok(fixture.featureGate),
    infrastructure: ok(fixture.infrastructure),
    configMaps: { appliedCluster: absent, mtu: absent, overrides: absent, gatewayMode: absent },
    ...extra,
});

describe('NetworkConfigPanel: the masquerade subnet', () => {
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

    const render = (extra: Partial<CnoConfigInputs> = {}) => {
        act(() => {
            root.render(
                <MemoryRouter>
                    <NetworkConfigPanel model={buildCnoConfigModel(inputs(extra))} />
                </MemoryRouter>,
            );
        });
    };
    const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`);

    it('shows the subnet in effect, its source and its capacity', () => {
        render({
            nodes: [{ metadata: { name: 'a', annotations: { 'k8s.ovn.org/node-masquerade-subnet': '{"ipv4":"169.254.0.0/17"}' } } }],
        });
        const row = byId('network-config-masquerade-ipv4');
        expect(row?.getAttribute('data-source')).toBe('node-annotation');
        expect(row?.querySelector('[data-testid="network-config-masquerade-subnet"]')?.textContent).toBe('169.254.0.0/17');
        expect(row?.textContent).toContain('Reported by 1 node');
        expect(row?.textContent).toContain('k8s.ovn.org/node-masquerade-subnet');
        expect(row?.querySelector('[data-testid="network-config-masquerade-capacity"]')?.textContent).toBe('Room for network IDs 1 to 16378');
        expect(byId('network-config-masquerade-ipv6')).toBeNull();
        expect(byId('network-config-masquerade-usage')?.textContent).toContain('No network ID is in use');
        expect(byId('network-config-masquerade-immutable')?.textContent).toContain('cannot be changed once a user-defined network exists');
    });

    it('comes after the addressing section', () => {
        render();
        const cards = [...container.querySelectorAll('[data-testid^="network-config-section-"], [data-testid="network-config-masquerade"]')]
            .map((card) => card.getAttribute('data-testid'));
        expect(cards.indexOf('network-config-masquerade')).toBe(cards.indexOf('network-config-section-addressing') + 1);
    });

    it('opens the address layout, with each network linked to its page', () => {
        render({
            cudns: [{ metadata: { name: 'blue' } }] as CnoConfigInputs['cudns'],
            nads: [nad('tenant-a', 'blue', 'cluster_udn_blue', '3')],
        });
        const toggle = byId('network-config-masquerade')?.querySelector('button');
        expect(toggle?.textContent).toContain('Address layout of 169.254.0.0/17');
        expect(toggle?.getAttribute('aria-expanded')).toBe('false');
        act(() => toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        expect(toggle?.getAttribute('aria-expanded')).toBe('true');
        const card = byId('network-config-masquerade');
        expect(card?.textContent).toContain('169.254.0.1');
        expect(card?.textContent).toContain('OVN masquerade');
        const network = byId('network-config-masquerade-network-3');
        expect(network?.textContent).toContain('169.254.0.15');
        expect(network?.textContent).toContain('169.254.0.16');
        const link = network?.querySelector('a');
        expect(link?.textContent).toBe('CUDN blue');
        expect(link?.getAttribute('href')).toBe(networkPath({ kind: 'cudn', name: 'blue' }));
        expect(byId('network-config-masquerade-usage')?.textContent).toContain('1 network ID in use (highest 3)');
    });

    it('warns on a subnet too small for the networks that exist', () => {
        render({
            nodes: [{ metadata: { name: 'a', annotations: { 'k8s.ovn.org/node-masquerade-subnet': '{"ipv4":"169.254.169.0/29"}' } } }],
            nads: [nad('tenant-a', 'blue', 'tenant-a_blue', '3')],
        });
        expect(byId('network-config-masquerade-capacity')?.textContent).toBe('No room for any network');
        expect(byId('network-config-masquerade-note-too-small')?.textContent).toContain('cannot work on it');
    });
});
