import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { ClusterLogicalTopology, LogicalTopologySnapshot } from '../types';
import { ClusterLogicalTopologyBody } from './ClusterLogicalTopologyDetails';
import { TestRouter } from './testRouter';
import {
    fitsIn,
    installFakeResizeObserver,
    ladderScreenBox,
    ladderTransform,
    resizeCanvases,
    selectedCard,
} from './canvasTestGeometry';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';
import cnv2 from '../../collector/fixtures/snapshots/cnv-2.json';
import ctrl1 from '../../collector/fixtures/snapshots/ctrl-1.json';

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
    useParams: () => ({}),
}));

const aggregate: ClusterLogicalTopology = {
    metadata: { schemaVersion: '2', generatedAt: new Date().toISOString(), sourceHealth: 'healthy' },
    snapshots: [cnv1, cnv2, ctrl1] as unknown as LogicalTopologySnapshot[],
    warnings: [],
};

/**
 * The cluster ladder's twin of NodeLogicalTopologyDetails.reveal.test.tsx
 * (ovn-recon-dp7.7): the same mocked canvas, 1310px wide with the drawer
 * closed and 655px beside it, and the same three ways of landing on a card.
 * Construct names repeat across zones here, so cards are found by their
 * selection outline rather than by name.
 */
describe('ClusterLogicalTopologyBody reveal beside the inline drawer', () => {
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
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => aggregate }) as unknown as typeof fetch;
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        restoreResizeObserver();
        jest.restoreAllMocks();
    });

    const load = async (entry = '/ovn-recon/ovn') => {
        await act(async () => {
            root.render(
                <TestRouter initialEntry={entry}>
                    <ClusterLogicalTopologyBody />
                </TestRouter>,
            );
        });
        await act(async () => { await Promise.resolve(); });
    };

    const drawerOpen = () => container.querySelector('.pf-v6-c-drawer.pf-m-expanded') !== null;

    const layOut = (size: { width: number; height: number }) => {
        canvasSize = size;
        act(() => resizeCanvases());
    };

    const selectedCentreX = () => {
        const box = ladderScreenBox(container, selectedCard(container));
        return box.x + box.width / 2;
    };
    const selectedFits = (size: { width: number; height: number }) =>
        fitsIn(ladderScreenBox(container, selectedCard(container)), size);

    const click = (element: Element) =>
        act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const drag = (canvas: Element, from: MouseEventInit, to: MouseEventInit) => {
        act(() => { canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ...from })); });
        act(() => { canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, ...to })); });
        act(() => { canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, ...to })); });
    };

    it('renders the drawer inline, so it never covers the canvas', async () => {
        await load('/ovn-recon/ovn?select=router:GR_cnv-2');
        const drawer = container.querySelector('.pf-v6-c-drawer');
        expect(drawer?.classList.contains('pf-m-inline')).toBe(true);
        expect(drawer?.classList.contains('pf-m-expanded')).toBe(true);
    });

    it('centres a deep-linked card in the canvas left beside the drawer', async () => {
        await load('/ovn-recon/ovn?select=router:GR_cnv-2');
        expect(drawerOpen()).toBe(true);
        layOut(OPEN);
        expect(selectedFits(OPEN)).toBe(true);
        expect(selectedCentreX()).toBeCloseTo(OPEN.width / 2, 0);
    });

    it('centres the match selected by Enter in the ladder search', async () => {
        await load();
        const search = container.querySelector<HTMLInputElement>('input[aria-label="Search constructs"]')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'GR_ctrl-1');
        act(() => { search.dispatchEvent(new Event('input', { bubbles: true })); });
        await act(async () => {
            search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        expect(drawerOpen()).toBe(true);
        layOut(OPEN);
        expect(selectedCard(container).getAttribute('data-testid')).toBe('construct-GR_ctrl-1');
        expect(selectedFits(OPEN)).toBe(true);
        expect(selectedCentreX()).toBeCloseTo(OPEN.width / 2, 0);
    });

    it('centres the card reached through a Relationships link', async () => {
        await load('/ovn-recon/ovn?select=router:GR_cnv-2');
        layOut(OPEN);
        const tab = [...container.querySelectorAll('.pf-v6-c-drawer__panel button')]
            .find((button) => button.textContent === 'Relationships')!;
        click(tab);
        const entry = [...container.querySelectorAll('.pf-v6-c-drawer__panel button')]
            .find((button) => button.textContent?.includes('Join switch'))!;
        expect(entry).toBeDefined();
        click(entry);
        await act(async () => { await Promise.resolve(); });

        expect(container.querySelector('.pf-v6-c-drawer__head h2')?.textContent).toContain('Join switch');
        expect(selectedFits(OPEN)).toBe(true);
        expect(selectedCentreX()).toBeCloseTo(OPEN.width / 2, 0);
    });

    it('keeps pan and zoom through opening and closing the drawer', async () => {
        await load();
        const canvas = container.querySelector('[data-testid="ladder-canvas"]')!;
        drag(canvas, { clientX: 100, clientY: 100 }, { clientX: 130, clientY: 110 });
        const userView = ladderTransform(container);
        expect(userView).toBe('translate(30px, 10px) scale(1)');

        const visible = [...container.querySelectorAll('[data-testid^="construct-"]')].find((card) => {
            const box = ladderScreenBox(container, card);
            return box.x >= 16 && box.x + box.width <= OPEN.width - 16 && box.y >= 16 && box.y + box.height <= OPEN.height - 16;
        });
        expect(visible).toBeDefined();
        click(visible!);
        layOut(OPEN);
        expect(ladderTransform(container)).toBe(userView);

        click(container.querySelector('.pf-v6-c-drawer__close button')!);
        layOut(CLOSED);
        expect(ladderTransform(container)).toBe(userView);
    });
});
