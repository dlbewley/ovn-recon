import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { NodeNetworkState, OvsBondsResponse } from '../types';
import { CollectorUnreachableError } from './collectorApi';
import NodeVisualizationComponent from './NodeVisualization';
import { routed } from './testRouter';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    useK8sWatchResource: () => [[]]
}));

// Only the bond request is replaced; the error types and describeCollectorFailure are
// the real ones, so the drawer's failure line is the one users see.
const mockFetchOvsBondState = jest.fn();
jest.mock('./collectorApi', () => ({
    ...jest.requireActual('./collectorApi'),
    fetchOvsBondState: (...args: unknown[]) => mockFetchOvsBondState(...args)
}));

/**
 * The physical view asks the collector for OVS bond runtime state (ovn-recon-1tw.7)
 * only with the collector gate on and an OVS bond on the node, and the ovs-bond
 * drawer's Runtime State row shows the answer.
 */
const fixture = (name: string): NodeNetworkState =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'nns', name), 'utf-8'));

const CONTRACT_EXAMPLE: OvsBondsResponse = {
    metadata: { schemaVersion: 'v1alpha1', generatedAt: '2026-11-16T20:15:00Z', sourceHealth: 'ok', nodeName: 'worker-1' },
    warnings: [],
    bonds: [{
        name: 'bond1',
        mode: 'balance-slb',
        lacpStatus: 'off',
        nextRebalanceMs: 9036,
        activeBackupPrimary: null,
        activeMember: { name: 'ens161', mac: '00:50:56:b4:1b:27' },
        members: [
            { name: 'ens161', enabled: true, active: true, mayEnable: true },
            { name: 'ens256', enabled: false, active: false, mayEnable: false }
        ]
    }]
};

const NodeVisualization = routed(NodeVisualizationComponent);

describe('NodeVisualization: OVS bond runtime state', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        mockFetchOvsBondState.mockReset();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const render = async (nns: NodeNetworkState, collectorEnabled: boolean) => {
        await act(async () => {
            root.render(
                <NodeVisualization nns={nns} cudns={[]} udns={[]} nads={[]} routeAdvertisements={[]}
                    collectorEnabled={collectorEnabled} />
            );
        });
    };

    const openBond = () => {
        // A node group draws its own rect; its title is "<label> (<type>)".
        const group = Array.from(container.querySelectorAll('g'))
            .filter((g) => Array.from(g.children).some((c) => c.tagName.toLowerCase() === 'rect'))
            .find((g) => g.querySelector('title')?.textContent === 'bond1 (ovs-bond)');
        if (!group) throw new Error('no bond1 (ovs-bond) node');
        act(() => { group.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    };

    const panelText = () => container.querySelector('.pf-v6-c-drawer__panel')?.textContent ?? '';

    it('sends no request with the collector off', async () => {
        await render(fixture('ovs-bond-slb.json'), false);
        expect(mockFetchOvsBondState).not.toHaveBeenCalled();
        openBond();
        expect(panelText()).toContain('ovs-appctl bond/show bond1');
        expect(panelText()).not.toContain('Active member');
    });

    it('sends no request for a node without OVS bonds, collector on', async () => {
        await render(fixture('bonded-lldp.json'), true);
        expect(mockFetchOvsBondState).not.toHaveBeenCalled();
    });

    it('asks once for the node, and shows the active member and each member\'s state', async () => {
        mockFetchOvsBondState.mockResolvedValue(CONTRACT_EXAMPLE);
        await render(fixture('ovs-bond-slb.json'), true);
        expect(mockFetchOvsBondState).toHaveBeenCalledTimes(1);
        expect(mockFetchOvsBondState).toHaveBeenCalledWith('worker-1');

        openBond();
        const text = panelText();
        expect(text).toContain('Active member: ens161');
        expect(text).toContain('ens161: enabled');
        expect(text).toContain('ens256: disabled (may_enable: false)');
        expect(text).toContain('LACP: off');
        // The card says what the NNS link state cannot: OVS disabled a member that is up.
        expect(container.textContent).toContain('balance-slb · 1/2 enabled');
        // Opening the drawer is not a refresh.
        expect(mockFetchOvsBondState).toHaveBeenCalledTimes(1);
    });

    it('keeps the pointer and adds the failure line when the collector does not answer', async () => {
        mockFetchOvsBondState.mockRejectedValue(new CollectorUnreachableError([
            { url: '/api/plugins/ovn-recon/api/v1/ovs/bonds/worker-1', status: 502 }
        ]));
        await render(fixture('ovs-bond-slb.json'), true);
        openBond();
        expect(panelText()).toContain('ovs-appctl bond/show bond1');
        expect(panelText()).toContain('Collector: Collector is not answering (HTTP 502)');
    });
});
