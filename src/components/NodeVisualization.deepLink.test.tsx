import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { ClusterUserDefinedNetwork, NodeNetworkState } from '../types';
import NodeVisualization from './NodeVisualization';
import { LocationRecord, TestRouter } from './testRouter';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    useK8sWatchResource: () => [[]]
}));

/**
 * select=<canonical node id> on the physical view (ovn-recon-s3t.16): a link
 * opens the node page with that box selected, its flow path lit and its drawer
 * open; clicks are written back with replace and closing the drawer removes it.
 */

const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

describe('NodeVisualization deep-linked selection', () => {
    let container: HTMLDivElement;
    let root: Root;
    let locations: LocationRecord[];
    const current = () => locations[locations.length - 1];

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        locations = [];
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const render = (entry: string, nns = 'primary-cudn-vrf.json') => {
        act(() => {
            root.render(
                <TestRouter initialEntry={entry} onLocation={(record) => locations.push(record)}>
                    <NodeVisualization
                        nns={fixture<NodeNetworkState>('nns', nns)}
                        cudns={fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json')}
                        udns={[]} nads={[]} routeAdvertisements={[]}
                    />
                </TestRouter>
            );
        });
    };

    const drawerTitle = () =>
        container.querySelector('.pf-v6-c-drawer.pf-m-expanded h2')?.textContent ?? null;

    /** A drawn node by its accessible name, which is "<label> (<type>)". */
    const nodeGroup = (label: string) =>
        container.querySelector<SVGGElement>(`g[role="button"][aria-label^="${label} ("]`);
    const dimmed = () =>
        Array.from(container.querySelectorAll<SVGGElement>('g[role="button"]'))
            .filter((g) => g.style.opacity === '0.3');

    it('restores the selection from the URL with its drawer and highlight', () => {
        render('/ovn-recon/node-network-state/worker-1?select=iface:ens192');
        expect(drawerTitle()).toContain('ens192');
        // The flow path is lit: off-path nodes dim, the selected one does not.
        expect(dimmed().length).toBeGreaterThan(0);
        expect(dimmed()).not.toContain(nodeGroup('ens192'));
        expect(current().search).toBe('?select=iface:ens192');
    });

    it('ignores an id the canvas does not draw', () => {
        render('/ovn-recon/node-network-state/worker-1?select=iface:no-such-nic');
        expect(drawerTitle()).toBeNull();
        expect(nodeGroup('ens192')).not.toBeNull();
        expect(dimmed()).toEqual([]);
    });

    it('turns on a hidden lane to select a node in it (ovn-recon-tpp.7)', () => {
        const toggle = () => container.querySelector<HTMLInputElement>('#show-hidden-columns-toggle')!;
        // An OVS internal port nmstate reports up sits in Logical Interfaces, hidden
        // by default. (One reported state: ignore is drawn in no view at all.)
        render('/ovn-recon/node-network-state/worker-1', 'basic-host.json');
        expect(toggle().checked).toBe(false);
        expect(nodeGroup('ovn-k8s-mp0')).toBeNull();
        act(() => root.unmount());
        root = createRoot(container);

        render('/ovn-recon/node-network-state/worker-1?select=iface:ovn-k8s-mp0', 'basic-host.json');
        expect(toggle().checked).toBe(true);
        expect(nodeGroup('ovn-k8s-mp0')).not.toBeNull();
        expect(drawerTitle()).toContain('ovn-k8s-mp0');
        expect(dimmed()).not.toContain(nodeGroup('ovn-k8s-mp0'));
        expect(current().search).toBe('?select=iface:ovn-k8s-mp0');
    });

    it('writes a click with replace, keeps other parameters, and removes it on close', () => {
        render('/ovn-recon/node-network-state/worker-1?keep=1');
        act(() => { nodeGroup('ens192')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        expect(current().search).toBe('?keep=1&select=iface:ens192');
        expect(current().navigationType).toBe('REPLACE');

        act(() => { container.querySelector<HTMLButtonElement>('.pf-v6-c-drawer__close button')!.click(); });
        expect(drawerTitle()).toBeNull();
        expect(current().search).toBe('?keep=1');
        expect(current().pathname).toBe('/ovn-recon/node-network-state/worker-1');
        expect(locations.some((record) => record.navigationType === 'PUSH')).toBe(false);
    });
});
