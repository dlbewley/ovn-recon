import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { ClusterLogicalTopology, LogicalTopologySnapshot } from '../types';
import ClusterLogicalTopologyDetails from './ClusterLogicalTopologyDetails';

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

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
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
            root.render(<ClusterLogicalTopologyDetails />);
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
            root.render(<ClusterLogicalTopologyDetails />);
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
            root.render(<ClusterLogicalTopologyDetails />);
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
            root.render(<ClusterLogicalTopologyDetails />);
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
});
