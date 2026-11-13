import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, NavigateFunction, Route, Routes, useLocation, useNavigate } from 'react-router';

import { createPhysicalEvaluator } from '../insights/evaluate';
import { makeFinding, nodeRef } from '../insights/refs';
import { PHYSICAL_RULES } from '../insights/registry';
import type { PhysicalRule } from '../insights/types';
import { FindingsEvaluatorContext, HIDE_INFO_STORAGE_KEY } from '../insights/ui/useFindings';
import { BASE_PATH, clusterFindingsPath, nodeFindingsPath, nodePhysicalPath, overviewPath } from '../routes';
import { ClusterUserDefinedNetwork, NetworkAttachmentDefinition, NodeNetworkState } from '../types';
import { NETWORKS_GROUP_ID, networkItemId, nodeItemId, NODES_GROUP_ID } from './explorerTreeModel';
import OvnReconApp from './OvnReconApp';

/**
 * Findings in the explorer (ovn-recon-gbr.7): the tree's badges and its "With findings
 * only" switch, and the Findings tab at cluster and node scope, all from the shell's
 * one evaluation. Drawn from the ten-node localnet-coverage capture, where three
 * Localnet CUDNs are mapped on no node (network-wide warnings); a node finding is
 * made by taking worker-2's ens224 down.
 */

const items = <T,>(...segments: string[]): T[] => {
    const data = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8'),
    ) as T[] | { items: T[] };
    return Array.isArray(data) ? data : data.items;
};

// [data, loaded, error] per kind; absent kinds load as empty.
const mockWatches: Record<string, [unknown, boolean, unknown]> = {};

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    DocumentTitle: () => null,
    useK8sWatchResource: (resource: { groupVersionKind: { kind: string } }) =>
        mockWatches[resource.groupVersionKind.kind] ?? [[], true, undefined],
}));

