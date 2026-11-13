import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';

import { createPhysicalEvaluator } from '../insights/evaluate';
import { makeFinding, nodeRef } from '../insights/refs';
import { PHYSICAL_RULES } from '../insights/registry';
import type { PhysicalRule } from '../insights/types';
import { FindingsEvaluatorContext } from '../insights/ui/useFindings';
import { BASE_PATH, clusterFindingsPath, networksPath, overviewPath } from '../routes';
import { ClusterUserDefinedNetwork, NetworkAttachmentDefinition, NodeNetworkState } from '../types';
import OvnReconApp from './OvnReconApp';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';

/**
 * The Cluster scope's tabs and the shell's collector line, drawn from the shell's one
 * set of watches (ovn-recon-gbr.10): what the old overview page asserted of its node
 * table, networks table, findings card and collector line, now that the shell is the
 * only host. The ten-node localnet-coverage capture, where three Localnet CUDNs are
 * mapped on no node (network-wide warnings).
 */

const items = <T,>(...segments: string[]): T[] => {
    const data = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8'),
    ) as T[] | { items: T[] };
    return Array.isArray(data) ? data : data.items;
};

// [data, loaded, error] per kind; absent kinds load as empty.
const mockWatches: Record<string, [unknown, boolean, unknown]> = {};
const mockGate = {
    enabled: false,
    loaded: true,
    loadError: null as Error | null,
    collectorDeployment: { namespace: 'ovn-recon', name: 'ovn-recon-collector' },
};

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    DocumentTitle: () => null,
    useK8sWatchResource: (resource: { groupVersionKind: { kind: string } }) =>
        mockWatches[resource.groupVersionKind.kind] ?? [[], true, undefined],
}));

jest.mock('./useOvnCollectorFeatureGate', () => ({
    useOvnCollectorFeatureGate: () => ({ ...mockGate }),
}));

const mockBodyStub = (label: string) => {
    const Stub: React.FC = () => <div data-testid="passthrough">{label}</div>;
    return Stub;
};
jest.mock('./NodeNetworkStateDetails', () => ({
    __esModule: true,
    NodeNetworkStateBody: mockBodyStub('physical'),
    NodeRoutesBody: mockBodyStub('routes'),
}));
jest.mock('./NodeLogicalTopologyDetails', () => ({ __esModule: true, NodeLogicalTopologyBody: mockBodyStub('node-logical') }));
jest.mock('./ConstructDetails', () => ({ __esModule: true, ConstructExplorerBody: mockBodyStub('construct') }));
jest.mock('./NetworkDetails', () => ({ __esModule: true, NetworkExplorerBody: mockBodyStub('network') }));
jest.mock('./ClusterLogicalTopologyDetails', () => ({ __esModule: true, ClusterLogicalTopologyBody: mockBodyStub('cluster-logical') }));

const coverage = {
    nns: items<NodeNetworkState>('nns', 'cluster-localnet-coverage.json'),
    cudns: items<ClusterUserDefinedNetwork>('cudn', 'cluster-localnet-coverage.json'),
    nads: items<NetworkAttachmentDefinition>('nad', 'cluster-localnet-coverage.json'),
};

const roleOf = (name: string | undefined): string => (name?.startsWith('control') ? 'control-plane' : 'worker');

/** An info finding on worker-1, to show the rules' order and counts. */
const testInfoRule: PhysicalRule = {
    id: 'test-dated-practice',
    severity: 'info',
    scope: 'node',
    domain: 'physical',
    title: 'Dated practice (test)',
    evaluate: ({ node }) => {
        const name = node?.nns.metadata?.name;
        return name === 'worker-1' ? [makeFinding({
            ruleId: 'test-dated-practice', severity: 'info',
            subject: { kind: 'graph-node', node: name, graphNodeId: 'iface:br-ex' },
            scope: { node: name },
            summary: `Bridge br-ex on ${name} follows a dated practice.`,
            evidence: [], remedy: { text: 'Consider the current guidance.', target: nodeRef(name) },
        })] : [];
    },
};

const withState = (nns: NodeNetworkState, name: string, state: string): NodeNetworkState => {
    const copy = JSON.parse(JSON.stringify(nns)) as NodeNetworkState;
    copy.status!.currentState!.interfaces.forEach((iface) => { if (iface.name === name) iface.state = state; });
    return copy;
};

const freshTopology = () => ({
    metadata: { schemaVersion: '2', generatedAt: new Date().toISOString(), sourceHealth: 'healthy' },
    snapshots: [{ ...cnv1, metadata: { ...cnv1.metadata, generatedAt: new Date().toISOString() } }],
    warnings: [{ code: 'X', message: 'one warning' }],
});

