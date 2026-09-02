import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import NodeLogicalTopologyDetails from './NodeLogicalTopologyDetails';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    DocumentTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useK8sWatchResource: () => [[], true, undefined],
}));

jest.mock('./useOvnCollectorFeatureGate', () => ({
    useOvnCollectorFeatureGate: () => ({ enabled: true, loaded: true, loadError: undefined }),
}));

jest.mock('react-router', () => ({
    Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={String(to)}>{children}</a>,
    useParams: () => ({ name: 'cnv-1' }),
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
});
