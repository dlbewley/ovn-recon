import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { ClusterUserDefinedNetwork, NodeNetworkState } from '../types';
import NodeVisualization from './NodeVisualization';
import { LocationRecord, TestRouter } from './testRouter';
import { installFakeResizeObserver, resizeCanvases } from './canvasTestGeometry';
import { REVEAL_MARGIN_PX, svgMeetRegion, svgMeetScale, ViewportBox } from './canvasViewport';
import { toolbarButton } from './viewToolbarTestUtils';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    useK8sWatchResource: () => [[]]
}));

/**
 * The physical page beside its inline drawer (ovn-recon-dp7.7, ovn-recon-dp7.10).
 *
 * Inline, the drawer narrows the svg. The view keeps its scale through that:
 * the viewBox is cut to the narrower width rather than "meet"-fitted whole
 * into it, which is what shrank the graph to about two thirds on every
 * click. A selected node that the narrower canvas would hide is panned in by
 * the least amount; a visible one is left alone; closing the drawer puts
 * back a pan only the selection made; a deep link lands exactly where a click
 * from the default view does.
 *
 * jsdom lays nothing out, so sizes are mocked from the DOM's own state: the
 * drawer main is FRAME wide, the panel takes a third of it while the drawer
 * is expanded, and the svg is the rest less the content padding. The
 * browser's resize notification is delivered by hand.
 */

const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

/** DrawerContentBody's horizontal padding: 24 px each side. */
const CONTENT_PADDING = 48;
const SVG_HEIGHT = 700;

