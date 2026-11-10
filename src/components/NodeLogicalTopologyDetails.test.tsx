import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import NodeLogicalTopologyDetails from './NodeLogicalTopologyDetails';
import { LocationRecord, TestRouter } from './testRouter';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';

// Mutable so individual tests can vary the node list and the route param;
// jest.mock factories may only close over identifiers prefixed `mock`.
const mockNodeNetworkStates: { metadata: { name: string } }[] = [];
const mockParams: { name: string } = { name: 'cnv-1' };

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    DocumentTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useK8sWatchResource: () => [mockNodeNetworkStates, true, undefined],
}));

jest.mock('./useOvnCollectorFeatureGate', () => ({
    useOvnCollectorFeatureGate: () => ({ enabled: true, loaded: true, loadError: undefined }),
}));

jest.mock('react-router', () => ({
    ...jest.requireActual('react-router'),
    Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={String(to)}>{children}</a>,
    useParams: () => ({ ...mockParams }),
}));

describe('NodeLogicalTopologyDetails', () => {
    let container: HTMLDivElement;
    let root: Root;
    let locations: LocationRecord[];
    const current = () => locations[locations.length - 1];
    const renderPage = (initialEntry = '/ovn-recon/ovn/cnv-1') =>
        root.render(
            <TestRouter initialEntry={initialEntry} onLocation={(record) => locations.push(record)}>
                <NodeLogicalTopologyDetails />
            </TestRouter>,
        );

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        locations = [];
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => cnv1,
        }) as unknown as typeof fetch;
        mockNodeNetworkStates.splice(0, mockNodeNetworkStates.length);
        mockParams.name = 'cnv-1';
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        jest.restoreAllMocks();
    });

    it('links back to the node physical view, mirroring the physical page', async () => {
        await act(async () => {
            renderPage();
        });
        const link = [...container.querySelectorAll('a')].find(
            (anchor) => anchor.textContent === 'View physical topology for this node',
        );
        expect(link).toBeDefined();
        expect(link?.getAttribute('href')).toBe('/ovn-recon/node-network-state/cnv-1');
    });

    /**
     * The per-node logical view had no way to reach another node short of the
     * node list, while the cluster view already had a "Filter by host" select
     * (ovn-recon-60x). The same control now sits in the same toolbar slot here,
     * fed by the NodeNetworkState list -- the plugin's node index -- and since
     * this page holds one node's snapshot, a choice is a route change.
     */
    describe('host selector', () => {
        const nodeSelect = () =>
            container.querySelector<HTMLSelectElement>('select[aria-label="Filter by host"]')!;

        const choose = (select: HTMLSelectElement, value: string) => {
            // React listens for the native change event; set the value through the
            // prototype setter so React's value tracker notices the change.
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
            act(() => { select.dispatchEvent(new Event('change', { bubbles: true })); });
        };

        it('lists every NodeNetworkState with the current node selected', async () => {
            mockNodeNetworkStates.push({ metadata: { name: 'cnv-2' } }, { metadata: { name: 'cnv-1' } });
            await act(async () => { renderPage(); });

            const select = nodeSelect();
            expect(select).not.toBeNull();
            expect(select.value).toBe('cnv-1');
            expect([...select.options].map((o) => o.value)).toEqual(['all', 'cnv-1', 'cnv-2']);
        });

        it('keeps the current node selectable before the list has loaded', async () => {
            await act(async () => { renderPage(); });
            expect(nodeSelect().value).toBe('cnv-1');
        });

        // A host change is a real navigation, pushed through the console's
        // router like a link click, so Back returns to the previous node.
        it('navigates to the chosen node the way the physical view does', async () => {
            mockNodeNetworkStates.push({ metadata: { name: 'cnv-1' } }, { metadata: { name: 'cnv-2' } });
            await act(async () => { renderPage(); });

            choose(nodeSelect(), 'cnv-2');

            expect(current().pathname).toBe('/ovn-recon/ovn/cnv-2');
            expect(current().navigationType).toBe('PUSH');
        });

        it('climbs back out to the cluster view on "All hosts"', async () => {
            await act(async () => { renderPage(); });

            choose(nodeSelect(), 'all');

            expect(current().pathname).toBe('/ovn-recon/ovn');
            expect(current().navigationType).toBe('PUSH');
        });

        it('sits after the search box, where the cluster view puts it', async () => {
            await act(async () => { renderPage(); });
            const search = container.querySelector('input[aria-label="Search constructs"]')!;
            expect(search.compareDocumentPosition(nodeSelect()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        });

        it('does not navigate when the current node is re-chosen', async () => {
            mockNodeNetworkStates.push({ metadata: { name: 'cnv-1' } });
            await act(async () => { renderPage(); });

            choose(nodeSelect(), 'cnv-1');

            expect(locations.map((record) => record.pathname)).toEqual(['/ovn-recon/ovn/cnv-1']);
        });

        it('fetches the new node and drops the previous node\'s filters on a route change', async () => {
            await act(async () => { renderPage(); });
            const search = container.querySelector<HTMLInputElement>('input[aria-label="Search constructs"]')!;
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'router');
            act(() => { search.dispatchEvent(new Event('input', { bubbles: true })); });
            expect(search.value).toBe('router');

            mockParams.name = 'cnv-2';
            await act(async () => { renderPage(); });

            const urls = (global.fetch as jest.Mock).mock.calls.map(([url]) => String(url));
            expect(urls.some((url) => url.endsWith('/cnv-2'))).toBe(true);
            expect(search.value).toBe('');
            expect(nodeSelect().value).toBe('cnv-2');
        });
    });

    /**
     * Drawer chrome matches the physical view (ovn-recon-f9p): resizable panel,
     * content rendered straight into the panel body, no nested Card seam.
     */
    it('opens a resizable drawer with bare panel content, like the physical view', async () => {
        await act(async () => {
            renderPage();
        });
        await act(async () => {
            await Promise.resolve();
        });

        const construct = container.querySelector('[data-testid="construct-transit_switch"]');
        expect(construct).not.toBeNull();
        await act(async () => {
            construct!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        const panel = container.querySelector('.pf-v6-c-drawer__panel');
        expect(panel).not.toBeNull();
        expect(panel!.classList.contains('pf-m-resizable')).toBe(true);
        // Half the page: five tabs and the Ports table fit at 1400px (ovn-recon-dp7.5).
        expect(panel!.classList.contains('pf-m-width-50')).toBe(true);
        expect(panel!.querySelector('.pf-v6-c-drawer__splitter')).not.toBeNull();
        expect(panel!.querySelector('.pf-v6-c-card')).toBeNull();
        expect(panel!.querySelector('.pf-v6-c-drawer__body')).not.toBeNull();

        // The tab strip is the same shared strip the physical drawer uses, and
        // it sits flush under the head rather than inside the padded body
        // (ovn-recon-mow).
        const tablist = panel!.querySelector('[role="tablist"]');
        expect(tablist).not.toBeNull();
        expect(tablist!.closest('.pf-v6-c-drawer__body')).toBeNull();
        const strip = tablist!.closest('.ovn-drawer-tab-strip');
        expect(strip).not.toBeNull();
        expect(strip!.previousElementSibling?.classList.contains('pf-v6-c-drawer__head')).toBe(true);
    });
    /**
     * select=KIND:NAME (ovn-recon-s3t.16, matching ovn-recon-e2b.8 decision 8):
     * a link opens the page with the construct selected and its drawer open;
     * every selection change is written back with replace, and closing the
     * drawer removes it.
     */
    describe('deep-linked selection', () => {
        const load = async (entry: string) => {
            await act(async () => { renderPage(entry); });
            await act(async () => { await Promise.resolve(); });
        };
        const drawerTitle = () =>
            container.querySelector('.pf-v6-c-drawer.pf-m-expanded .pf-v6-c-drawer__head h2')?.textContent ?? null;
        const isSelected = (name: string) =>
            container.querySelector(`[data-testid="construct-${name}"] rect`)?.getAttribute('stroke-width') === '3';

        it('restores a selection from the URL and opens its drawer', async () => {
            await load('/ovn-recon/ovn/cnv-1?select=switch:transit_switch');
            expect(drawerTitle()).toContain('Transit switch');
            expect(isSelected('transit_switch')).toBe(true);
            expect(current().search).toBe('?select=switch:transit_switch');
        });

        it('ignores an unknown construct without erroring', async () => {
            await load('/ovn-recon/ovn/cnv-1?select=switch:no-such-switch');
            expect(drawerTitle()).toBeNull();
            expect(container.querySelector('[data-testid="construct-join"]')).not.toBeNull();
        });

        it('writes clicks with replace and removes the parameter on close', async () => {
            await load('/ovn-recon/ovn/cnv-1?keep=1');
            await act(async () => {
                container.querySelector('[data-testid="construct-join"]')!
                    .dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            expect(current().search).toBe('?keep=1&select=switch:join');
            expect(current().navigationType).toBe('REPLACE');

            await act(async () => {
                container.querySelector<HTMLButtonElement>('.pf-v6-c-drawer__close button')!.click();
            });
            expect(drawerTitle()).toBeNull();
            expect(current().search).toBe('?keep=1');
            expect(locations.some((record) => record.navigationType === 'PUSH')).toBe(false);
        });
    });

    /**
     * Searching by the label drawn on the card works, and Enter selects and
     * reveals the first match through the same path (ovn-recon-nt4.6).
     */
    it('selects and reveals the first match on Enter', async () => {
        await act(async () => { renderPage(); });
        await act(async () => { await Promise.resolve(); });
        const search = container.querySelector<HTMLInputElement>('input[aria-label="Search constructs"]')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'node switch');
        act(() => { search.dispatchEvent(new Event('input', { bubbles: true })); });
        expect(container.querySelector('[data-testid="construct-cnv-1"]')!.getAttribute('opacity')).toBe('1');
        expect(container.querySelector('[data-testid="construct-join"]')!.getAttribute('opacity')).toBe('0.25');

        await act(async () => {
            search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        const title = container.querySelector('.pf-v6-c-drawer.pf-m-expanded .pf-v6-c-drawer__head h2');
        expect(title?.textContent).toContain('Node switch');
        expect(['?select=switch:cnv-1', '?select=switch:demo.mirror_example.l3.udn_cnv-1'])
            .toContain(current().search);
        expect(container.textContent).toContain('1 / 2');
    });
});
