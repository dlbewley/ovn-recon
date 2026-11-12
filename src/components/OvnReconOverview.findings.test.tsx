import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { ClusterUserDefinedNetwork, NetworkAttachmentDefinition, NodeNetworkState } from '../types';
import { createPhysicalEvaluator } from '../insights/evaluate';
import { makeFinding, nodeRef } from '../insights/refs';
import { PHYSICAL_RULES } from '../insights/registry';
import type { PhysicalRule } from '../insights/types';
import { FindingsEvaluatorContext, HIDE_INFO_STORAGE_KEY } from '../insights/ui/useFindings';
import OvnReconOverview from './OvnReconOverview';
import { TestRouter } from './testRouter';

/**
 * Findings on the overview (ovn-recon-7i6.1): the node table's Findings column and the
 * findings card, whose list links each finding to its subject with ?select=.
 */

const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;
const items = <T,>(...segments: string[]): T[] => {
    const data = fixture<T[] | { items: T[] }>(...segments);
    return Array.isArray(data) ? data : data.items;
};

// [data, loaded, error] per kind; absent kinds load as empty.
const mockWatches: Record<string, [unknown, boolean, unknown]> = {};
jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    DocumentTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useK8sWatchResource: (resource: { groupVersionKind: { kind: string } }) =>
        mockWatches[resource.groupVersionKind.kind] ?? [[], true, undefined],
}));

jest.mock('./useOvnCollectorFeatureGate', () => ({
    useOvnCollectorFeatureGate: () => ({ enabled: false, loaded: true }),
}));

const withState = (nns: NodeNetworkState, name: string, state: string): NodeNetworkState => {
    const copy = JSON.parse(JSON.stringify(nns)) as NodeNetworkState;
    copy.status!.currentState!.interfaces.forEach((iface) => { if (iface.name === name) iface.state = state; });
    return copy;
};

// The real ten-node capture: thirdmap and secondmap are mapped on no node, so three
// Localnet CUDNs (vlan-333, vlan-333-again, vlan-999) are network-wide findings.
const coverage = {
    nns: items<NodeNetworkState>('nns', 'cluster-localnet-coverage.json'),
    cudns: items<ClusterUserDefinedNetwork>('cudn', 'cluster-localnet-coverage.json'),
    nads: items<NetworkAttachmentDefinition>('nad', 'cluster-localnet-coverage.json'),
};

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
            evidence: [], remedy: { text: 'Consider the current guidance.', target: nodeRef(name) }
        })] : [];
    }
};

