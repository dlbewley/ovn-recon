import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { ClusterLogicalTopology, LogicalTopologySnapshot } from '../types';
import ClusterLogicalTopologyDetails from './ClusterLogicalTopologyDetails';
import { LocationRecord, TestRouter } from './testRouter';

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
    metadata: {
        schemaVersion: '2',
        generatedAt: new Date().toISOString(),
        sourceHealth: 'healthy',
    },
    snapshots: [cnv1, cnv2, ctrl1] as unknown as LogicalTopologySnapshot[],
    warnings: [],
};

describe('ClusterLogicalTopologyDetails', () => {
    let container: HTMLDivElement;
    let root: Root;
    let locations: LocationRecord[];
    const current = () => locations[locations.length - 1];
    const renderPage = (initialEntry = '/ovn-recon/ovn') =>
        root.render(
            <TestRouter initialEntry={initialEntry} onLocation={(record) => locations.push(record)}>
                <ClusterLogicalTopologyDetails />
            </TestRouter>,
        );

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        locations = [];
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => aggregate,
        }) as unknown as typeof fetch;
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        jest.restoreAllMocks();
    });

    it('narrows to a single node perspective under the host filter', async () => {
        await act(async () => {
            renderPage();
        });
        await act(async () => {
            await Promise.resolve();
        });

        const hostSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Filter by host"]');
        expect(hostSelect).not.toBeNull();
        expect([...hostSelect!.options].map((option) => option.value)).toEqual([
            'all',
            'cnv-1',
            'cnv-2',
            'ctrl-1',
        ]);

        // All hosts: one gateway router per node on the default network.
        expect(container.querySelector('[data-testid="construct-GR_cnv-1"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="construct-GR_ctrl-1"]')).not.toBeNull();

        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
            setter?.call(hostSelect, 'cnv-1');
            hostSelect!.dispatchEvent(new Event('change', { bubbles: true }));
        });

        const text = container.textContent ?? '';
        expect(text).toContain('Assembled from 1 node');
        // Only cnv-1's node-bound constructs remain...
        expect(container.querySelector('[data-testid="construct-GR_cnv-1"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="construct-ext_cnv-1"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="construct-GR_ctrl-1"]')).toBeNull();
        expect(container.querySelector('[data-testid="construct-ctrl-1"]')).toBeNull();
        // ...while shared constructs still render from that zone's view.
        expect(container.querySelector('[data-testid="construct-ovn_cluster_router"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="construct-transit_switch"]')).not.toBeNull();
        // Exactly one gateway router per network for the selected node.
        const gatewayCards = [...container.querySelectorAll('[data-testid^="construct-GR_"]')];
        expect(gatewayCards).toHaveLength(2); // default + Layer2 CUDN
    });

    it('keeps the last-good topology rendered when a refresh fails', async () => {
        await act(async () => {
            renderPage();
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(container.querySelector('[data-testid="construct-transit_switch"]')).not.toBeNull();

        // Next poll fails; the graph must survive with a warning beside it.
        (global.fetch as jest.Mock).mockRejectedValue(new Error('connection refused'));
        const refresh = [...container.querySelectorAll('button')].find(
            (button) => button.textContent === 'Refresh now',
        );
        expect(refresh).toBeDefined();
        await act(async () => {
            refresh!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await Promise.resolve();
        });

        expect(container.querySelector('[data-testid="construct-transit_switch"]')).not.toBeNull();
        const text = container.textContent ?? '';
        expect(text).toContain('Collector request failed');
        expect(text).toContain('Showing the last loaded topology');
    });

    it('renders the merged cluster ladder from the aggregate payload', async () => {
        await act(async () => {
            renderPage();
        });
        // Flush the fetch promise chain.
        await act(async () => {
            await Promise.resolve();
        });

        const text = container.textContent ?? '';
        expect(text).toContain('Cluster Logical OVN Topology');
        expect(text).toContain('Assembled from 3 nodes');
        expect(text).toContain('Default cluster network');
        // Merged zone-replicated construct renders once.
        expect(container.querySelectorAll('[data-testid="construct-transit_switch"]')).toHaveLength(1);
        // Node-bound constructs stay distinct.
        expect(container.querySelector('[data-testid="construct-GR_cnv-1"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="construct-GR_ctrl-1"]')).not.toBeNull();
    });

    /**
     * Drawer chrome matches the physical view (ovn-recon-f9p). The panel used to
     * wrap ConstructDrawerBody in a nested Card, so a second border floated
     * inside the panel edge, and it had no resize handle. Console side panels
     * render content straight into a resizable panel, so this one does too.
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
        // (ovn-recon-mow), with only the identity header (ovn-recon-dp7.1)
        // between them.
        const tablist = panel!.querySelector('[role="tablist"]');
        expect(tablist).not.toBeNull();
        expect(tablist!.closest('.pf-v6-c-drawer__body')).toBeNull();
        const strip = tablist!.closest('.ovn-drawer-tab-strip');
        expect(strip).not.toBeNull();
        const identity = strip!.previousElementSibling;
        expect(identity?.getAttribute('data-testid')).toBe('construct-identity');
        expect(identity?.previousElementSibling?.classList.contains('pf-v6-c-drawer__head')).toBe(true);
    });
    /**
     * select=KIND:NAME on the cluster page (ovn-recon-s3t.16): restored on the
     * first model that contains it through the drawer-navigation path, and
     * resolved to the first match when networks share a bridge-mapping name.
     */
    describe('deep-linked selection', () => {
        const load = async (entry: string) => {
            await act(async () => { renderPage(entry); });
            await act(async () => { await Promise.resolve(); });
        };
        const drawerTitle = () =>
            container.querySelector('.pf-v6-c-drawer.pf-m-expanded .pf-v6-c-drawer__head h2')?.textContent ?? null;
        const selectedCards = () =>
            [...container.querySelectorAll('[data-testid^="construct-"]')].filter(
                (card) => card.querySelector('rect')?.getAttribute('stroke-width') === '3');

        it('restores a selection from the URL and opens its drawer', async () => {
            await load('/ovn-recon/ovn?select=router:GR_cnv-2');
            expect(drawerTitle()).toContain('Gateway router');
            expect(drawerTitle()).toContain('cnv-2');
            expect(selectedCards().map((card) => card.getAttribute('data-testid'))).toEqual(['construct-GR_cnv-2']);
        });

        it('links the drawer to the construct detail page in its own zone (ovn-recon-e2b.8)', async () => {
            await load('/ovn-recon/ovn?select=router:GR_cnv-2');
            const link = container.querySelector('[data-testid="open-details"] a');
            expect(link?.getAttribute('href')).toBe('/ovn-recon/ovn/cnv-2/router/GR_cnv-2');
        });

        it('takes the first match when networks share a bridge-mapping name', async () => {
            await load('/ovn-recon/ovn?select=physnet:physnet');
            expect(drawerTitle()).toContain('Bridge mapping');
            // Bridge mappings are synthesized: no row, no detail page.
            expect(container.querySelector('[data-testid="open-details"]')).toBeNull();
            const cards = [...container.querySelectorAll('[data-testid="construct-physnet"]')];
            expect(cards.length).toBeGreaterThan(1);
            expect(selectedCards()).toEqual([cards[0]]);
        });

        it('ignores a stale construct and keeps the filters as they are', async () => {
            await load('/ovn-recon/ovn?select=router:GR_gone');
            expect(drawerTitle()).toBeNull();
            expect(container.querySelector<HTMLSelectElement>('select[aria-label="Filter by host"]')!.value).toBe('all');
            expect(container.querySelector<HTMLSelectElement>('select[aria-label="Filter by network"]')!.value).toBe('all');
        });

        it('steps through search matches and writes each one to the URL', async () => {
            await load('/ovn-recon/ovn?host=x');
            const search = container.querySelector<HTMLInputElement>('input[aria-label="Search constructs"]')!;
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'GR_cnv');
            act(() => { search.dispatchEvent(new Event('input', { bubbles: true })); });

            await act(async () => {
                search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            });
            expect(current().search).toBe('?host=x&select=router:GR_cnv-1');
            expect(container.textContent).toContain('1 / 2');

            const next = container.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!;
            await act(async () => { next.click(); });
            expect(current().search).toBe('?host=x&select=router:GR_cnv-2');
            expect(container.textContent).toContain('2 / 2');

            await act(async () => { next.click(); });
            expect(current().search).toBe('?host=x&select=router:GR_cnv-1');

            await act(async () => {
                container.querySelector<HTMLButtonElement>('button[aria-label="Previous match"]')!.click();
            });
            expect(current().search).toBe('?host=x&select=router:GR_cnv-2');
            expect(locations.every((record) => record.navigationType !== 'PUSH')).toBe(true);
        });
    });
});