describe('the Cluster scope, drawn by the shell', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        window.localStorage.clear();
        mockGate.enabled = false;
        mockGate.loaded = true;
        Object.keys(mockWatches).forEach((key) => delete mockWatches[key]);
        mockWatches.NodeNetworkState = [coverage.nns, true, undefined];
        mockWatches.Node = [
            coverage.nns.map((nns) => ({
                metadata: { name: nns.metadata?.name, labels: { [`node-role.kubernetes.io/${roleOf(nns.metadata?.name)}`]: '' } },
            })),
            true, undefined,
        ];
        mockWatches.ClusterUserDefinedNetwork = [coverage.cudns, true, undefined];
        mockWatches.NetworkAttachmentDefinition = [coverage.nads, true, undefined];
        global.fetch = jest.fn().mockRejectedValue(new Error('no collector in this test')) as unknown as typeof fetch;
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        jest.restoreAllMocks();
        window.localStorage.clear();
    });

    const settle = async () => {
        for (let round = 0; round < 3; round += 1) {
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
        }
    };

    const render = async (initialEntry: string, evaluator?: ReturnType<typeof createPhysicalEvaluator>) => {
        const app = (
            <MemoryRouter initialEntries={[initialEntry]}>
                <Routes>
                    <Route path={`${BASE_PATH}/*`} element={<OvnReconApp />} />
                </Routes>
            </MemoryRouter>
        );
        await act(async () => {
            root.render(evaluator
                ? <FindingsEvaluatorContext.Provider value={evaluator}>{app}</FindingsEvaluatorContext.Provider>
                : app);
        });
        await settle();
    };

    const byTestId = (id: string): HTMLElement | null => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    const content = (): HTMLElement => container.querySelector<HTMLElement>('.pf-v6-c-drawer__content')!;

    describe('the collector line in the title row', () => {
        const status = () => byTestId('explorer-collector-status')!;
        // PatternFly mounts the popover in document.body.
        const openDetails = async (): Promise<string> => {
            const button = Array.from(status().querySelectorAll('button'))
                .find((candidate) => candidate.textContent === 'Collector details');
            expect(button).toBeDefined();
            await act(async () => {
                button!.click();
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
            return document.querySelector('[data-testid="overview-collector-details"]')?.textContent ?? '';
        };

        it('states a fresh collector in one line, with the rest behind Collector details', async () => {
            mockGate.enabled = true;
            global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => freshTopology() }) as unknown as typeof fetch;
            await render(overviewPath());

            expect(status().textContent).toContain('Fresh');
            expect(status().textContent).toContain('Assembled from 1 node');
            expect(status().textContent).toContain('1 collector warning');
            // The line stays short: the warning's text is in the popover.
            expect(status().textContent).not.toContain('one warning');

            const details = await openDetails();
            expect(details).toContain('Source healthhealthy');
            expect(details).toContain('Node databases1');
            expect(details).toContain('Oldest snapshot');
            expect(details).toContain('X: one warning');
        });

        it('shows the collector as unreachable without hiding the node table', async () => {
            mockGate.enabled = true;
            (global.fetch as jest.Mock).mockRejectedValue(new Error('boom'));
            await render(overviewPath());

            expect(status().textContent).toContain('Collector is not answering');
            expect(await openDetails()).toContain('boom');
            expect(byTestId('overview-node-worker-1')).not.toBeNull();
        });

        // ovn-recon-nt4.4: during a collector restart the plugin's proxy answers 502 and
        // the console's other routes 404. One line with the status, where to look, and
        // the routes tried behind Details.
        it('says the collector is not answering with its HTTP status, where to look, and the routes tried', async () => {
            mockGate.enabled = true;
            global.fetch = jest.fn().mockImplementation(async (url: string) => ({
                ok: false,
                status: url.startsWith('/api/plugins/ovn-recon/api/v1') ? 502 : 404,
                json: async () => ({}),
            })) as unknown as typeof fetch;
            await render(overviewPath());

            expect(status().textContent).toContain('Collector is not answering (HTTP 502)');
            expect(status().textContent).not.toContain('/api/');

            await openDetails();
            const details = document.querySelector('[data-testid="overview-collector-details"]')!;
            const links = Array.from(details.querySelectorAll('[data-testid="collector-links"] a'))
                .map((link) => [link.textContent, link.getAttribute('href')]);
            expect(links).toEqual([
                ['Collector Deployment', '/k8s/ns/ovn-recon/apps~v1~Deployment/ovn-recon-collector'],
                ['Pods', '/k8s/ns/ovn-recon/apps~v1~Deployment/ovn-recon-collector/pods'],
                ['Events', '/k8s/ns/ovn-recon/apps~v1~Deployment/ovn-recon-collector/events'],
            ]);
            const toggle = details.querySelector<HTMLButtonElement>(
                '[data-testid="collector-failure-details"] button')!;
            expect(toggle.textContent).toBe('Details');
            expect(toggle.getAttribute('aria-expanded')).toBe('false');
            await act(async () => { toggle.click(); });
            expect(toggle.getAttribute('aria-expanded')).toBe('true');
            const attempts = Array.from(details.querySelectorAll('[data-testid="collector-failure-details"] li'))
                .map((item) => item.textContent);
            expect(attempts).toEqual([
                '/api/plugins/ovn-recon/api/v1/snapshots -> HTTP 502',
                '/api/plugins/ovn-recon/backend/api/v1/snapshots -> HTTP 404',
                '/api/proxy/plugin/ovn-recon/backend/api/v1/snapshots -> HTTP 404',
                '/api/proxy/plugin/ovn-recon/api/v1/snapshots -> HTTP 404',
            ]);
        });

        it('says nothing about the collector until the gate is known', async () => {
            mockGate.loaded = false;
            await render(overviewPath());

            expect(status().textContent).toBe('Loading...');
            expect(status().querySelector('button')).toBeNull();
            expect(global.fetch).not.toHaveBeenCalled();
        });
    });

    describe('the Nodes tab', () => {
        it('gives each node its role from the Node list and its views', async () => {
            await render(overviewPath());

            const worker = byTestId('overview-node-worker-1')!;
            expect(worker.querySelectorAll('td')[1].textContent).toBe('worker');
            expect(byTestId('overview-node-control-1')!.querySelectorAll('td')[1].textContent).toBe('control plane');
            expect(Array.from(worker.querySelectorAll('td:last-child a')).map((anchor) => anchor.getAttribute('href'))).toEqual([
                '/ovn-recon/node-network-state/worker-1',
                '/k8s/cluster/nmstate.io~v1beta1~NodeNetworkState/worker-1',
            ]);
            expect(content().textContent).toContain('10 nodes with NodeNetworkState');
        });

        it('lists every node and reports no findings when only the optional sources are absent', async () => {
            mockWatches.ClusterUserDefinedNetwork = [undefined, false, new Error('no such kind')];
            mockWatches.UserDefinedNetwork = [undefined, false, new Error('no such kind')];
            mockWatches.NetworkAttachmentDefinition = [null, true, undefined];
            mockWatches.NodeNetworkConfigurationEnactment = [undefined, false, new Error('no such kind')];
            await render(overviewPath());

            expect(content().querySelectorAll('[data-testid^="overview-node-"]')).toHaveLength(10);
            expect(byTestId('cluster-tab-findings')?.querySelector('.pf-v6-c-badge')?.textContent).toBe('0');
        });
    });

    describe('the Networks tab', () => {
        const networkRow = (name: string) => byTestId(`overview-network-cudn-${name}`)!;
        const cells = (name: string) => Array.from(networkRow(name).querySelectorAll('td')).map((td) => td.textContent);
        const rowNames = () => Array.from(container.querySelectorAll('[data-testid^="overview-network-cudn-"]'))
            .map((tr) => tr.querySelector('td')!.textContent);

        it('lists the networks findings first, with the nodes each is wired on and its findings', async () => {
            await render(networksPath());

            expect(rowNames()).toEqual(['vlan-333', 'vlan-333-again', 'vlan-999', 'machinenet', 'vlan-1924', 'vlan-1926']);
            // The tab adds the physical network (or subnets) before the nodes wired.
            expect(cells('machinenet')).toEqual(['machinenet', 'CUDN', 'Localnet', 'Secondary', 'physnet', '10 of 10', '']);
            expect(cells('vlan-1924')[5]).toBe('4 of 10');
            expect(cells('vlan-333')[5]).toBe('0 of 10');

            expect(networkRow('vlan-1924').querySelector('a')!.getAttribute('href')).toBe('/ovn-recon/networks/cudn/vlan-1924');
            const findings = byTestId('overview-network-findings-cudn-vlan-999')!.querySelector('a')!;
            expect(findings.getAttribute('href')).toBe('/ovn-recon/networks/cudn/vlan-999');
            expect(findings.getAttribute('aria-label')).toBe('1 warning on vlan-999');
        });

        it('does not claim a network is wired nowhere while no node state is known', async () => {
            mockWatches.NodeNetworkState = [undefined, false, new Error('forbidden')];
            await render(networksPath());

            expect(cells('machinenet')).toEqual(['machinenet', 'CUDN', 'Localnet', 'Secondary', 'physnet', '-', '']);
            expect(cells('vlan-333')[5]).toBe('-');
        });
    });

    describe('the Findings tab', () => {
        it('lists a Localnet network mapped on no node once, linked to its network page, with a node page second', async () => {
            await render(clusterFindingsPath());

            const group = byTestId('findings-group-localnet-unmapped')!;
            const entries = Array.from(group.querySelectorAll('[data-testid="findings-entry"]'));
            const first = entries.map((entry) => entry.querySelector('a')!);
            expect(first.map((a) => a.textContent)).toEqual([
                'ClusterUserDefinedNetwork vlan-333 names physical network thirdmap, which no node maps to a bridge.',
                'ClusterUserDefinedNetwork vlan-333-again names physical network secondmap, which no node maps to a bridge.',
                'ClusterUserDefinedNetwork vlan-999 names physical network secondmap, which no node maps to a bridge.',
            ]);
            expect(first.map((a) => a.getAttribute('href'))).toEqual([
                '/ovn-recon/networks/cudn/vlan-333',
                '/ovn-recon/networks/cudn/vlan-333-again',
                '/ovn-recon/networks/cudn/vlan-999',
            ]);
            // Then the first node by name, with the CUDN selected; every node's graph draws it.
            const second = entries.map((entry) => entry.querySelector('[data-testid="findings-entry-secondary"] a')!);
            expect(second.map((a) => a.textContent)).toEqual(Array(3).fill('Physical view on control-1'));
            expect(second.map((a) => a.getAttribute('href'))).toEqual([
                '/ovn-recon/node-network-state/control-1?select=cudn:vlan-333',
                '/ovn-recon/node-network-state/control-1?select=cudn:vlan-333-again',
                '/ovn-recon/node-network-state/control-1?select=cudn:vlan-999',
            ]);
            expect(group.textContent).toContain('network-wide');
        });

        it('counts by severity, then each rule that fired and how often, warnings\' rules first', async () => {
            mockWatches.NodeNetworkState = [
                coverage.nns.map((nns) => (nns.metadata?.name === 'worker-2' ? withState(nns, 'ens224', 'down') : nns)),
                true, undefined,
            ];
            await render(clusterFindingsPath(), createPhysicalEvaluator({ rules: [...PHYSICAL_RULES, testInfoRule] }));

            const panel = byTestId('findings-panel')!;
            const counts = panel.querySelector('[data-testid="findings-counts"]')!;
            expect(counts.querySelector('[data-testid="count-warning"]')!.textContent).toBe('4 warnings');
            expect(counts.querySelector('[data-testid="count-info"]')!.textContent).toBe('1 info');

            const rules = Array.from(panel.querySelectorAll('section[data-testid^="findings-group-"]'));
            // The test rule is not in the registry, so it goes by its id.
            expect(rules.map((rule) => rule.getAttribute('aria-label'))).toEqual([
                'Interface carrying traffic is down', 'Localnet network mapped on no node', 'test-dated-practice',
            ]);
            expect(rules.map((rule) => rule.querySelector('[data-testid="findings-group-count"]')!.textContent)).toEqual(['1', '3', '1']);
            expect(panel.querySelectorAll('[data-testid="findings-entry"]')).toHaveLength(5);
            const infoEntry = panel.querySelector<HTMLElement>('[data-testid="findings-group-test-dated-practice"] [data-testid="findings-entry"]')!;
            expect(infoEntry.style.color).toContain('--pf-t--global--text--color--subtle');
        });

        it('stays quiet while NodeNetworkStates are loading', async () => {
            mockWatches.NodeNetworkState = [[], false, undefined];
            await render(clusterFindingsPath());

            const panel = byTestId('findings-panel') ?? content();
            expect(panel.textContent).toContain('Loading...');
            expect(panel.querySelector('[data-testid="count-warning"]')).toBeNull();
            expect(byTestId('cluster-tab-findings')?.querySelector('.pf-v6-c-badge')).toBeNull();
        });

        it('reports nothing, and keeps the other tabs, when every source is missing or refused', async () => {
            mockWatches.NodeNetworkState = [undefined, false, new Error('forbidden')];
            mockWatches.ClusterUserDefinedNetwork = [undefined, false, new Error('no such kind')];
            mockWatches.NetworkAttachmentDefinition = [null, true, undefined];
            mockWatches.NodeNetworkConfigurationEnactment = [undefined, false, new Error('no such kind')];
            await render(clusterFindingsPath());

            const panel = byTestId('findings-panel')!;
            expect(panel.querySelector('[data-testid="findings-unavailable"]')).not.toBeNull();
            expect(panel.querySelector('[data-testid="findings-none"]')).toBeNull();
            expect(panel.querySelector('[data-testid="count-warning"]')).toBeNull();
        });
    });
});