describe('OvnReconOverview findings', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        Object.keys(mockWatches).forEach((key) => delete mockWatches[key]);
        mockWatches.NodeNetworkState = [coverage.nns, true, undefined];
        mockWatches.ClusterUserDefinedNetwork = [coverage.cudns, true, undefined];
        mockWatches.NetworkAttachmentDefinition = [coverage.nads, true, undefined];
        window.localStorage.clear();
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        jest.restoreAllMocks();
        window.localStorage.clear();
    });

    const render = async (evaluator?: ReturnType<typeof createPhysicalEvaluator>) => {
        const page = (
            <TestRouter initialEntry="/ovn-recon">
                <OvnReconOverview />
            </TestRouter>
        );
        await act(async () => {
            root.render(evaluator
                ? <FindingsEvaluatorContext.Provider value={evaluator}>{page}</FindingsEvaluatorContext.Provider>
                : page);
        });
    };

    const card = () => container.querySelector('[data-testid="overview-findings-card"]')!;
    const expand = () => {
        const toggle = Array.from(card().querySelectorAll('button')).find((b) => b.textContent === 'Show findings');
        expect(toggle).toBeDefined();
        act(() => toggle!.click());
    };
    const findingsCell = (node: string) => container.querySelector(`[data-testid="overview-findings-${node}"]`)!;

    it('lists a Localnet network mapped on no node once, linked to its network page, with a node page second', async () => {
        await render();
        expect(card().querySelector('[data-testid="count-warning"]')?.textContent).toContain('3');
        expand();
        const group = card().querySelector('[data-testid="findings-group-localnet-unmapped"]')!;
        const entries = Array.from(group.querySelectorAll('[data-testid="findings-entry"]'));
        const first = entries.map((entry) => entry.querySelector('a')!);
        expect(first.map((a) => a.textContent)).toEqual([
            'ClusterUserDefinedNetwork vlan-333 names physical network thirdmap, which no node maps to a bridge.',
            'ClusterUserDefinedNetwork vlan-333-again names physical network secondmap, which no node maps to a bridge.',
            'ClusterUserDefinedNetwork vlan-999 names physical network secondmap, which no node maps to a bridge.',
        ]);
        // The network's own page first.
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
        // Network-wide: no node's Findings column counts them.
        coverage.nns.forEach((nns) => expect(findingsCell(nns.metadata!.name!).textContent).toBe(''));
    });

    it('summarizes before anything is opened: the counts, then each rule that fired and how often', async () => {
        mockWatches.NodeNetworkState = [
            coverage.nns.map((nns) => (nns.metadata?.name === 'worker-2' ? withState(nns, 'ens224', 'down') : nns)),
            true, undefined,
        ];
        await render(createPhysicalEvaluator({ rules: [...PHYSICAL_RULES, testInfoRule] }));
        const counts = card().querySelector('[data-testid="findings-counts"]')!;
        expect(counts.querySelector('[data-testid="count-warning"]')!.textContent).toBe('4 warnings');
        expect(counts.querySelector('[data-testid="count-info"]')!.textContent).toBe('1 info');

        const rules = Array.from(card().querySelectorAll('[data-testid^="findings-group-"]:not([data-testid="findings-group-count"])'));
        // Warnings' rules first. The test rule is not in the registry, so it goes by its id.
        expect(rules.map((rule) => rule.getAttribute('aria-label'))).toEqual([
            'Interface carrying traffic is down', 'Localnet network mapped on no node', 'test-dated-practice',
        ]);
        expect(rules.map((rule) => rule.querySelector('[data-testid="findings-group-count"]')!.textContent)).toEqual(['1', '3', '1']);
        // The findings themselves wait for "Show findings".
        expect(card().querySelector('[data-testid="findings-entry"]')).toBeNull();
        const toggle = Array.from(card().querySelectorAll('button')).find((b) => b.textContent === 'Show findings')!;
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expand();
        expect(card().querySelectorAll('[data-testid="findings-entry"]')).toHaveLength(5);
        expect(Array.from(card().querySelectorAll('button')).find((b) => b.textContent === 'Hide findings')!
            .getAttribute('aria-expanded')).toBe('true');
    });

    it('counts a network finding in that network\'s row of the networks table', async () => {
        await render();
        const cell = container.querySelector('[data-testid="overview-network-findings-cudn-vlan-999"]')!;
        expect(cell.querySelector('a')?.getAttribute('aria-label')).toBe('1 warning on vlan-999');
        expect(container.querySelector('[data-testid="overview-network-findings-cudn-machinenet"]')!.textContent).toBe('');
    });

    it('counts a node finding in that node\'s row, linking to the node page, and lists it with ?select=', async () => {
        mockWatches.NodeNetworkState = [
            coverage.nns.map((nns) => (nns.metadata?.name === 'worker-2' ? withState(nns, 'ens224', 'down') : nns)),
            true, undefined,
        ];
        await render();
        const cell = findingsCell('worker-2');
        expect(cell.querySelector('a')?.getAttribute('href')).toBe('/ovn-recon/node-network-state/worker-2');
        expect(cell.querySelector('a')?.getAttribute('aria-label')).toBe('1 warning on worker-2');
        expect(findingsCell('worker-1').textContent).toBe('');
        expand();
        const group = card().querySelector('[data-testid="findings-group-interface-down"]')!;
        expect(group.querySelector('a')?.getAttribute('href'))
            .toBe('/ovn-recon/node-network-state/worker-2?select=iface:ens224');
        expect(group.textContent).toContain('on worker-2');
    });

    it('says there are none, with no list and no toggle, when nothing fires', async () => {
        mockWatches.ClusterUserDefinedNetwork = [[], true, undefined];
        mockWatches.NetworkAttachmentDefinition = [[], true, undefined];
        await render();
        expect(card().querySelector('[data-testid="findings-none"]')?.textContent).toBe('No findings.');
        expect(card().querySelector('button')).toBeNull();
        expect(container.querySelector('#overview-hide-info-findings')).toBeNull();
    });

    it('shows info findings by default and hides them with the remembered toggle', async () => {
        await render(createPhysicalEvaluator({ rules: [...PHYSICAL_RULES, testInfoRule] }));
        expect(card().querySelector('[data-testid="count-info"]')?.textContent).toContain('1');
        expect(findingsCell('worker-1').querySelector('[data-testid="count-info"]')).not.toBeNull();
        expand();
        const infoEntry = card().querySelector('[data-testid="findings-group-test-dated-practice"] [data-testid="findings-entry"]') as HTMLElement;
        expect(infoEntry.style.color).toContain('--pf-t--global--text--color--subtle');

        const toggle = container.querySelector<HTMLInputElement>('#overview-hide-info-findings')!;
        act(() => toggle.click());
        expect(card().querySelector('[data-testid="count-info"]')).toBeNull();
        expect(findingsCell('worker-1').textContent).toBe('');
        expect(card().querySelector('[data-testid="findings-group-test-dated-practice"]')).toBeNull();
        expect(window.localStorage.getItem(HIDE_INFO_STORAGE_KEY)).toBe('true');
    });

    it('renders the page and reports nothing when sources are missing or refused', async () => {
        mockWatches.NodeNetworkState = [undefined, false, new Error('forbidden')];
        mockWatches.ClusterUserDefinedNetwork = [undefined, false, new Error('no such kind')];
        mockWatches.NetworkAttachmentDefinition = [null, true, undefined];
        mockWatches.NodeNetworkConfigurationEnactment = [undefined, false, new Error('no such kind')];
        await render();
        expect(card().querySelector('[data-testid="findings-none"]')).toBeNull();
        expect(card().querySelector('[data-testid="findings-unavailable"]')).not.toBeNull();
        expect(card().querySelector('[data-testid="count-warning"]')).toBeNull();
        expect(container.querySelector('[data-testid="overview-networks-card"]')).not.toBeNull();
    });

    it('reports nothing and breaks nothing when only the optional sources are absent', async () => {
        mockWatches.ClusterUserDefinedNetwork = [undefined, false, new Error('no such kind')];
        mockWatches.UserDefinedNetwork = [undefined, false, new Error('no such kind')];
        mockWatches.NetworkAttachmentDefinition = [null, true, undefined];
        mockWatches.NodeNetworkConfigurationEnactment = [undefined, false, new Error('no such kind')];
        await render();
        expect(card().querySelector('[data-testid="findings-none"]')?.textContent).toBe('No findings.');
        expect(container.querySelectorAll('[data-testid^="overview-node-"]')).toHaveLength(10);
    });

    it('stays quiet about unmapped networks while NodeNetworkStates are loading', async () => {
        mockWatches.NodeNetworkState = [[], false, undefined];
        await render();
        expect(card().textContent).toContain('Loading...');
        expect(card().querySelector('[data-testid="count-warning"]')).toBeNull();
    });
});
