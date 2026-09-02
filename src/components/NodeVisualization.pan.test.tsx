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
 * Panning the physical topology (ovn-recon-4mq).
 *
 * A plain left drag on the background pans, the same gesture the logical
 * topology uses. Shift used to be required here and nowhere else. The cost of
 * dropping it is that every background press now starts a candidate pan, so
 * these tests pin the click-versus-drag boundary: a click (with a pixel of
 * jitter) still closes the drawer, and a real drag never does.
 */

const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

describe('NodeVisualization background pan', () => {
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
        // jsdom lays nothing out; the pan math divides by the rendered size.
        svg().getBoundingClientRect = () =>
            ({ x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 800, width: 1000, height: 800, toJSON: () => ({}) });
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    /** The topology canvas, not one of the PatternFly icon svgs that precede it. */
    const svg = () => {
        const element = container.querySelector<SVGSVGElement>('svg[preserveAspectRatio]');
        if (!element) throw new Error('no topology svg rendered');
        return element;
    };

    const viewBoxX = () => Number(svg().getAttribute('viewBox')?.split(' ')[0]);

    const mouse = (type: string, x: number, y: number, init: MouseEventInit = {}) => {
        act(() => {
            svg().dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, ...init }));
        });
    };

    const drag = (from: [number, number], to: [number, number], init: MouseEventInit = {}) => {
        mouse('mousedown', from[0], from[1], init);
        mouse('mousemove', to[0], to[1], init);
        mouse('mouseup', to[0], to[1], init);
        mouse('click', to[0], to[1], init);
    };

    const nodeGroups = () =>
        Array.from(container.querySelectorAll('g'))
            .filter((g) => Array.from(g.children).some((c) => c.tagName.toLowerCase() === 'rect'));

    const openDrawer = () => {
        const group = nodeGroups()[0];
        act(() => { group.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        expect(container.querySelector('.pf-v6-c-drawer__panel')).not.toBeNull();
    };

    const drawerOpen = () => container.querySelector('.pf-v6-c-drawer__panel') !== null;

    it('pans on a plain left drag, no modifier', () => {
        const before = viewBoxX();
        drag([100, 100], [160, 100]);
        expect(viewBoxX()).toBeLessThan(before);
    });

    it('still pans with the middle button', () => {
        const before = viewBoxX();
        drag([100, 100], [160, 100], { button: 1 });
        expect(viewBoxX()).toBeLessThan(before);
    });

    it('does not pan when the press starts on a node', () => {
        const before = viewBoxX();
        const group = nodeGroups()[0];
        act(() => {
            group.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100, clientY: 100, button: 0 }));
        });
        mouse('mousemove', 160, 100);
        mouse('mouseup', 160, 100);
        expect(viewBoxX()).toBe(before);
    });

    it('a drag that ends on the background leaves the drawer open', () => {
        openDrawer();
        drag([100, 100], [160, 100]);
        expect(drawerOpen()).toBe(true);
    });

    it('a clean background click closes the drawer', () => {
        openDrawer();
        drag([100, 100], [100, 100]);
        expect(drawerOpen()).toBe(false);
    });

    it('a click with a pixel of jitter is still a click, not a pan', () => {
        openDrawer();
        const before = viewBoxX();
        drag([100, 100], [101, 101]);
        expect(drawerOpen()).toBe(false);
        expect(viewBoxX()).toBe(before);
    });

    it('advertises drag-to-pan without Shift', () => {
        expect(container.textContent).toContain('Drag to pan');
        expect(container.textContent).not.toContain('Shift');
    });
});
