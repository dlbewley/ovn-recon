import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import type { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import { loadItems } from '../insights/testing';
import type { ClusterUserDefinedNetwork, NetworkAttachmentDefinition, NodeNetworkState, UserDefinedNetwork } from '../types';
import {
    ClusterUserDefinedNetworkTab,
    NetworkAttachmentDefinitionTab,
    UserDefinedNetworkTab,
} from './NetworkOvnReconTab';
import { TestRouter } from './testRouter';

// Mutable so tests can vary what each watch returns; jest.mock factories may only
// close over identifiers prefixed `mock`.
const mockWatches: Record<string, unknown[]> = {};
const mockModels: Record<string, { kind: string } | undefined> = {};

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    DocumentTitle: ({ children }: { children: React.ReactNode }) => <title data-testid="document-title">{children}</title>,
    useK8sModel: (gvk: { kind: string }) => [mockModels[gvk.kind], false],
    useK8sWatchResource: (resource: { groupVersionKind: { kind: string } } | null) =>
        (resource ? [mockWatches[resource.groupVersionKind.kind] ?? [], true, undefined] : [undefined, true, undefined]),
}));

jest.mock('./useOvnCollectorFeatureGate', () => ({
    useOvnCollectorFeatureGate: () => ({ enabled: true, loaded: true }),
}));

const KINDS = ['NodeNetworkState', 'ClusterUserDefinedNetwork', 'UserDefinedNetwork', 'NetworkAttachmentDefinition', 'RouteAdvertisements'];

const coverageCudns = loadItems<ClusterUserDefinedNetwork>('cudn', 'cluster-localnet-coverage.json');
const coverageNads = loadItems<NetworkAttachmentDefinition>('nad', 'cluster-localnet-coverage.json');
const coverageNns = loadItems<NodeNetworkState>('nns', 'cluster-localnet-coverage.json');
const sriovNads = loadItems<NetworkAttachmentDefinition>('nad', 'sriov.json');

describe('Network OVN Recon tabs (ovn-recon-zdt.1)', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        KINDS.forEach((kind) => { mockModels[kind] = { kind }; });
        mockWatches.NodeNetworkState = coverageNns;
        mockWatches.ClusterUserDefinedNetwork = coverageCudns;
        mockWatches.UserDefinedNetwork = [];
        mockWatches.NetworkAttachmentDefinition = [...coverageNads, ...sriovNads];
        mockWatches.RouteAdvertisements = [];
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const render = async (Tab: React.FC<{ obj?: K8sResourceCommon }>, obj: K8sResourceCommon | undefined, entry: string) => {
        await act(async () => {
            root.render(<TestRouter initialEntry={entry}><Tab obj={obj} /></TestRouter>);
        });
    };

    const text = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';
    const links = () => Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));

    it('shows a CUDN\'s summary and placement by node, with a link to the full page', async () => {
        const cudn = coverageCudns.find((item) => item.metadata?.name === 'vlan-1924');
        await render(ClusterUserDefinedNetworkTab, cudn, '/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/vlan-1924/ovn-recon');
        expect(text('network-summary')).toContain('physnet-vmdata');
        expect(text('placement-summary')).toBe('Wired on 4 of 10 nodes.');
        expect(links()).toContain('/ovn-recon/networks/cudn/vlan-1924');
        expect(links()).toContain('/ovn-recon/node-network-state/worker-1?select=ovn:physnet-vmdata');
        // The host page owns the title, the heading and the console link.
        expect(container.querySelector('[data-testid="document-title"]')).toBeNull();
        expect(container.querySelector('h1')).toBeNull();
        expect(container.querySelector('[data-testid="network-console-link"]')).toBeNull();
    });

    it('shows network-scope findings', async () => {
        const cudn = coverageCudns.find((item) => item.metadata?.name === 'vlan-333');
        await render(ClusterUserDefinedNetworkTab, cudn, '/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/vlan-333/ovn-recon');
        expect(container.querySelectorAll('[data-testid="network-finding-localnet-unmapped"]')).toHaveLength(1);
    });

    it('shows a namespaced UDN', async () => {
        const udn: UserDefinedNetwork = {
            kind: 'UserDefinedNetwork',
            metadata: { name: 'tenant-blue', namespace: 'blue' },
            spec: { topology: 'Layer2', layer2: { role: 'Secondary', subnets: ['10.20.0.0/24'] } },
        };
        mockWatches.UserDefinedNetwork = [udn];
        await render(UserDefinedNetworkTab, udn, '/k8s/ns/blue/k8s.ovn.org~v1~UserDefinedNetwork/tenant-blue/ovn-recon');
        expect(text('network-summary')).toContain('10.20.0.0/24');
        expect(links()).toContain('/ovn-recon/networks/udn/blue/tenant-blue');
    });

    it('shows a NAD with no CUDN behind it', async () => {
        const nad = sriovNads.find((item) => item.metadata?.name === 'vm-igb');
        await render(NetworkAttachmentDefinitionTab, nad, '/k8s/ns/default/k8s.cni.cncf.io~v1~NetworkAttachmentDefinition/vm-igb/ovn-recon');
        expect(text('network-summary')).toContain('sriov');
        expect(container.querySelector('[data-testid="network-owner"]')).toBeNull();
        expect(links()).toContain('/ovn-recon/networks/nad/default/vm-igb');
    });

    it('names the CUDN behind a generated NAD', async () => {
        const nad = coverageNads.find((item) => item.metadata?.namespace === 'demo-mirror' && item.metadata?.name === 'vlan-1924');
        await render(NetworkAttachmentDefinitionTab, nad, '/k8s/ns/demo-mirror/k8s.cni.cncf.io~v1~NetworkAttachmentDefinition/vlan-1924/ovn-recon');
        expect(text('network-owner')).toContain('Generated by ClusterUserDefinedNetwork vlan-1924');
    });

    it('uses the model kind when the object carries none', async () => {
        const cudn = coverageCudns.find((item) => item.metadata?.name === 'vlan-1924');
        await render(ClusterUserDefinedNetworkTab, { metadata: cudn?.metadata }, '/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/vlan-1924/ovn-recon');
        expect(links()).toContain('/ovn-recon/networks/cudn/vlan-1924');
    });

    it('renders the summary without the matrix when NodeNetworkState is not served', async () => {
        mockModels.NodeNetworkState = undefined;
        const cudn = coverageCudns.find((item) => item.metadata?.name === 'vlan-1924');
        await render(ClusterUserDefinedNetworkTab, cudn, '/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/vlan-1924/ovn-recon');
        expect(text('network-summary')).toContain('physnet-vmdata');
        expect(text('placement-unavailable')).toContain('does not serve NodeNetworkState');
    });

    it('shows an empty state for a network OVN Recon cannot see', async () => {
        await render(ClusterUserDefinedNetworkTab,
            { kind: 'ClusterUserDefinedNetwork', metadata: { name: 'invisible' } },
            '/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/invisible/ovn-recon');
        expect(text('ovn-recon-tab-no-network')).toContain('OVN Recon cannot see this network');
    });

    it('waits for the network object', async () => {
        await render(NetworkAttachmentDefinitionTab, undefined, '/k8s/ns/default/x/ovn-recon');
        expect(container.textContent).toContain('Loading...');
    });
});
