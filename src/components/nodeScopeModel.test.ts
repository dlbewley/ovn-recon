import {
    constructDetailPath,
    nodeFindingsPath,
    nodeLogicalPath,
    nodePhysicalPath,
    nodeRoutesPath,
    viewForLocation,
} from '../routes';
import { activeNodeTab, NodeView, nodeSwitchPath, nodeTabs } from './nodeScopeModel';

const nodeView = (url: string): NodeView => {
    const [pathname, search] = url.split('?');
    const view = viewForLocation({ pathname, search: search ? `?${search}` : '' });
    if (view?.scope !== 'node') throw new Error(`${url} is not a node view`);
    return view;
};

describe('nodeScopeModel', () => {
    describe('nodeTabs', () => {
        it('links Physical, Logical, Routes and Findings to the node\'s own URLs, with no selection', () => {
            expect(nodeTabs('cnv-1', true, 'physical', 2)).toEqual([
                { key: 'physical', title: 'Physical topology', path: nodePhysicalPath('cnv-1') },
                { key: 'logical', title: 'Logical topology', path: nodeLogicalPath('cnv-1') },
                { key: 'routes', title: 'Routes', path: nodeRoutesPath('cnv-1') },
                { key: 'findings', title: 'Findings', path: nodeFindingsPath('cnv-1'), count: 2 },
            ]);
        });

        it('counts 0 findings as 0, and gives no count while it is unknown', () => {
            expect(nodeTabs('cnv-1', false, 'findings', 0)[2].count).toBe(0);
            expect(nodeTabs('cnv-1', false, 'findings')[2]).not.toHaveProperty('count');
        });

        it('leaves Logical out while the collector is off, unless it is the tab on screen', () => {
            expect(nodeTabs('cnv-1', false, 'routes').map((tab) => tab.key)).toEqual(['physical', 'routes', 'findings']);
            expect(nodeTabs('cnv-1', false, 'logical').map((tab) => tab.key)).toEqual(['physical', 'logical', 'routes', 'findings']);
        });

        it('encodes the node name', () => {
            expect(nodeTabs('a b', true, null)[0].path).toBe(nodePhysicalPath('a b'));
        });
    });

    describe('activeNodeTab', () => {
        it('maps each node view to the tab it shows; the construct page is part of Logical', () => {
            expect(activeNodeTab(nodeView(nodePhysicalPath('n', 'iface:br-ex')))).toBe('physical');
            expect(activeNodeTab(nodeView(nodeLogicalPath('n')))).toBe('logical');
            expect(activeNodeTab(nodeView(nodeRoutesPath('n')))).toBe('routes');
            expect(activeNodeTab(nodeView(constructDetailPath('n', 'switch', 'join')))).toBe('logical');
            expect(activeNodeTab(nodeView(nodeFindingsPath('n')))).toBe('findings');
        });
    });

    describe('nodeSwitchPath', () => {
        it('keeps the physical tab and its selection', () => {
            expect(nodeSwitchPath(nodeView(nodePhysicalPath('cnv-1', 'iface:br-ex')), 'cnv-2'))
                .toBe(nodePhysicalPath('cnv-2', 'iface:br-ex'));
            expect(nodeSwitchPath(nodeView(nodePhysicalPath('cnv-1')), 'cnv-2')).toBe(nodePhysicalPath('cnv-2'));
        });

        it('keeps the logical tab, renaming a per-node construct and keeping a cluster-wide one', () => {
            expect(nodeSwitchPath(nodeView(nodeLogicalPath('cnv-1', { kind: 'router', name: 'GR_cnv-1' })), 'cnv-2'))
                .toBe(nodeLogicalPath('cnv-2', { kind: 'router', name: 'GR_cnv-2' }));
            expect(nodeSwitchPath(nodeView(nodeLogicalPath('cnv-1', { kind: 'switch', name: 'cnv-1' })), 'cnv-2'))
                .toBe(nodeLogicalPath('cnv-2', { kind: 'switch', name: 'cnv-2' }));
            expect(nodeSwitchPath(nodeView(nodeLogicalPath('cnv-1', { kind: 'switch', name: 'join' })), 'cnv-2'))
                .toBe(nodeLogicalPath('cnv-2', { kind: 'switch', name: 'join' }));
            expect(nodeSwitchPath(nodeView(`${nodeLogicalPath('cnv-1')}?select=bogus`), 'cnv-2')).toBe(nodeLogicalPath('cnv-2'));
        });

        it('keeps the routes tab', () => {
            expect(nodeSwitchPath(nodeView(nodeRoutesPath('cnv-1')), 'cnv-2')).toBe(nodeRoutesPath('cnv-2'));
        });

        it('opens the same construct in the new zone on the same tab, dropping the old zone\'s filter and port', () => {
            const from = constructDetailPath('cnv-1', 'router', 'GR_cnv-1', { tab: 'policy', q: 'x', port: 'p1' });
            expect(nodeSwitchPath(nodeView(from), 'cnv-2'))
                .toBe(constructDetailPath('cnv-2', 'router', 'GR_cnv-2', { tab: 'policy' }));
            expect(nodeSwitchPath(nodeView(constructDetailPath('cnv-1', 'switch', 'join')), 'cnv-2'))
                .toBe(constructDetailPath('cnv-2', 'switch', 'join'));
        });

        it('sends a construct path of an unknown kind to the new node\'s logical view', () => {
            expect(nodeSwitchPath(nodeView('/ovn-recon/ovn/cnv-1/mapping/physnet'), 'cnv-2')).toBe(nodeLogicalPath('cnv-2'));
        });
    });
});
