import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import NodeVisualizationComponent from '../components/NodeVisualization';
import { routed } from '../components/testRouter';
import { NETOBSERV_FULL, OCP_4_22, withNetobserv } from '../linkOut/testCapabilities';
import { ClusterUserDefinedNetwork, NodeNetworkState } from '../types';
import { elsewhereTarget, ownerTarget } from './drawerTabs';
import { GraphContext } from './context';
import { NodeViewModel } from './types';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    useK8sWatchResource: () => [[]],
}));

jest.mock('@patternfly/react-code-editor', () => ({
    CodeEditor: ({ code }: { code: string }) => <pre data-testid="code-editor">{code}</pre>,
    Language: { yaml: 'yaml' },
}));

const mockCapabilities = jest.fn();
jest.mock('../linkOut/useConsoleCapabilities', () => ({
    useConsoleCapabilities: () => mockCapabilities(),
}));

const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

const NodeVisualization = routed(NodeVisualizationComponent);

const ctx = { nns: { metadata: { name: 'worker-1' } } } as GraphContext;
const node = (partial: Partial<NodeViewModel>): NodeViewModel => partial as NodeViewModel;

describe('physical drawer link targets (ovn-recon-zdt.4)', () => {
    it('opens a resource on its own page', () => {
        const ref = { apiVersion: 'k8s.ovn.org/v1', kind: 'ClusterUserDefinedNetwork', name: 'machinenet' };
        expect(ownerTarget(node({ kind: 'cudn', resourceRef: ref }), ctx)).toEqual({ type: 'resource', ref });
    });

    it('opens an interface, a VRF and a bridge mapping on the node\'s NodeNetworkState', () => {
        const nns = {
            type: 'resource',
            ref: { apiVersion: 'nmstate.io/v1beta1', kind: 'NodeNetworkState', name: 'worker-1' },
        };
        expect(ownerTarget(node({ kind: 'interface' }), ctx)).toEqual(nns);
        expect(ownerTarget(node({ kind: 'vrf' }), ctx)).toEqual(nns);
        expect(ownerTarget(node({ kind: 'ovn-mapping' }), ctx)).toEqual(nns);
    });

    it('has no owner page for a kind that is neither', () => {
        expect(ownerTarget(node({ kind: 'lldp-neighbor' }), ctx)).toBeUndefined();
        expect(ownerTarget(node({ kind: 'interface' }), {} as GraphContext)).toBeUndefined();
    });

    it('names an interface for nmstate by node, name and type', () => {
        expect(elsewhereTarget(node({ kind: 'interface', raw: { name: 'br-ex', type: 'ovs-bridge' } }), ctx))
            .toEqual({ type: 'node-interface', node: 'worker-1', name: 'br-ex', interfaceType: 'ovs-bridge' });
        expect(elsewhereTarget(node({ kind: 'interface', raw: { name: 'br-ex' } }), ctx)).toBeUndefined();
    });

    it('names a bridge mapping\'s physical network', () => {
        expect(elsewhereTarget(node({ kind: 'ovn-mapping', raw: { localnet: 'physnet', bridge: 'br-ex' } }), ctx))
            .toEqual({ type: 'physical-network', name: 'physnet' });
        expect(elsewhereTarget(node({ kind: 'cudn', raw: {} }), ctx)).toBeUndefined();
    });
});

describe('physical drawer links, rendered (ovn-recon-zdt.4)', () => {
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

    const open = (title: string) => {
        act(() => {
            root.render(
                <NodeVisualization
                    nns={fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json')}
                    cudns={fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json')}
                    udns={[]} nads={[]} routeAdvertisements={[]}
                />
            );
        });
        const group = Array.from(container.querySelectorAll('g'))
            .filter((g) => Array.from(g.children).some((c) => c.tagName.toLowerCase() === 'rect'))
            .find((g) => g.querySelector('title')?.textContent === title);
        if (!group) throw new Error(`no node titled "${title}"`);
        act(() => { group.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    };

    const elsewhere = () =>
        [...container.querySelectorAll('[data-testid="elsewhere-links"] a')]
            .map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target')]);

    const selectTab = (name: string) => {
        const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === name);
        act(() => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    };

    it('offers the NodeNetworkState and nmstate\'s interface details for an interface when nmstate is loaded', () => {
        mockCapabilities.mockReturnValue(OCP_4_22);
        open('ens192 (ethernet)');
        expect(elsewhere()).toEqual([
            ['View resource in console', '/k8s/cluster/nmstate.io~v1beta1~NodeNetworkState/worker-1', null],
            [
                'Interface details in nmstate',
                '/k8s/cluster/nmstate.io~v1beta1~NodeNetworkState?selectedState=worker-1&selectedInterface=ens192&selectedInterfaceType=ethernet',
                null,
            ],
        ]);
    });

    it('offers only the console resource when no plugin is loaded', () => {
        mockCapabilities.mockReturnValue(jest.requireActual('../linkOut/registry').NO_CAPABILITIES);
        open('ens192 (ethernet)');
        expect(elsewhere()).toEqual([
            ['View resource in console', '/k8s/cluster/nmstate.io~v1beta1~NodeNetworkState/worker-1', null],
        ]);
    });

    it('offers Physical networks for a bridge mapping where that page exists', () => {
        mockCapabilities.mockReturnValue(OCP_4_22);
        open('physnet (OVN Bridge Mapping)');
        expect(elsewhere().map(([text, href]) => [text, href])).toContainEqual(
            ['Open in Physical networks', '/physical-networks'],
        );
    });

    it('ends the Config tab with the same links, to the resource page and not its YAML', () => {
        mockCapabilities.mockReturnValue(OCP_4_22);
        open('machinenet (CUDN)');
        selectTab('Config');
        expect(elsewhere()).toEqual([
            ['View resource in console', '/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/machinenet', null],
        ]);
    });

    it('offers a network\'s traffic beside its resource when Network Observability can answer', () => {
        mockCapabilities.mockReturnValue(NETOBSERV_FULL);
        open('machinenet (CUDN)');
        expect(elsewhere()).toEqual([
            ['View resource in console', '/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/machinenet', null],
            ['View traffic', '/netflow-traffic?filters=udns%3Dmachinenet', null],
        ]);
    });

    it('offers no traffic for a network when the FlowCollector does not map UDNs', () => {
        mockCapabilities.mockReturnValue(withNetobserv({ loki: true, nodeMetrics: true, features: new Set() }));
        open('machinenet (CUDN)');
        expect(elsewhere()).toEqual([
            ['View resource in console', '/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/machinenet', null],
        ]);
    });
});
