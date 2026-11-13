import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { NodeLogicalTopologyBody } from './NodeLogicalTopologyDetails';
import { TestRouter } from './testRouter';
import {
    drawnCardBoxIn,
    fitsIn,
    installFakeResizeObserver,
    ladderScreenBox,
    ladderTransform,
    resizeCanvases,
} from './canvasTestGeometry';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    DocumentTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useK8sWatchResource: () => [[], true, undefined],
}));

jest.mock('./useOvnCollectorFeatureGate', () => ({
    useOvnCollectorFeatureGate: () => ({ enabled: true, loaded: true, loadError: undefined }),
}));

jest.mock('react-router', () => ({
    ...jest.requireActual('react-router'),
    Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={String(to)}>{children}</a>,
}));

/**
 * The selected card stays visible beside the inline drawer (ovn-recon-dp7.7).
 *
 * The overlay drawer covered the right half of the canvas, and the reveal
 * centred against the whole canvas (and 130px off, ignoring the tier-label
 * gutter), so a deep link or a search Enter left the card underneath it. The
 * drawer is now inline: the canvas shrinks beside it. jsdom lays nothing out,
 * so the canvas size is mocked the way the bead measured it, 1310px wide with
 * the drawer closed and 655px beside a half-width drawer, and the browser's
 * resize notification is delivered by hand once the "layout" has changed.
 */
