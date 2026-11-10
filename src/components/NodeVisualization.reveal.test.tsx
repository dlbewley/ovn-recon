import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { ClusterUserDefinedNetwork, NodeNetworkState } from '../types';
import NodeVisualization from './NodeVisualization';
import { TestRouter } from './testRouter';
import { installFakeResizeObserver, resizeCanvases } from './canvasTestGeometry';
import { svgMeetRegion, ViewportBox } from './canvasViewport';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    useK8sWatchResource: () => [[]]
}));

/**
 * The physical page beside its inline drawer (ovn-recon-dp7.7). The overlay
 * drawer covered the right-hand lanes (Networks, Attachments, NADs), so
 * selecting a network covered it. Inline, the svg narrows and its viewBox is
 * fitted into what is left; a selected node that would not be wholly visible
 * is panned in, a visible one is left alone, and the user's pan and zoom
 * survive the drawer opening and closing. jsdom lays nothing out, so the
 * svg's size is mocked and the browser's resize notification delivered by
 * hand.
 */

const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

describe('NodeVisualization reveal beside the inline drawer', () => {
    const CLOSED = { width: 1300, height: 700 };
    const OPEN = { width: 860, height: 700 };

    let container: HTMLDivElement;
    let root: Root;
    let restoreResizeObserver: () => void;
    let svgSize = CLOSED;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        svgSize = CLOSED;
        restoreResizeObserver = installFakeResizeObserver();
        const original = Element.prototype.getBoundingClientRect;
        jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
            if (!(this.tagName.toLowerCase() === 'svg' && this.hasAttribute('preserveAspectRatio'))) {
                return original.call(this);
            }
            const { width, height } = svgSize;
            return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
        });
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        restoreResizeObserver();
        jest.restoreAllMocks();
    });

    const render = (entry = '/ovn-recon/node-network-state/worker-1') => {
        act(() => {
            root.render(
                <TestRouter initialEntry={entry}>
                    <NodeVisualization
                        nns={fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json')}
                        cudns={fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json')}
                        udns={[]} nads={[]} routeAdvertisements={[]}
                    />
                </TestRouter>
            );
        });
    };

    const svg = () => container.querySelector<SVGSVGElement>('svg[preserveAspectRatio]')!;
    const viewBox = (): ViewportBox => {
        const [x, y, width, height] = svg().getAttribute('viewBox')!.split(' ').map(Number);
        return { x, y, width, height };
    };
    /** What the svg shows right now at the mocked size. */
    const region = () => svgMeetRegion(viewBox(), svgSize);

    /** Laned nodes, whose transform is their absolute canvas position. */
    const lanedNodes = () =>
        Array.from(container.querySelectorAll<SVGGElement>('svg[preserveAspectRatio] > g[role="button"]'));
    const boxOf = (group: SVGGElement): ViewportBox => {
        const [, x, y] = group.getAttribute('transform')!.match(/translate\(([\d.-]+), ([\d.-]+)\)/)!.map(Number);
        const rect = group.querySelector('rect')!;
        return { x, y, width: Number(rect.getAttribute('width')), height: Number(rect.getAttribute('height')) };
    };
    const inside = (box: ViewportBox, view: ViewportBox) =>
        box.x >= view.x - 0.01 && box.y >= view.y - 0.01
        && box.x + box.width <= view.x + view.width + 0.01 && box.y + box.height <= view.y + view.height + 0.01;

    const rightmost = () => lanedNodes().reduce((best, group) => (boxOf(group).x > boxOf(best).x ? group : best));

    const layOut = (size: { width: number; height: number }) => {
        svgSize = size;
        act(() => resizeCanvases());
    };
    const click = (element: Element) =>
        act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const zoomIn = (times: number) => {
        const button = container.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!;
        for (let i = 0; i < times; i += 1) act(() => { button.click(); });
    };

    it('renders the drawer inline, so it never covers the right-hand lanes', () => {
        render();
        click(rightmost());
        const drawer = container.querySelector('.pf-v6-c-drawer');
        expect(drawer?.classList.contains('pf-m-inline')).toBe(true);
        expect(drawer?.classList.contains('pf-m-expanded')).toBe(true);
    });

    it('pans a right-lane node into view when it is selected off-screen', () => {
        render();
        zoomIn(10);
        const target = rightmost();
        expect(inside(boxOf(target), region())).toBe(false);

        click(target);
        layOut(OPEN);
        expect(inside(boxOf(rightmost()), region())).toBe(true);
    });

    it('leaves the view alone when the selected node is already wholly visible', () => {
        render();
        zoomIn(2);
        const target = lanedNodes().find((group) => inside(boxOf(group), svgMeetRegion(viewBox(), OPEN)));
        expect(target).toBeDefined();
        const before = svg().getAttribute('viewBox');

        click(target!);
        layOut(OPEN);
        expect(svg().getAttribute('viewBox')).toBe(before);
    });

    it('keeps pan and zoom through opening and closing the drawer', () => {
        render();
        zoomIn(2);
        // The user pans.
        act(() => { svg().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 400, clientY: 300, button: 0 })); });
        act(() => { svg().dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 380, clientY: 290, button: 0 })); });
        act(() => { svg().dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 380, clientY: 290, button: 0 })); });
        const userView = svg().getAttribute('viewBox');
        const target = lanedNodes().find((group) => {
            const box = boxOf(group);
            const view = svgMeetRegion(viewBox(), OPEN);
            return inside({ x: box.x - 20, y: box.y - 20, width: box.width + 40, height: box.height + 40 }, view);
        });
        expect(target).toBeDefined();

        click(target!);
        layOut(OPEN);
        expect(svg().getAttribute('viewBox')).toBe(userView);

        click(container.querySelector('.pf-v6-c-drawer__close button')!);
        expect(container.querySelector('.pf-v6-c-drawer.pf-m-expanded')).toBeNull();
        layOut(CLOSED);
        expect(svg().getAttribute('viewBox')).toBe(userView);
    });

    it('centres a deep-linked node in the visible canvas, and keeps it centred as the drawer opens', () => {
        render('/ovn-recon/node-network-state/worker-1?select=iface:ens192');
        layOut(OPEN);
        const group = container.querySelector<SVGGElement>('g[role="button"][aria-label^="ens192 ("]')!;
        const box = boxOf(group);
        const view = region();
        expect(box.x + box.width / 2).toBeCloseTo(view.x + view.width / 2, 0);
        expect(box.y + box.height / 2).toBeCloseTo(view.y + view.height / 2, 0);
    });
});
