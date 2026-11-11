import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { NodeNetworkState } from '../types';
import NodeNetworkStateDetails from './NodeNetworkStateDetails';

const loadNns = (name: string): NodeNetworkState =>
    JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'nns', `${name}.json`), 'utf-8'),
    ) as NodeNetworkState;

// Mutable so each test picks the NodeNetworkState the page watches; jest.mock
// factories may only reach variables prefixed `mock`.
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

jest.mock('react-router', () => ({
    Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={String(to)}>{children}</a>,
    useParams: () => ({ name: 'worker-routes' }),
    useLocation: () => ({ pathname: '/ovn-recon/node-network-state/worker-routes', search: '', hash: '' }),
    useNavigate: () => jest.fn(),
}));

// The graph is covered by its own suites; here it only has to stay out of the way.
jest.mock('./NodeVisualization', () => ({
    __esModule: true,
    default: () => <div data-testid="node-visualization" />,
}));

describe('NodeNetworkStateDetails main routing table (ovn-recon-dp7.2)', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const section = () => container.querySelector('[data-testid="main-routing-table"]');
    const expand = () => {
        const toggle = section()?.querySelector('button');
        expect(toggle?.textContent).toContain('Main routing table');
        act(() => toggle!.click());
    };

    it('offers the main table from the page header, default routes pinned and the preferred one marked', () => {
        mockNns = loadNns('kernel-routes');
        act(() => root.render(<NodeNetworkStateDetails />));
        expand();

        const summaries = Array.from(section()!.querySelectorAll('[data-testid="kernel-route-summary"]'))
            .map((summary) => summary.textContent);
        // Main only: table 100 is not part of it.
        expect(summaries).toEqual(['Table 254 (main) · 10 routes · 3 default · 1 ECMP']);

        const rows = Array.from(section()!.querySelectorAll('tbody tr'));
        const destination = (row: Element) => row.querySelector('td[data-label="Destination"]')?.textContent ?? '';
        expect(destination(rows[0])).toContain('0.0.0.0/0');
        expect(destination(rows[0])).toContain('in use');
        expect(destination(rows[0])).toContain('lowest metric of 2 IPv4 default routes');
        expect(destination(rows[1])).toContain('0.0.0.0/0');
        expect(destination(rows[1])).not.toContain('in use');
    });

    it('leaves the section out when NodeNetworkState reports no main-table routes', () => {
        mockNns = loadNns('basic-host');
        act(() => root.render(<NodeNetworkStateDetails />));
        expect(container.querySelector('[data-testid="node-visualization"]')).not.toBeNull();
        expect(section()).toBeNull();
    });
});
