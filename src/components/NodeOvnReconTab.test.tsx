import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { NodeNetworkState } from '../types';
import NodeOvnReconTab from './NodeOvnReconTab';
import { TestRouter } from './testRouter';

const loadNns = (name: string): NodeNetworkState =>
    JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'nns', `${name}.json`), 'utf-8'),
    ) as NodeNetworkState;

// jest.mock factories may only reach variables prefixed `mock`.
let mockNns: NodeNetworkState | undefined;
let mockNnsModel: [unknown, boolean] = [{ kind: 'NodeNetworkState' }, false];
let mockCollectorEnabled = true;
let mockGraphThrows = false;
const mockWatchedKinds: string[] = [];

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    DocumentTitle: ({ children }: { children: React.ReactNode }) => <title data-testid="document-title">{children}</title>,
    useK8sModel: () => mockNnsModel,
    useK8sWatchResource: (resource: { groupVersionKind: { kind: string }; isList?: boolean } | null) => {
        if (resource) mockWatchedKinds.push(resource.groupVersionKind.kind);
        return resource?.groupVersionKind.kind === 'NodeNetworkState' && !resource.isList
            ? [mockNns, true, undefined]
            : [resource?.isList ? [] : undefined, true, undefined];
    },
}));

jest.mock('./useOvnCollectorFeatureGate', () => ({
    useOvnCollectorFeatureGate: () => ({ enabled: mockCollectorEnabled }),
}));

// The graph is covered by its own suites; here it only has to be there, or fail on cue.
jest.mock('./NodeVisualization', () => ({
    __esModule: true,
    default: () => {
        if (mockGraphThrows) throw new Error('graph exploded');
        return <div data-testid="node-visualization" />;
    },
}));

describe('NodeOvnReconTab (ovn-recon-zdt.1)', () => {
    let container: HTMLDivElement;
    let root: Root;
    let consoleError: jest.SpyInstance;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        mockNns = loadNns('kernel-routes');
        mockNnsModel = [{ kind: 'NodeNetworkState' }, false];
        mockCollectorEnabled = true;
        mockGraphThrows = false;
        mockWatchedKinds.length = 0;
        consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        consoleError.mockRestore();
    });

    const node = { apiVersion: 'v1', kind: 'Node', metadata: { name: 'worker-routes' } };
    const HOST = '/k8s/cluster/nodes/worker-routes/ovn-recon';

    const render = async (obj: typeof node | undefined, entry = HOST) => {
        await act(async () => {
            root.render(<TestRouter initialEntry={entry}><NodeOvnReconTab obj={obj} /></TestRouter>);
        });
    };

    const links = () => Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));

    it("renders the node's physical topology with links to the full pages", async () => {
        await render(node);
        expect(container.querySelector('[data-testid="node-visualization"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="main-routing-table"]')).not.toBeNull();
        expect(links()).toContain('/ovn-recon/node-network-state/worker-routes');
        expect(links()).toContain('/ovn-recon/ovn/worker-routes');
    });

    it('leaves the title and breadcrumbs to the host page', async () => {
        await render(node);
        expect(container.querySelector('[data-testid="document-title"]')).toBeNull();
        expect(container.querySelector('h1')).toBeNull();
        expect(links()).not.toContain('/ovn-recon');
    });

    it('omits the logical link when the collector is off', async () => {
        mockCollectorEnabled = false;
        await render(node);
        expect(links()).not.toContain('/ovn-recon/ovn/worker-routes');
    });

    it('carries a graph selection from the host URL to the full page', async () => {
        await render(node, `${HOST}?foo=bar&select=vrf:blue`);
        expect(links()).toContain('/ovn-recon/node-network-state/worker-routes?select=vrf:blue');
    });

    it('shows an empty state when the node has no NodeNetworkState', async () => {
        mockNns = undefined;
        await render(node);
        const empty = container.querySelector('[data-testid="ovn-recon-tab-no-nns"]');
        expect(empty?.textContent).toContain('No NodeNetworkState for this node');
        expect(empty?.textContent).toContain('worker-routes');
        expect(container.querySelector('[data-testid="node-visualization"]')).toBeNull();
    });

    it('watches nothing on a cluster that does not serve NodeNetworkState', async () => {
        mockNnsModel = [undefined, false];
        await render(node);
        expect(container.querySelector('[data-testid="ovn-recon-tab-no-nns"]')?.textContent)
            .toContain('does not serve NodeNetworkState');
        expect(mockWatchedKinds).toEqual([]);
    });

    it('waits for the node object', async () => {
        await render(undefined);
        expect(container.textContent).toContain('Loading...');
    });

    it('keeps a failure inside the tab', async () => {
        mockGraphThrows = true;
        await render(node);
        expect(container.querySelector('[data-testid="ovn-recon-tab-error"]')?.textContent).toContain('graph exploded');
    });
});