describe('NodeVisualization reveal beside the inline drawer', () => {
    let container: HTMLDivElement;
    let root: Root;
    let restoreResizeObserver: () => void;
    /** Width of the drawer main: about a 1400 px window by default. */
    let frame = 1100;
    /** Share of the drawer main the open panel takes. */
    let panelShare = 1 / 3;
    let lastLocation: LocationRecord | null = null;

    const drawerExpanded = () => container.querySelector('.pf-v6-c-drawer.pf-m-expanded') !== null;
    const panelWidth = () => (drawerExpanded() ? Math.round(frame * panelShare) : 0);
    const svgSize = () => ({ width: frame - panelWidth() - CONTENT_PADDING, height: SVG_HEIGHT });
    const closedSize = () => ({ width: frame - CONTENT_PADDING, height: SVG_HEIGHT });

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        frame = 1100;
        panelShare = 1 / 3;
        lastLocation = null;
        restoreResizeObserver = installFakeResizeObserver();
        const original = Element.prototype.getBoundingClientRect;
        jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
            let size: { width: number; height: number } | null = null;
            if (this.tagName.toLowerCase() === 'svg' && this.hasAttribute('preserveAspectRatio')) size = svgSize();
            else if (this.hasAttribute('data-canvas-frame')) size = { width: frame - panelWidth(), height: SVG_HEIGHT };
            else if (this.classList.contains('pf-v6-c-drawer__main')) size = { width: frame, height: SVG_HEIGHT };
            if (!size) return original.call(this);
            const { width, height } = size;
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
                <TestRouter initialEntry={entry} onLocation={(record) => { lastLocation = record; }}>
                    <NodeVisualization
                        nns={fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json')}
                        cudns={fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json')}
                        udns={[]} nads={[]} routeAdvertisements={[]}
                    />
                </TestRouter>
            );
        });
        settle();
    };
    /** A fresh page, as a reload with this URL would give. */
    const rerender = (entry: string) => {
        act(() => root.unmount());
        root = createRoot(container);
        render(entry);
    };

    /** Deliver the browser's resize notification for the current layout. */
    const settle = () => act(() => resizeCanvases());

    const svg = () => container.querySelector<SVGSVGElement>('svg[preserveAspectRatio]')!;
    /** The viewBox the svg is drawn with. */
    const viewBox = (): ViewportBox => {
        const [x, y, width, height] = svg().getAttribute('viewBox')!.split(' ').map(Number);
        return { x, y, width, height };
    };
    /** Screen pixels per content unit right now. */
    const scale = () => svgMeetScale(viewBox(), svgSize());
    /** What the svg shows right now. */
    const region = () => svgMeetRegion(viewBox(), svgSize());

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
    const nodeLabelled = (label: string) =>
        container.querySelector<SVGGElement>(`g[role="button"][aria-label^="${label} ("]`)!;
    /** The topmost node of the right-most lane: a network, beyond the drawer's edge. */
    const rightLaneNode = () => {
        const maxX = Math.max(...lanedNodes().map((group) => boxOf(group).x));
        return lanedNodes().filter((group) => boxOf(group).x === maxX)
            .reduce((best, group) => (boxOf(group).y < boxOf(best).y ? group : best));
    };

    const click = (element: Element) => {
        act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        settle();
    };
    const closeDrawer = () => click(container.querySelector('.pf-v6-c-drawer__close button')!);
    const zoomIn = (times = 1) => {
        const button = container.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!;
        for (let i = 0; i < times; i += 1) act(() => { button.click(); });
    };
    const resetView = () => {
        const button = toolbarButton(container, 'Reset view')!;
        act(() => { button.click(); });
    };
    const drag = (dx: number, dy: number) => {
        const fire = (type: string, x: number, y: number) =>
            act(() => { svg().dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })); });
        fire('mousedown', 400, 300);
        fire('mousemove', 400 + dx, 300 + dy);
        fire('mouseup', 400 + dx, 300 + dy);
    };

    it('renders the drawer inline, so it never covers the right-hand lanes', () => {
        render();
        click(rightLaneNode());
        const drawer = container.querySelector('.pf-v6-c-drawer');
        expect(drawer?.classList.contains('pf-m-inline')).toBe(true);
        expect(drawer?.classList.contains('pf-m-expanded')).toBe(true);
    });

    it('never changes the scale when the drawer opens, at the default zoom or the user\'s', () => {
        render();
        const defaultScale = scale();
        click(nodeLabelled('ens192'));
        expect(svgSize().width).toBeLessThan(closedSize().width);
        expect(scale()).toBeCloseTo(defaultScale, 6);
        closeDrawer();

        zoomIn(3);
        const zoomedScale = scale();
        expect(zoomedScale).toBeGreaterThan(defaultScale);
        click(rightLaneNode());
        expect(scale()).toBeCloseTo(zoomedScale, 6);
    });

    it('does not move at all when the selected node is already visible beside the drawer', () => {
        render();
        const before = viewBox();
        const target = nodeLabelled('ens192');
        click(target);
        expect(inside(boxOf(target), region())).toBe(true);
        expect(viewBox().x).toBe(before.x);
        expect(viewBox().y).toBe(before.y);
    });

    it.each([
        ['about 1400 px', 1100],
        ['about 1100 px', 800],
    ])('pans a right-hand lane node into view by the minimum amount at %s', (_label, width) => {
        frame = width;
        render();
        const target = rightLaneNode();
        const box = boxOf(target);
        // Visible in the full-width canvas, hidden once the drawer takes its third.
        expect(inside(box, region())).toBe(true);

        click(target);
        const view = region();
        expect(inside(box, view)).toBe(true);
        // Its right edge lands exactly the reveal margin inside the canvas: no further.
        expect(box.x + box.width).toBeCloseTo(view.x + view.width - REVEAL_MARGIN_PX / scale(), 6);
        // It was already in view vertically, so the view did not move vertically.
        expect(viewBox().y).toBe(0);
    });

    it('restores the earlier pan when the drawer closes', () => {
        render();
        zoomIn(2);
        drag(-30, -20);
        const userView = svg().getAttribute('viewBox');
        // The selection has to pan to show it beside the drawer.
        click(rightLaneNode());
        expect(svg().getAttribute('viewBox')).not.toBe(userView);
        closeDrawer();
        expect(svg().getAttribute('viewBox')).toBe(userView);
    });

    it('returns an untouched view to the default when the drawer closes (no left-over offset)', () => {
        render();
        const initial = svg().getAttribute('viewBox');
        click(rightLaneNode());
        expect(viewBox().x).toBeGreaterThan(0);
        closeDrawer();
        expect(svg().getAttribute('viewBox')).toBe(initial);
    });

    it('keeps a pan the user made while the drawer was open', () => {
        render();
        click(rightLaneNode());
        drag(25, 10);
        const userView = viewBox();
        closeDrawer();
        expect(viewBox().x).toBe(userView.x);
        expect(viewBox().y).toBe(userView.y);
    });

    it('keeps a zoom the user made while the drawer was open', () => {
        render();
        click(rightLaneNode());
        zoomIn();
        const userView = viewBox();
        const userScale = scale();
        closeDrawer();
        expect(viewBox().x).toBe(userView.x);
        expect(viewBox().y).toBe(userView.y);
        expect(scale()).toBeCloseTo(userScale, 6);
    });

    it.each([
        ['a visible node', () => nodeLabelled('ens192'), 1100],
        ['a right-hand lane node', () => rightLaneNode(), 1100],
        ['a right-hand lane node in a narrow window', () => rightLaneNode(), 800],
    ])('lands a deep link to %s exactly where a click from the default view does', (_label, target, width) => {
        frame = width;
        render();
        const defaultScale = scale();
        click(target());
        const clicked = svg().getAttribute('viewBox');
        const link = `${lastLocation!.pathname}${lastLocation!.search}`;
        expect(link).toMatch(/select=/);

        rerender(link);
        expect(drawerExpanded()).toBe(true);
        expect(svg().getAttribute('viewBox')).toBe(clicked);
        expect(scale()).toBeCloseTo(defaultScale, 6);
        expect(inside(boxOf(target()), region())).toBe(true);
    });

    it('draws a deep-linked visible node at the default scale and corner, not shrunk or pushed down-right', () => {
        render('/ovn-recon/node-network-state/worker-1?select=iface:ens192');
        expect(drawerExpanded()).toBe(true);
        expect(viewBox().x).toBe(0);
        expect(viewBox().y).toBe(0);
        const closedScale = svgMeetScale(viewBox(), svgSize());
        closeDrawer();
        expect(scale()).toBeCloseTo(closedScale, 6);
    });

    it('resets to the default scale and corner with the drawer open, and closed', () => {
        render();
        const initial = svg().getAttribute('viewBox');
        const defaultScale = scale();

        click(rightLaneNode());
        zoomIn(2);
        drag(-40, -40);
        resetView();
        expect(viewBox().x).toBe(0);
        expect(viewBox().y).toBe(0);
        expect(scale()).toBeCloseTo(defaultScale, 6);
        closeDrawer();
        expect(svg().getAttribute('viewBox')).toBe(initial);

        zoomIn(2);
        drag(-40, -40);
        resetView();
        expect(svg().getAttribute('viewBox')).toBe(initial);
    });

    it('keeps the selection visible by panning only when the drawer is widened', () => {
        render();
        const target = rightLaneNode();
        click(target);
        const openScale = scale();

        panelShare = 1 / 2;
        settle();
        expect(inside(boxOf(target), region())).toBe(true);
        expect(scale()).toBeCloseTo(openScale, 6);
    });
});
