import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import NodeLogicalTopologyDetails from './NodeLogicalTopologyDetails';

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
    Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={String(to)}>{children}</a>,
    useParams: () => ({ ...mockParams }),
}));

describe('NodeLogicalTopologyDetails', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
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
            root.render(<NodeLogicalTopologyDetails />);
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
            await act(async () => { root.render(<NodeLogicalTopologyDetails />); });

            const select = nodeSelect();
            expect(select).not.toBeNull();
            expect(select.value).toBe('cnv-1');
            expect([...select.options].map((o) => o.value)).toEqual(['all', 'cnv-1', 'cnv-2']);
        });

        it('keeps the current node selectable before the list has loaded', async () => {
            await act(async () => { root.render(<NodeLogicalTopologyDetails />); });
            expect(nodeSelect().value).toBe('cnv-1');
        });

        it('navigates to the chosen node the way the physical view does', async () => {
            mockNodeNetworkStates.push({ metadata: { name: 'cnv-1' } }, { metadata: { name: 'cnv-2' } });
            const pushState = jest.spyOn(window.history, 'pushState');
            const popstate = jest.fn();
            window.addEventListener('popstate', popstate);
            await act(async () => { root.render(<NodeLogicalTopologyDetails />); });

            choose(nodeSelect(), 'cnv-2');

            expect(pushState).toHaveBeenCalledWith(null, '', '/ovn-recon/ovn/cnv-2');
            expect(popstate).toHaveBeenCalledTimes(1);
            window.removeEventListener('popstate', popstate);
        });

        it('climbs back out to the cluster view on "All hosts"', async () => {
            const pushState = jest.spyOn(window.history, 'pushState');
            await act(async () => { root.render(<NodeLogicalTopologyDetails />); });

            choose(nodeSelect(), 'all');

            expect(pushState).toHaveBeenCalledWith(null, '', '/ovn-recon/ovn');
        });

        it('sits after the search box, where the cluster view puts it', async () => {
            await act(async () => { root.render(<NodeLogicalTopologyDetails />); });
            const search = container.querySelector('input[aria-label="Search constructs"]')!;
            expect(search.compareDocumentPosition(nodeSelect()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        });

        it('does not navigate when the current node is re-chosen', async () => {
            mockNodeNetworkStates.push({ metadata: { name: 'cnv-1' } });
            const pushState = jest.spyOn(window.history, 'pushState');
            await act(async () => { root.render(<NodeLogicalTopologyDetails />); });

            choose(nodeSelect(), 'cnv-1');

            expect(pushState).not.toHaveBeenCalled();
        });

        it('fetches the new node and drops the previous node\'s filters on a route change', async () => {
            await act(async () => { root.render(<NodeLogicalTopologyDetails />); });
            const search = container.querySelector<HTMLInputElement>('input[aria-label="Search constructs"]')!;
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'router');
            act(() => { search.dispatchEvent(new Event('input', { bubbles: true })); });
            expect(search.value).toBe('router');

            mockParams.name = 'cnv-2';
            await act(async () => { root.render(<NodeLogicalTopologyDetails />); });

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
            root.render(<NodeLogicalTopologyDetails />);
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
        expect(panel!.classList.contains('pf-m-width-33')).toBe(true);
        expect(panel!.querySelector('.pf-v6-c-drawer__splitter')).not.toBeNull();
        expect(panel!.querySelector('.pf-v6-c-card')).toBeNull();
        expect(panel!.querySelector('.pf-v6-c-drawer__body')).not.toBeNull();
        expect(panel!.querySelector('[role="tablist"]')).not.toBeNull();
    });
});
