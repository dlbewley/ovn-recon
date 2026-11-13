import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { nodePhysicalPath, nodeRoutesPath } from '../routes';
import { NodeNetworkState } from '../types';
import { NodeNetworkStateBody, NodeRoutesBody } from './NodeNetworkStateDetails';
import { LocationRecord, TestRouter } from './testRouter';

const loadNns = (name: string): NodeNetworkState =>
    JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'nns', `${name}.json`), 'utf-8'),
    ) as NodeNetworkState;

let mockNns: NodeNetworkState | undefined;
const mockWatched: string[] = [];

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    // Like the console's, the title goes to the document head, not the page.
    DocumentTitle: () => null,
    useK8sWatchResource: (resource: { groupVersionKind: { kind: string }; isList?: boolean } | null) => {
        if (resource) mockWatched.push(`${resource.groupVersionKind.kind}${resource.isList ? '[]' : ''}`);
        return resource?.groupVersionKind.kind === 'NodeNetworkState' && !resource.isList
            ? [mockNns, true, undefined]
            : [resource?.isList ? [] : undefined, true, undefined];
    },
}));

jest.mock('./useOvnCollectorFeatureGate', () => ({
    useOvnCollectorFeatureGate: () => ({ enabled: true }),
}));

/**
 * The physical body in the explorer's node scope, and the Routes body that took
 * its main routing table (ovn-recon-gbr.5).
 */
describe('node physical views in the explorer', () => {
    let container: HTMLDivElement;
    let root: Root;
    let locations: LocationRecord[];
    const current = () => locations[locations.length - 1];

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        locations = [];
        mockWatched.length = 0;
        mockNns = loadNns('primary-cudn-vrf');
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const render = (entry: string, element: React.ReactElement) => act(() => root.render(
        <TestRouter initialEntry={entry} onLocation={(record) => locations.push(record)}>
            {element}
        </TestRouter>,
    ));

    describe('NodeNetworkStateBody inExplorer', () => {
        it('draws the graph alone: no heading, breadcrumb, cross-links, routing table, host select or card', () => {
            render(nodePhysicalPath('worker-1'), <NodeNetworkStateBody name="worker-1" inExplorer />);
            expect(container.querySelector('[data-testid="node-physical-body"]')).not.toBeNull();
            expect(container.querySelector('[data-testid="node-visualization-plain"]')).not.toBeNull();
            expect(container.querySelectorAll('h1')).toHaveLength(0);
            expect(container.querySelector('.pf-v6-c-breadcrumb')).toBeNull();
            expect(container.textContent).not.toContain('View logical OVN topology');
            expect(container.querySelector('[data-testid="main-routing-table"]')).toBeNull();
            expect(container.querySelector('[aria-label="Host selector"]')).toBeNull();
            expect(container.textContent).not.toContain('OVN Recon - Network Topology');
            // The graph itself is there: its interfaces are drawn.
            expect(container.textContent).toContain('br-ex');
        });

        it('leaves the routed page as it was', () => {
            render(nodePhysicalPath('worker-1'), <NodeNetworkStateBody name="worker-1" />);
            expect(container.querySelector('h1')?.textContent).toBe('Node Network Topology: worker-1');
            expect(container.querySelector('[data-testid="main-routing-table"]')).not.toBeNull();
            expect(container.textContent).toContain('OVN Recon - Network Topology');
        });
    });

    describe('NodeRoutesBody', () => {
        const interfaceButtons = () => Array.from(container.querySelectorAll('td[data-label="Interface"] button'));

        it('lists the main routing table, open, with no graph', () => {
            render(nodeRoutesPath('worker-1'), <NodeRoutesBody name="worker-1" />);
            const body = container.querySelector('[data-testid="node-routes-body"]')!;
            expect(body.querySelector('table[aria-label="Main routing table"]')).not.toBeNull();
            expect(body.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
            expect(container.querySelector('[data-testid="node-visualization-plain"]')).toBeNull();
        });

        it('opens the Physical tab with a drawn interface selected', () => {
            render(nodeRoutesPath('worker-1'), <NodeRoutesBody name="worker-1" />);
            const brEx = interfaceButtons().find((button) => button.textContent === 'br-ex');
            expect(brEx).toBeDefined();
            act(() => (brEx as HTMLButtonElement).click());
            expect(current().pathname).toBe(nodePhysicalPath('worker-1'));
            expect(current().search).toMatch(/^\?select=/);
            expect(current().navigationType).toBe('PUSH');
        });

        it('says so when the node has no NodeNetworkState', () => {
            mockNns = undefined;
            render(nodeRoutesPath('nope'), <NodeRoutesBody name="nope" />);
            expect(container.textContent).toContain('There is no NodeNetworkState named nope');
        });
    });
});
