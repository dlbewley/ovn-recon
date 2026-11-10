import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { ClusterUserDefinedNetwork, NodeNetworkState } from '../types';
import NodeVisualization from './NodeVisualization';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    useK8sWatchResource: () => [[]]
}));

/**
 * Kernel route tables in the drawer link their interfaces into the graph
 * (ovn-recon-dp7.2): a click moves the selection the way the Relationships
 * tab does, and an interface the canvas does not draw stays plain text.
 */
const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

describe('NodeVisualization route table links', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => {
            root.render(
                <NodeVisualization
                    nns={fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json')}
                    cudns={fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json')}
                    udns={[]} nads={[]} routeAdvertisements={[]}
                />
            );
        });
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const clickNode = (title: string) => {
        // Node groups are the ones drawing their own rect; the others are layout wrappers.
        const group = Array.from(container.querySelectorAll('g'))
            .filter((g) => Array.from(g.children).some((c) => c.tagName.toLowerCase() === 'rect'))
            .find((g) => g.querySelector('title')?.textContent === title);
        if (!group) throw new Error(`no node titled "${title}"`);
        act(() => { group.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    };

    const drawerTitle = () => container.querySelector('h2')?.textContent ?? '';
    const routeTable = () => container.querySelector('.pf-v6-c-drawer__panel [data-testid="kernel-route-table"]');
    const interfaceCells = () => Array.from(routeTable()?.querySelectorAll('td[data-label="Interface"]') ?? []);

    it('moves the selection to a drawn interface', () => {
        clickNode('example-p-cudn (VRF)');
        expect(drawerTitle()).toBe('example-p-cudn');
        const link = interfaceCells()
            .map((cell) => cell.querySelector('button'))
            .find((button) => button?.textContent === 'br-ex');
        expect(link).toBeDefined();
        act(() => link!.click());
        expect(drawerTitle()).toBe('br-ex');
        // The bridge's own drawer now lists the routes leaving through it.
        expect(container.querySelector('.pf-v6-c-drawer__panel')?.textContent).toContain('Routes via this interface');
    });

    it('leaves an interface the canvas does not draw as plain text', () => {
        // ovn-k8s-mp3 lives in the hidden lane until that lane is shown.
        clickNode('example-p-cudn (VRF)');
        const mp3 = interfaceCells().filter((cell) => cell.textContent === 'ovn-k8s-mp3');
        expect(mp3.length).toBeGreaterThan(0);
        mp3.forEach((cell) => expect(cell.querySelector('button')).toBeNull());
    });
});
