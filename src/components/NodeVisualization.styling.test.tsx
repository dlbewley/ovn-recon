import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { ClusterUserDefinedNetwork, NodeNetworkState } from '../types';
import { descriptorFor } from '../topology/descriptors';
import { STATUS_STYLE, SURFACE } from '../topology/palette';
import NodeVisualizationComponent from './NodeVisualization';
import { routed } from './testRouter';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    useK8sWatchResource: () => [[]]
}));

/**
 * The node card (ovn-recon-nt4.1): a neutral surface, the kind as an icon and an
 * accent stripe, the state as a PatternFly status icon, and a selection ring that
 * does not depend on keyboard focus.
 */
const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

const NodeVisualization = routed(NodeVisualizationComponent);

describe('NodeVisualization node cards', () => {
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

    const node = (label: string) => Array.from(container.querySelectorAll('g[role="button"]'))
        .find((g) => g.getAttribute('aria-label') === label)!;
    const statusOf = (label: string) =>
        node(label).querySelector('[data-testid="node-status"] [data-status]')?.getAttribute('data-status');
    const ring = (label: string) => node(label).querySelector('rect')!.getAttribute('stroke-width');

    it('draws a neutral card with the kind in its accent stripe and icon', () => {
        const ens192 = node('ens192 (ethernet)');
        expect(ens192.querySelector('rect')!.getAttribute('fill')).toBe(SURFACE.card);
        const physical = descriptorFor('physical')!;
        expect(ens192.querySelector('[data-accent]')!.getAttribute('fill')).toBe(physical.color);
        expect(ens192.querySelector<HTMLElement>('foreignObject div')!.style.color).toBe(physical.color);
        const cudn = node('machinenet (CUDN)');
        expect(cudn.querySelector('[data-accent]')!.getAttribute('fill')).toBe(descriptorFor('cudn')!.color);
    });

    it('marks state with a status icon, and a down interface in the danger text colour', () => {
        expect(statusOf('ens192 (ethernet)')).toBe('up');
        expect(statusOf('ens161 (ethernet)')).toBe('down');
        const stateLine = Array.from(node('ens161 (ethernet)').querySelectorAll('text'))
            .find((text) => text.textContent === 'down')!;
        expect(stateLine.getAttribute('fill')).toBe(STATUS_STYLE.down.text);
        // nmstate's "ignore" is not down: it used to draw the same red dot.
        expect(statusOf('genev_sys_6081 (unknown)')).toBe('unknown');
        // Kinds with no up/down carry no state icon.
        expect(node('machinenet (CUDN)').querySelector('[data-testid="node-status"]')).toBeNull();
    });

    it('keeps the selected node ringed after focus moves away', () => {
        act(() => { node('ens192 (ethernet)').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        act(() => { node('ens192 (ethernet)').dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
        expect(ring('ens192 (ethernet)')).toBe('3');
        expect(ring('ens161 (ethernet)')).toBe('1');
    });

    it('lights the selected path in the brand colour, not a fixed blue', () => {
        act(() => { node('ens192 (ethernet)').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        const lit = Array.from(container.querySelectorAll('line, path[d^="M "]'))
            .filter((edge) => edge.getAttribute('stroke-width') === '4');
        expect(lit.length).toBeGreaterThan(0);
        lit.forEach((edge) => expect(edge.getAttribute('stroke')).toBe(SURFACE.flow));
    });

    it('offers the legend from the toolbar', () => {
        expect(Array.from(container.querySelectorAll('button')).map((b) => b.textContent)).toContain('Legend');
    });
});
