import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';

import { BASE_PATH, clusterNetworkConfigPath, overviewPath } from '../routes';
import OvnReconApp from './OvnReconApp';

/**
 * The Cluster scope's Network config tab and summary strip, drawn by the shell from
 * its own watches (ovn-recon-n7r.1): the cluster network configuration read with the
 * user's permissions, each source failing on its own.
 */

const fixture: Record<string, unknown> = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'network-config', 'default.json'), 'utf-8'),
);

interface MockWatched {
    groupVersionKind: { group?: string; kind: string };
    name?: string;
    namespace?: string;
    isList?: boolean;
}

// [data, loaded, error] by `group/kind/name`; anything else loads as empty.
const mockObjects: Record<string, [unknown, boolean, unknown]> = {};
const mockRequests: MockWatched[] = [];

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    DocumentTitle: ({ children }: { children: React.ReactNode }) => <span data-testid="document-title">{children}</span>,
    useK8sWatchResource: (resource: MockWatched) => {
        mockRequests.push(resource);
        if (resource.isList) return [[], true, undefined];
        const { group = 'core', kind } = resource.groupVersionKind;
        return mockObjects[`${group}/${kind}/${resource.name}`] ?? [undefined, true, { code: 404, message: 'not found' }];
    },
}));

jest.mock('./useOvnCollectorFeatureGate', () => ({
    useOvnCollectorFeatureGate: () => ({ enabled: false, loaded: true, loadError: null, collectorDeployment: undefined }),
}));

const KEYS = {
    operatorNetwork: 'operator.openshift.io/Network/cluster',
    configNetwork: 'config.openshift.io/Network/cluster',
    clusterOperator: 'config.openshift.io/ClusterOperator/network',
    featureGate: 'config.openshift.io/FeatureGate/cluster',
    infrastructure: 'config.openshift.io/Infrastructure/cluster',
};