jest.mock('./useOvnCollectorFeatureGate', () => ({
    useOvnCollectorFeatureGate: () => ({ enabled: false, loaded: true, loadError: null }),
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
jest.mock('./NetworkDetails', () => ({ __esModule: true, default: mockBodyStub('network') }));
jest.mock('./ClusterLogicalTopologyDetails', () => ({ __esModule: true, ClusterLogicalTopologyBody: mockBodyStub('cluster-logical') }));

const coverage = {
    nns: items<NodeNetworkState>('nns', 'cluster-localnet-coverage.json'),
    cudns: items<ClusterUserDefinedNetwork>('cudn', 'cluster-localnet-coverage.json'),
    nads: items<NetworkAttachmentDefinition>('nad', 'cluster-localnet-coverage.json'),
};

const withState = (nns: NodeNetworkState, name: string, state: string): NodeNetworkState => {
    const copy = JSON.parse(JSON.stringify(nns)) as NodeNetworkState;
    copy.status!.currentState!.interfaces.forEach((iface) => { if (iface.name === name) iface.state = state; });
    return copy;
};
const worker2Down = coverage.nns.map((nns) => (nns.metadata?.name === 'worker-2' ? withState(nns, 'ens224', 'down') : nns));

/** An info finding on worker-1, to show what hiding info does. */
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

const LOCALNET_UNMAPPED = ['vlan-333', 'vlan-333-again', 'vlan-999'].map((name) => networkItemId({ kind: 'cudn', name }));

describe('OvnReconApp findings (ovn-recon-gbr.7)', () => {
    let container: HTMLDivElement;
    let root: Root;
    let navigate: NavigateFunction;
    let current: string;

    const Probe: React.FC = () => {
        navigate = useNavigate();
        current = useLocation().pathname;
        return null;
    };

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        window.localStorage.clear();
        Object.keys(mockWatches).forEach((key) => delete mockWatches[key]);
        mockWatches.NodeNetworkState = [worker2Down, true, undefined];
        mockWatches.Node = [coverage.nns.map((nns) => ({ metadata: { name: nns.metadata?.name, labels: {} } })), true, undefined];
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
                await Promise.resolve();
            });
        }
    };

    const render = async (initialEntry: string, evaluator?: ReturnType<typeof createPhysicalEvaluator>) => {
        const app = (
            <MemoryRouter initialEntries={[initialEntry]}>
                <Probe />
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

    const go = async (to: string) => {
        await act(async () => {
            navigate(to);
        });
        await settle();
    };

    const byTestId = (id: string): HTMLElement | null => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    const badge = (id: string): HTMLElement | null => byTestId(`explorer-tree-findings-${id}`);
    const badged = (): string[] => Array.from(container.querySelectorAll('[data-testid^="explorer-tree-findings-"]'))
        .map((element) => element.getAttribute('data-testid')!.replace('explorer-tree-findings-', ''));
    const tabCount = (testId: string): string | null =>
        byTestId(testId)?.querySelector('.pf-v6-c-badge')?.textContent ?? null;
    const switchInput = (): HTMLInputElement | null =>
        container.querySelector<HTMLInputElement>('#explorer-tree-findings-only');
    const groupMembers = (groupId: string): string[] => Array.from(
        byTestId(`explorer-tree-${groupId}`)?.closest('[role="treeitem"]')?.querySelectorAll('[role="group"] [role="treeitem"]') ?? [],
    ).map((item) => item.id);
    const click = async (element: Element | null) => {
        expect(element).not.toBeNull();
        await act(async () => {
            (element as HTMLElement).click();
        });
        await settle();
    };

    describe('the tree', () => {
        it('badges each node and network with findings, and the closed Networks group, as the tables count them', async () => {
            await render(overviewPath());
            // Nodes is open, so worker-2 carries its own badge; Networks is closed, so it carries its members'.
            expect(badged()).toEqual([nodeItemId('worker-2'), NETWORKS_GROUP_ID]);
            expect(badge(nodeItemId('worker-2'))?.textContent).toBe(' 1, 1 warning');
            expect(badge(nodeItemId('worker-2'))?.getAttribute('title')).toBe('1 warning');
            expect(badge(NETWORKS_GROUP_ID)?.getAttribute('title')).toBe('3 warnings');
            // The node table's Findings column says the same.
            expect(byTestId('overview-findings-worker-2')?.querySelector('a')?.getAttribute('aria-label')).toBe('1 warning on worker-2');

            // Opened, the group hands its badge to the networks themselves.
            await click(byTestId(`explorer-tree-${NETWORKS_GROUP_ID}`));
            expect(badge(NETWORKS_GROUP_ID)).toBeNull();
            LOCALNET_UNMAPPED.forEach((id) => expect(badge(id)?.getAttribute('title')).toBe('1 warning'));
            // Closing Nodes moves worker-2's badge onto the group.
            await click(byTestId(`explorer-tree-${NODES_GROUP_ID}`));
            expect(badge(NODES_GROUP_ID)?.getAttribute('title')).toBe('1 warning');
        });

        it('narrows to what has findings with "With findings only", and back', async () => {
            await render(overviewPath());
            const allNodes = groupMembers(NODES_GROUP_ID).length;
            expect(allNodes).toBe(coverage.nns.length);
            await click(switchInput());
            expect(switchInput()?.checked).toBe(true);
            expect(groupMembers(NODES_GROUP_ID)).toEqual([nodeItemId('worker-2')]);
            expect(groupMembers(NETWORKS_GROUP_ID)).toEqual(LOCALNET_UNMAPPED);
            // The group badges count what is listed.
            expect(byTestId(`explorer-tree-${NODES_GROUP_ID}`)?.closest('[role="treeitem"]')?.querySelector('.pf-v6-c-tree-view__node-count')?.textContent)
                .toBe('1');

            // The selection stays listed though it has no findings.
            await go(nodePhysicalPath('worker-1'));
            expect(groupMembers(NODES_GROUP_ID)).toEqual([nodeItemId('worker-1'), nodeItemId('worker-2')]);

            await click(switchInput());
            expect(groupMembers(NODES_GROUP_ID)).toHaveLength(allNodes);
        });

        it('drops a hidden info finding from the badges, the tab and the table alike', async () => {
            await render(overviewPath(), createPhysicalEvaluator({ rules: [...PHYSICAL_RULES, testInfoRule] }));
            expect(badge(nodeItemId('worker-1'))?.getAttribute('title')).toBe('1 info finding');
            expect(tabCount('cluster-tab-findings')).toBe('5');

            await go(clusterFindingsPath());
            await click(container.querySelector('#cluster-hide-info-findings'));
            expect(window.localStorage.getItem(HIDE_INFO_STORAGE_KEY)).toBe('true');
            expect(badge(nodeItemId('worker-1'))).toBeNull();
            expect(tabCount('cluster-tab-findings')).toBe('4');
            await go(overviewPath());
            expect(byTestId('overview-findings-worker-1')?.textContent).toBe('');
        });
    });

    describe('the Findings tab', () => {
        it('on Cluster: every finding grouped by rule, open, each linked to its subject', async () => {
            await render(clusterFindingsPath());
            expect(tabCount('cluster-tab-findings')).toBe('4');
            const panel = byTestId('findings-panel')!;
            expect(panel.querySelector('[data-testid="count-warning"]')?.textContent).toBe('4 warnings');
            expect(panel.querySelectorAll('[data-testid="findings-entry"]')).toHaveLength(4);
            const down = panel.querySelector('[data-testid="findings-group-interface-down"]')!;
            expect(down.querySelector('a')?.getAttribute('href')).toBe('/ovn-recon/node-network-state/worker-2?select=iface:ens224');
            expect(down.textContent).toContain('on worker-2');
        });

        it('on a node: that node\'s findings, linked to its graph, with the tab\'s count', async () => {
            await render(nodeFindingsPath('worker-2'));
            expect(container.querySelector('[data-testid="node-tabs"] .pf-m-current [data-testid]')?.getAttribute('data-testid'))
                .toBe('node-tab-findings');
            expect(tabCount('node-tab-findings')).toBe('1');
            const panel = byTestId('findings-panel')!;
            const entries = Array.from(panel.querySelectorAll('[data-testid="findings-entry"]'));
            expect(entries).toHaveLength(1);
            expect(entries[0].querySelector('a')?.getAttribute('href')).toBe('/ovn-recon/node-network-state/worker-2?select=iface:ens224');
            // It is this node's list: the summary alone, without the cluster list's "on worker-2" after it.
            expect(entries[0].textContent).toBe('Interface ens224 on worker-2 is down.');
            // The network-wide findings are not the node's.
            expect(panel.querySelector('[data-testid="findings-group-localnet-unmapped"]')).toBeNull();
        });

        it('keeps the Findings tab when the node switcher picks another node, and reads 0 there', async () => {
            await render(nodeFindingsPath('worker-2'));
            await click(byTestId('node-switcher'));
            await click(document.querySelector('[data-testid="node-switcher-worker-1"] button'));
            expect(current).toBe(nodeFindingsPath('worker-1'));
            expect(tabCount('node-tab-findings')).toBe('0');
            expect(byTestId('findings-none')?.textContent).toBe('No findings on worker-1.');
        });
    });

    describe('with no findings', () => {
        beforeEach(() => {
            mockWatches.NodeNetworkState = [coverage.nns, true, undefined];
            mockWatches.ClusterUserDefinedNetwork = [[], true, undefined];
            mockWatches.NetworkAttachmentDefinition = [[], true, undefined];
        });

        it('shows no badges and no switch, and the tabs read 0', async () => {
            await render(clusterFindingsPath());
            expect(badged()).toEqual([]);
            expect(switchInput()).toBeNull();
            expect(tabCount('cluster-tab-findings')).toBe('0');
            expect(byTestId('findings-none')?.textContent).toBe('No findings.');
            await go(nodeFindingsPath('worker-1'));
            expect(tabCount('node-tab-findings')).toBe('0');
            expect(byTestId('findings-none')?.textContent).toBe('No findings on worker-1.');
        });
    });

    describe('when NodeNetworkStates cannot be read', () => {
        beforeEach(() => {
            mockWatches.NodeNetworkState = [[], true, new Error('forbidden')];
        });

        it('says node findings are unknown, still lists the network ones, and gives a node no count', async () => {
            await render(clusterFindingsPath());
            const panel = byTestId('findings-panel')!;
            expect(panel.querySelector('[data-testid="findings-unavailable"]')?.textContent).toContain('could not be read');
            expect(panel.querySelector('[data-testid="findings-none"]')).toBeNull();

            await go(nodeFindingsPath('worker-1'));
            expect(tabCount('node-tab-findings')).toBeNull();
            expect(byTestId('findings-unavailable')?.textContent).toContain('this node\'s findings are unknown');
            expect(byTestId('findings-none')).toBeNull();
        });
    });
});
