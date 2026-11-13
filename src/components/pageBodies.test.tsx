import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { Route, Routes } from 'react-router';

import ClusterLogicalTopologyDetails, { ClusterLogicalTopologyBody } from './ClusterLogicalTopologyDetails';
import ConstructDetails, { ConstructBody } from './ConstructDetails';
import NodeLogicalTopologyDetails, { NodeLogicalTopologyBody } from './NodeLogicalTopologyDetails';
import { TestRouter } from './testRouter';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';
import cnv2 from '../../collector/fixtures/snapshots/cnv-2.json';

/**
 * The logical, cluster and construct pages are a body and a thin routed wrapper
 * (ovn-recon-gbr.3). The wrapper owns the document title, the breadcrumb and the
 * heading; the body draws everything else, so a host other than the routed page can
 * render it under a header of its own. These tests hold both halves: a body alone
 * carries no page chrome, and the routed page still carries all of it.
 */

// jest.mock factories may only close over identifiers prefixed `mock`.
const mockGate = { enabled: true, loaded: true, loadError: undefined as Error | undefined };
const mockWatched: ({ kind: string; isList?: boolean } | null)[] = [];
const MOCK_NODE_NETWORK_STATES = [{ metadata: { name: 'cnv-1' } }, { metadata: { name: 'cnv-2' } }];
const MOCK_NONE: unknown[] = [];

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    // The console's own DocumentTitle draws nothing in place; the marker stands in
    // for the title it would set.
    DocumentTitle: ({ children }: { children: React.ReactNode }) => <span data-testid="document-title">{children}</span>,
    useK8sWatchResource: (resource: { groupVersionKind: { kind: string }; isList?: boolean } | null) => {
        mockWatched.push(resource ? { kind: resource.groupVersionKind.kind, isList: resource.isList } : null);
        if (!resource) return [undefined, true, undefined];
        return [resource.groupVersionKind.kind === 'NodeNetworkState' ? MOCK_NODE_NETWORK_STATES : MOCK_NONE, true, undefined];
    },
}));

jest.mock('./useOvnCollectorFeatureGate', () => ({
    useOvnCollectorFeatureGate: () => ({ ...mockGate }),
}));

jest.mock('@patternfly/react-code-editor', () => ({
    CodeEditor: ({ code }: { code: string }) => <pre data-testid="code-editor">{code}</pre>,
    Language: { json: 'json' },
}));

jest.mock('./useServiceReads', () => ({
    useServiceNetworks: () => ({ serviceNetworks: ['172.30.0.0/16'], loaded: true }),
    useKubeService: () => ({ loaded: false }),
    useServiceEndpointSlices: () => ({ slices: [], loaded: false }),
}));

const SNAPSHOTS: Record<string, unknown> = { 'cnv-1': cnv1, 'cnv-2': cnv2 };

const ok = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) });