describe('NodeLogicalTopologyBody reveal beside the inline drawer', () => {
    const CLOSED = { width: 1310, height: 700 };
    const OPEN = { width: 655, height: 700 };

    let container: HTMLDivElement;
    let root: Root;
    let restoreResizeObserver: () => void;
    let canvasSize = CLOSED;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        canvasSize = CLOSED;
        restoreResizeObserver = installFakeResizeObserver();
        const original = Element.prototype.getBoundingClientRect;
        jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
            if ((this as HTMLElement).dataset?.testid !== 'ladder-canvas') return original.call(this);
            const { width, height } = canvasSize;
            return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
        });
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => cnv1 }) as unknown as typeof fetch;
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        restoreResizeObserver();
        jest.restoreAllMocks();
    });

    const load = async (entry = '/ovn-recon/ovn/cnv-1') => {
        await act(async () => {
            root.render(
                <TestRouter initialEntry={entry}>
                    <NodeLogicalTopologyBody name="cnv-1" />
                </TestRouter>,
            );
        });
        await act(async () => { await Promise.resolve(); });
    };

    const drawerOpen = () => container.querySelector('.pf-v6-c-drawer.pf-m-expanded') !== null;

    /** The browser lays out the narrower canvas and tells the observers. */
    const layOut = (size: { width: number; height: number }) => {
        canvasSize = size;
        act(() => resizeCanvases());
    };

    const centreX = (name: string) => {
        const box = ladderScreenBox(container, name);
        return box.x + box.width / 2;
    };

    const drag = (canvas: Element, from: MouseEventInit, to: MouseEventInit) => {
        act(() => { canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ...from })); });
        act(() => { canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, ...to })); });
        act(() => { canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, ...to })); });
    };

    const click = (element: Element) =>
        act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    it('renders the drawer inline, so it never covers the canvas', async () => {
        await load('/ovn-recon/ovn/cnv-1?select=switch:transit_switch');
        const drawer = container.querySelector('.pf-v6-c-drawer');
        expect(drawer?.classList.contains('pf-m-inline')).toBe(true);
        expect(drawer?.classList.contains('pf-m-expanded')).toBe(true);
    });

    it('centres a deep-linked card in the canvas left beside the drawer', async () => {
        await load('/ovn-recon/ovn/cnv-1?select=switch:transit_switch');
        expect(drawerOpen()).toBe(true);
        // Before the layout settles the reveal could only use the old width:
        // centred in 1310px, which is beyond the right edge of 655px.
        expect(fitsIn(ladderScreenBox(container, 'transit_switch'), OPEN)).toBe(false);

        layOut(OPEN);
        expect(fitsIn(ladderScreenBox(container, 'transit_switch'), OPEN)).toBe(true);
        expect(centreX('transit_switch')).toBeCloseTo(OPEN.width / 2, 0);
    });

    it('centres the match selected by Enter in the ladder search', async () => {
        await load();
        const search = container.querySelector<HTMLInputElement>('input[aria-label="Search constructs"]')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'transit');
        act(() => { search.dispatchEvent(new Event('input', { bubbles: true })); });
        await act(async () => {
            search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        expect(drawerOpen()).toBe(true);

        layOut(OPEN);
        expect(fitsIn(ladderScreenBox(container, 'transit_switch'), OPEN)).toBe(true);
        expect(centreX('transit_switch')).toBeCloseTo(OPEN.width / 2, 0);
    });

    it('centres the card reached through a Relationships link', async () => {
        await load('/ovn-recon/ovn/cnv-1?select=router:GR_cnv-1');
        layOut(OPEN);
        const tab = [...container.querySelectorAll('.pf-v6-c-drawer__panel button')]
            .find((button) => button.textContent === 'Relationships')!;
        click(tab);
        const entry = [...container.querySelectorAll('.pf-v6-c-drawer__panel button')]
            .find((button) => button.textContent?.includes('Join switch'))!;
        expect(entry).toBeDefined();
        click(entry);

        expect(container.querySelector('.pf-v6-c-drawer__head h2')?.textContent).toContain('Join switch');
        expect(fitsIn(ladderScreenBox(container, 'join'), OPEN)).toBe(true);
        expect(centreX('join')).toBeCloseTo(OPEN.width / 2, 0);
    });

    it('keeps a revealed card centred while the drawer is resized', async () => {
        await load('/ovn-recon/ovn/cnv-1?select=switch:transit_switch');
        layOut(OPEN);
        layOut({ width: 500, height: 700 });
        expect(centreX('transit_switch')).toBeCloseTo(250, 0);
        layOut({ width: 900, height: 700 });
        expect(centreX('transit_switch')).toBeCloseTo(450, 0);
    });

    it('pans a clicked card into view only when the drawer would hide it, and only as far as needed', async () => {
        await load();
        // A card past the right edge of the narrowed canvas but visible now.
        const names = [...container.querySelectorAll('[data-testid^="construct-"]')]
            .map((card) => card.getAttribute('data-testid')!.slice('construct-'.length));
        const hidden = names.find((name) => {
            const box = drawnCardBoxIn(container, name);
            return box.x > OPEN.width && box.x + box.width < CLOSED.width - 16
                && box.y >= 16 && box.y + box.height <= CLOSED.height - 16;
        });
        expect(hidden).toBeDefined();
        click(container.querySelector(`[data-testid="construct-${hidden}"]`)!);
        // Wholly visible at the old width: nothing moves yet.
        expect(ladderTransform(container)).toBe('translate(0px, 0px) scale(1)');

        layOut(OPEN);
        const box = ladderScreenBox(container, hidden!);
        expect(fitsIn(box, OPEN)).toBe(true);
        // Minimal: its right edge sits at the margin, not centred.
        expect(box.x + box.width).toBeCloseTo(OPEN.width - 16, 0);
    });

    it('does not move a clicked card that stays visible, and keeps pan and zoom through open and close', async () => {
        await load();
        const canvas = container.querySelector('[data-testid="ladder-canvas"]')!;
        // The user zooms and pans first.
        const plus = [...container.querySelectorAll('button')].find((button) => button.textContent === '+')!;
        click(plus);
        drag(canvas, { bubbles: true, clientX: 100, clientY: 100 }, { bubbles: true, clientX: 140, clientY: 120 });
        const userView = ladderTransform(container);
        expect(userView).toBe('translate(40px, 20px) scale(1.1)');

        const names = [...container.querySelectorAll('[data-testid^="construct-"]')]
            .map((card) => card.getAttribute('data-testid')!.slice('construct-'.length));
        const visible = names.find((name) => {
            const box = ladderScreenBox(container, name);
            return box.x >= 16 && box.x + box.width <= OPEN.width - 16 && box.y >= 16 && box.y + box.height <= OPEN.height - 16;
        });
        expect(visible).toBeDefined();
        click(container.querySelector(`[data-testid="construct-${visible}"]`)!);
        expect(drawerOpen()).toBe(true);
        layOut(OPEN);
        expect(ladderTransform(container)).toBe(userView);

        click(container.querySelector('.pf-v6-c-drawer__close button')!);
        expect(drawerOpen()).toBe(false);
        layOut(CLOSED);
        expect(ladderTransform(container)).toBe(userView);
    });

    it('stops re-centring once the user pans', async () => {
        await load('/ovn-recon/ovn/cnv-1?select=switch:transit_switch');
        layOut(OPEN);
        const canvas = container.querySelector('[data-testid="ladder-canvas"]')!;
        drag(canvas, { bubbles: true, clientX: 300, clientY: 100 }, { bubbles: true, clientX: 280, clientY: 100 });
        const panned = ladderTransform(container);
        // A wider drawer splitter drag: the card is still wholly visible, so
        // the user's pan stands.
        layOut({ width: 600, height: 700 });
        expect(fitsIn(ladderScreenBox(container, 'transit_switch'), { width: 600, height: 700 })).toBe(true);
        expect(ladderTransform(container)).toBe(panned);
    });
});
