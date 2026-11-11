import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { NodeNetworkState } from '../types';
import { NodeNetworkStateBody } from './NodeNetworkStateDetails';
import { LocationRecord, TestRouter } from './testRouter';

const loadNns = (name: string): NodeNetworkState =>
    JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'nns', `${name}.json`), 'utf-8'),
    ) as NodeNetworkState;

let mockNns: NodeNetworkState | undefined;

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    DocumentTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useK8sWatchResource: (resource: { groupVersionKind: { kind: string }; isList?: boolean } | null) =>
        resource?.groupVersionKind.kind === 'NodeNetworkState' && !resource.isList
            ? [mockNns, true, undefined]
            : [resource?.isList ? [] : undefined, true, undefined],
}));

jest.mock('./useOvnCollectorFeatureGate', () => ({
    useOvnCollectorFeatureGate: () => ({ enabled: false }),
}));

/**
 * The node page's main routing table links its interfaces to the graph below
 * (ovn-recon-dp7.8): a click writes ?select= and the real graph follows it.
 */
describe('NodeNetworkStateDetails main routing table links', () => {
    let container: HTMLDivElement;
    let root: Root;
    let locations: LocationRecord[];
    const current = () => locations[locations.length - 1];

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        locations = [];
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const render = () => {
        mockNns = loadNns('primary-cudn-vrf');
        act(() => root.render(
            <TestRouter
                initialEntry="/ovn-recon/node-network-state/worker-1?keep=1"
                onLocation={(record) => locations.push(record)}
            >
                <NodeNetworkStateBody name="worker-1" />
            </TestRouter>
        ));
        const section = container.querySelector('[data-testid="main-routing-table"]')!;
        act(() => section.querySelector('button')!.click());
        return section;
    };

    const interfaceCells = (section: Element) =>
        Array.from(section.querySelectorAll('td[data-label="Interface"]'));
    const drawerTitle = () =>
        container.querySelector('.pf-v6-c-drawer.pf-m-expanded h2')?.textContent ?? null;

    it('selects a drawn interface in the graph and opens its drawer', () => {
        const section = render();
        expect(drawerTitle()).toBeNull();
        const link = interfaceCells(section)
            .map((cell) => cell.querySelector('button'))
            .find((button) => button?.textContent === 'br-ex');
        expect(link).toBeDefined();

        act(() => link!.click());
        expect(drawerTitle()).toContain('br-ex');
        expect(current().search).toBe('?keep=1&select=iface:br-ex');
        expect(current().navigationType).toBe('REPLACE');
    });

    it('leaves an interface the graph never draws as plain text', () => {
        // nmstate reports this port state: ignore, so no view of the graph draws it.
        const section = render();
        const cells = interfaceCells(section).filter((cell) => cell.textContent === 'ovn-k8s-mp0');
        expect(cells.length).toBeGreaterThan(0);
        cells.forEach((cell) => {
            expect(cell.querySelector('button')).toBeNull();
            expect(cell.querySelector('code')?.textContent).toBe('ovn-k8s-mp0');
        });
    });
});