/** The collector, answering one node's snapshot or the aggregate by URL. */
const collector = async (input: unknown) => {
    const url = String(input);
    const node = /\/snapshots\/([^/?#]+)$/.exec(url)?.[1];
    if (node) return ok(SNAPSHOTS[decodeURIComponent(node)]);
    return ok({
        metadata: { schemaVersion: '2', generatedAt: new Date().toISOString(), sourceHealth: 'healthy' },
        snapshots: [cnv1, cnv2],
        warnings: [],
    });
};

describe('page bodies without their page chrome (ovn-recon-gbr.3)', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        mockGate.enabled = true;
        mockGate.loaded = true;
        mockGate.loadError = undefined;
        mockWatched.length = 0;
        global.fetch = jest.fn(collector) as unknown as typeof fetch;
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        jest.restoreAllMocks();
    });

    const render = async (element: React.ReactElement, initialEntry = '/somewhere/else') => {
        await act(async () => {
            root.render(<TestRouter initialEntry={initialEntry}>{element}</TestRouter>);
        });
        // The snapshot arrives a tick after the first render.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    };

    const documentTitle = () => container.querySelector('[data-testid="document-title"]')?.textContent ?? null;
    const breadcrumb = () => container.querySelector('nav[aria-label="Breadcrumb"]');
    const heading = () => container.querySelector('h1');
    const select = (label: string) => container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
    const linkTexts = () => Array.from(container.querySelectorAll('a')).map((anchor) => anchor.textContent);
    const watchedNodeNetworkStateList = () =>
        mockWatched.some((resource) => resource?.kind === 'NodeNetworkState' && resource.isList);

    const expectNoPageChrome = () => {
        expect(documentTitle()).toBeNull();
        expect(breadcrumb()).toBeNull();
        expect(heading()).toBeNull();
    };

    describe('NodeLogicalTopologyBody', () => {
        it('draws the ladder with no document title, breadcrumb, heading or cross-link', async () => {
            await render(<NodeLogicalTopologyBody name="cnv-1" />);

            expectNoPageChrome();
            expect(linkTexts()).not.toContain('View physical topology for this node');
            // The view itself is all there: card, toolbar and a drawn ladder.
            expect(container.textContent).toContain('Logical Topology');
            expect(container.querySelector('[data-testid="ladder-content"]')).not.toBeNull();
            expect(select('Filter by network')).not.toBeNull();
        });

        it('keeps the host select unless the host asks for it to go', async () => {
            await render(<NodeLogicalTopologyBody name="cnv-1" />);
            expect(Array.from(select('Filter by host')!.options).map((option) => option.value))
                .toEqual(['all', 'cnv-1', 'cnv-2']);
            expect(watchedNodeNetworkStateList()).toBe(true);
        });

        it('leaves the host select out, and its node list unwatched, when asked', async () => {
            await render(<NodeLogicalTopologyBody name="cnv-1" hideHostSelect />);

            expect(select('Filter by host')).toBeNull();
            expect(watchedNodeNetworkStateList()).toBe(false);
            // Nothing else leaves the toolbar with it.
            expect(select('Filter by network')).not.toBeNull();
            expect(container.querySelector('[data-testid="ladder-content"]')).not.toBeNull();
        });

        it('puts a host header above the view, and only once the collector gate lets the view through', async () => {
            const header = <div data-testid="host-header">Host header</div>;
            await render(<NodeLogicalTopologyBody name="cnv-1" header={header} />);
            const hostHeader = container.querySelector('[data-testid="host-header"]')!;
            const canvas = container.querySelector('[data-testid="ladder-canvas"]')!;
            expect(hostHeader.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

            mockGate.enabled = false;
            await render(<NodeLogicalTopologyBody name="cnv-1" header={header} />);
            expect(container.querySelector('[data-testid="host-header"]')).toBeNull();
            expect(container.textContent).toContain('Logical OVN view is disabled');
        });

        it('is what the routed page wraps: the page adds the title, breadcrumb, heading and cross-link', async () => {
            await render(
                <Routes><Route path="/ovn-recon/ovn/:name" element={<NodeLogicalTopologyDetails />} /></Routes>,
                '/ovn-recon/ovn/cnv-1',
            );

            expect(documentTitle()).toBe('OVN Recon - Logical OVN (cnv-1)');
            expect(Array.from(breadcrumb()!.querySelectorAll('li')).map((item) => item.textContent))
                .toEqual(['OVN Recon', 'Cluster logical topology', 'Logical OVN: cnv-1']);
            expect(heading()!.textContent).toBe('Logical OVN Topology: cnv-1');
            expect(linkTexts()).toContain('View physical topology for this node');
            expect(select('Filter by host')).not.toBeNull();
        });

        it('shows none of the routed page\'s chrome while the gate is closed, as before the split', async () => {
            mockGate.enabled = false;
            await render(
                <Routes><Route path="/ovn-recon/ovn/:name" element={<NodeLogicalTopologyDetails />} /></Routes>,
                '/ovn-recon/ovn/cnv-1',
            );

            expectNoPageChrome();
            expect(container.textContent).toContain('Logical OVN view is disabled');
        });
    });

    describe('ClusterLogicalTopologyBody', () => {
        it('draws the merged ladder with no document title, breadcrumb or heading', async () => {
            await render(<ClusterLogicalTopologyBody />);

            expectNoPageChrome();
            expect(container.textContent).toContain('Cluster Topology');
            expect(container.querySelector('[data-testid="ladder-content"]')).not.toBeNull();
            expect(Array.from(select('Filter by host')!.options).map((option) => option.value))
                .toEqual(['all', 'cnv-1', 'cnv-2']);
        });

        it('leaves the host select out when asked, and nothing else', async () => {
            await render(<ClusterLogicalTopologyBody hideHostSelect />);

            expect(select('Filter by host')).toBeNull();
            expect(select('Filter by network')).not.toBeNull();
            expect(container.querySelector('[data-testid="ladder-content"]')).not.toBeNull();
        });

        it('puts a host header above the view, and only once the collector gate lets the view through', async () => {
            const header = <div data-testid="host-header">Host header</div>;
            await render(<ClusterLogicalTopologyBody header={header} />);
            expect(container.querySelector('[data-testid="host-header"]')).not.toBeNull();

            mockGate.loaded = false;
            await render(<ClusterLogicalTopologyBody header={header} />);
            expect(container.querySelector('[data-testid="host-header"]')).toBeNull();
        });

        it('is what the routed page wraps: the page adds the title, breadcrumb and heading', async () => {
            await render(<ClusterLogicalTopologyDetails />, '/ovn-recon/ovn');

            expect(documentTitle()).toBe('OVN Recon - Cluster Logical Topology');
            expect(Array.from(breadcrumb()!.querySelectorAll('li')).map((item) => item.textContent))
                .toEqual(['OVN Recon', 'Cluster logical topology']);
            expect(heading()!.textContent).toBe('Cluster Logical OVN Topology');
        });
    });

    describe('ConstructBody', () => {
        const tabs = () => Array.from(container.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent);

        it('draws the construct from its props with no document title, breadcrumb or heading', async () => {
            await render(<ConstructBody node="cnv-1" kind="switch" name="cnv-1" />);

            expectNoPageChrome();
            // The rest of the page's top row and the tabs are the body's.
            expect(container.querySelector('[data-testid="detail-network"]')).not.toBeNull();
            expect(Array.from(select('Node database')!.options).map((option) => option.value)).toEqual(['cnv-1', 'cnv-2']);
            expect(tabs()).toEqual(['Overview', 'Relationships', 'Ports', 'Policy', 'Services', 'Config']);
            expect(container.querySelector('[data-testid="detail-tab-overview"]')).not.toBeNull();
        });

        it('reads the tab from the query string of whatever page hosts it', async () => {
            await render(<ConstructBody node="cnv-1" kind="router" name="GR_cnv-1" />, '/a/host/page?tab=routes');

            expectNoPageChrome();
            expect(container.querySelector('[data-testid="detail-tab-routes"]')).not.toBeNull();
        });

        it('leaves the node select out, and its node list unwatched, when asked', async () => {
            await render(<ConstructBody node="cnv-1" kind="switch" name="cnv-1" hideNodeSelect />);

            expect(select('Node database')).toBeNull();
            expect(watchedNodeNetworkStateList()).toBe(false);
            expect(container.querySelector('[data-testid="detail-network"]')).not.toBeNull();
            expect(tabs()).toContain('Ports');
        });

        it('hands a host header the construct once the snapshot holds it', async () => {
            const seen: (string | null)[] = [];
            await render(
                <ConstructBody
                    node="cnv-1"
                    kind="router"
                    name="GR_cnv-1"
                    header={(construct) => {
                        seen.push(construct ? `${construct.kind}:${construct.name}` : null);
                        return <h2 data-testid="host-header">{construct ? construct.role : 'loading'}</h2>;
                    }}
                />,
            );

            // Null until the snapshot arrives, then the row itself.
            expect(seen[0]).toBeNull();
            expect(seen[seen.length - 1]).toBe('router:GR_cnv-1');
            const hostHeader = container.querySelector('[data-testid="host-header"]')!;
            expect(hostHeader.textContent).not.toBe('loading');
            // Above the network, node and refresh row.
            const network = container.querySelector('[data-testid="detail-network"]')!;
            expect(hostHeader.compareDocumentPosition(network) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        });

        it('asks for no header when there is no page to head', async () => {
            const header = jest.fn(() => <div data-testid="host-header" />);

            await render(<ConstructBody node="cnv-1" kind="physnet" name="physnet1" header={header} />);
            expect(container.textContent).toContain('No detail page for this kind');

            mockGate.enabled = false;
            await render(<ConstructBody node="cnv-1" kind="switch" name="cnv-1" header={header} />);
            expect(container.textContent).toContain('Logical OVN view is disabled');

            expect(header).not.toHaveBeenCalled();
            expect(container.querySelector('[data-testid="host-header"]')).toBeNull();
        });

        it('is what the routed page wraps: the page adds the title, breadcrumb and heading', async () => {
            await render(
                <Routes><Route path="/ovn-recon/ovn/:node/:kind/:name" element={<ConstructDetails />} /></Routes>,
                '/ovn-recon/ovn/cnv-1/switch/cnv-1',
            );

            expect(documentTitle()).toBe('OVN Recon - cnv-1 (cnv-1)');
            expect(Array.from(breadcrumb()!.querySelectorAll('li')).map((item) => item.textContent))
                .toEqual(['OVN Recon', 'Cluster logical topology', 'Logical OVN: cnv-1', 'cnv-1']);
            expect(heading()!.textContent).toContain('cnv-1');
            expect(select('Node database')).not.toBeNull();
        });
    });
});