describe('the Network config tab, drawn by the shell', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        Object.keys(mockObjects).forEach((key) => delete mockObjects[key]);
        mockRequests.length = 0;
        Object.entries(KEYS).forEach(([id, key]) => { mockObjects[key] = [fixture[id], true, undefined]; });
        global.fetch = jest.fn().mockRejectedValue(new Error('no collector in this test')) as unknown as typeof fetch;
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        jest.restoreAllMocks();
    });

    const render = async (initialEntry: string) => {
        await act(async () => {
            root.render(
                <MemoryRouter initialEntries={[initialEntry]}>
                    <Routes>
                        <Route path={`${BASE_PATH}/*`} element={<OvnReconApp />} />
                    </Routes>
                </MemoryRouter>,
            );
        });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    };

    const byTestId = (id: string): HTMLElement | null => container.querySelector(`[data-testid="${id}"]`);
    const row = (id: string) => byTestId(`network-config-row-${id}`);
    const text = (element: Element | null | undefined): string => element?.textContent ?? '';

    it('offers the tab on every cluster view, with the configuration in one line above', async () => {
        await render(overviewPath());
        const tab = byTestId('cluster-tab-config');
        expect(text(tab)).toBe('Network config');
        expect(tab?.querySelector('a')?.getAttribute('href') ?? tab?.getAttribute('href')).toBe(clusterNetworkConfigPath());
        const chips = [...byTestId('cluster-network-summary')!.querySelectorAll('a')];
        expect(chips.map(text)).toEqual([
            'Network type: OVNKubernetes', 'Gateway mode: Shared', 'Transport: Geneve', 'MTU: 1400', 'IPsec: Disabled', 'Routing: None',
        ]);
        chips.forEach((chip) => expect(chip.getAttribute('href')).toBe(clusterNetworkConfigPath()));
    });

    it('draws the grouped settings, each set or left to its default, with its source', async () => {
        await render(clusterNetworkConfigPath());
        expect(text(byTestId('document-title'))).toBe('OVN Recon - Network config');
        expect([...container.querySelectorAll('[data-testid^="network-config-section-"]')].map((section) => section.getAttribute('data-testid'))).toEqual([
            'addressing', 'overlay', 'gateway', 'routing', 'security', 'multi-network', 'other', 'cluster-config', 'operator', 'feature-gates',
        ].map((id) => `network-config-section-${id}`));

        const advertisements = row('route-advertisements')!;
        expect(text(advertisements.querySelector('[data-testid="network-config-value"]'))).toBe('Disabled');
        expect(text(advertisements.querySelector('[data-testid="network-config-origin"]'))).toBe('Default');
        expect(text(advertisements)).toContain('spec.defaultNetwork.ovnKubernetesConfig.routeAdvertisements');

        expect(text(row('network-type')!.querySelector('[data-testid="network-config-origin"]'))).toBe('Set');
        expect(text(row('transport')!.querySelector('[data-testid="network-config-immutable"]'))).toBe('Immutable');
        expect(row('ip-forwarding')!.querySelector('[data-testid="network-config-immutable"]')).toBeNull();
        expect(byTestId('network-config-missing')).toBeNull();
    });

    it('draws the capability checklist first, each prerequisite met or not with what was read', async () => {
        await render(clusterNetworkConfigPath());
        const panel = byTestId('network-config')!;
        const cards = [...panel.querySelectorAll('[data-testid="network-config-capabilities"], [data-testid^="network-config-section-"]')];
        expect(cards[0].getAttribute('data-testid')).toBe('network-config-capabilities');
        expect([...panel.querySelectorAll('[data-testid^="network-config-capability-"]')]
            .filter((element) => element.tagName === 'SECTION')
            .map((element) => element.getAttribute('data-testid')!.replace('network-config-capability-', ''))).toEqual([
            'route-advertisements', 'evpn', 'no-overlay', 'uplink-optional', 'multi-network-policy', 'ipsec', 'hybrid-overlay',
        ]);

        const evpn = byTestId('network-config-capability-evpn')!;
        expect(evpn.getAttribute('data-status')).toBe('not-ready');
        expect(text(evpn.querySelector('[data-testid="network-config-capability-status"]'))).toBe('2 of 6 prerequisites met');
        const forwarding = evpn.querySelector('[data-testid="network-config-prerequisite-ip-forwarding-global"]')!;
        expect(forwarding.getAttribute('data-state')).toBe('unmet');
        expect(text(forwarding)).toContain('Not met');
        expect(text(forwarding)).toContain('Restricted');
        expect(text(forwarding)).toContain('spec.defaultNetwork.ovnKubernetesConfig.gatewayConfig.ipForwarding');
        expect(evpn.querySelector('[data-testid="network-config-prerequisite-platform-bare-metal"]')!.getAttribute('data-state')).toBe('met');
        expect(text(byTestId('network-config-capability-no-overlay'))).toContain('Feature gate NoOverlayMode is enabled');
        // Lists load as empty here: no RouteAdvertisements, and VTEPs listed with none.
        expect(text(byTestId('network-config-capability-route-advertisements'))).toContain('No RouteAdvertisements resources exist');
        expect(text(evpn)).toContain('No VTEP resources exist');
    });

    it('links each section to its API reference and each source to its console page', async () => {
        await render(clusterNetworkConfigPath());
        expect(byTestId('network-config-section-gateway')!.querySelector('a')?.getAttribute('href'))
            .toBe('/api-resource/cluster/operator.openshift.io~v1~Network/');
        expect(byTestId('network-config-source-operatorNetwork')!.querySelector('a')?.getAttribute('href'))
            .toBe('/k8s/cluster/operator.openshift.io~v1~Network/cluster');
        expect(byTestId('network-config-source-clusterOperator')!.querySelector('a')?.getAttribute('href'))
            .toBe('/k8s/cluster/config.openshift.io~v1~ClusterOperator/network');
        // An optional ConfigMap that is not there is ordinary, and not a link.
        const overrides = byTestId('network-config-source-configMap:overrides')!;
        expect(text(overrides)).toContain('Not present');
        expect(overrides.querySelector('a')).toBeNull();
    });

    it('shows the operator conditions, a degraded one first', async () => {
        const operator = JSON.parse(JSON.stringify(fixture.clusterOperator));
        operator.status.conditions[0] = { type: 'Degraded', status: 'True', reason: 'RolloutHung', message: 'DaemonSet is not making progress' };
        mockObjects[KEYS.clusterOperator] = [operator, true, undefined];
        await render(clusterNetworkConfigPath());
        const rows = [...byTestId('network-config-conditions')!.querySelectorAll('tbody tr')];
        expect(rows).toHaveLength(10);
        expect(rows[0].getAttribute('data-severity')).toBe('danger');
        expect(text(rows[0])).toContain('RolloutHung');
    });

    it('names a source the user may not read and still draws the rest', async () => {
        mockObjects[KEYS.operatorNetwork] = [undefined, false, { code: 403, message: 'networks.operator.openshift.io "cluster" is forbidden' }];
        await render(clusterNetworkConfigPath());
        expect(text(byTestId('network-config-missing'))).toContain('Network operator configuration (Network cluster): not visible to you');
        expect(byTestId('network-config-section-gateway')).toBeNull();
        expect(byTestId('network-config-section-cluster-config')).not.toBeNull();
        expect(byTestId('network-config-source-operatorNetwork')!.getAttribute('data-status')).toBe('forbidden');
        expect(container.querySelector('[aria-label="Loading the cluster network configuration"]')).toBeNull();
    });

    it('waits with a spinner only until a source answers', async () => {
        Object.values(KEYS).forEach((key) => { mockObjects[key] = [undefined, false, undefined]; });
        ['applied-cluster', 'mtu', 'ovn-kubernetes-config-overrides', 'gateway-mode-config'].forEach((name) => {
            mockObjects[`core/ConfigMap/${name}`] = [undefined, false, undefined];
        });
        await render(clusterNetworkConfigPath());
        expect(container.querySelector('[aria-label="Loading the cluster network configuration"]')).not.toBeNull();
        expect(byTestId('cluster-network-summary')).toBeNull();
    });

    it('reads each object by name with a watch of its own, the ConfigMaps in the operator namespace', async () => {
        await render(clusterNetworkConfigPath());
        const single = mockRequests.filter((request) => !request.isList && request.name);
        const keys = new Set(single.map((request) => `${request.groupVersionKind.group ?? 'core'}/${request.groupVersionKind.kind}/${request.namespace ?? ''}/${request.name}`));
        expect(keys).toEqual(new Set([
            'operator.openshift.io/Network//cluster',
            'config.openshift.io/Network//cluster',
            'config.openshift.io/ClusterOperator//network',
            'config.openshift.io/FeatureGate//cluster',
            'config.openshift.io/Infrastructure//cluster',
            'core/ConfigMap/openshift-network-operator/applied-cluster',
            'core/ConfigMap/openshift-network-operator/mtu',
            'core/ConfigMap/openshift-network-operator/ovn-kubernetes-config-overrides',
            'core/ConfigMap/openshift-network-operator/gateway-mode-config',
        ]));
    });
});
