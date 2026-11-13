import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import {
    ClusterUserDefinedNetwork, NetworkAttachmentDefinition, NodeNetworkConfigurationEnactment, NodeNetworkState
} from '../types';
import { createPhysicalEvaluator, PhysicalEvaluator } from '../insights/evaluate';
import { makeFinding, nodeRef } from '../insights/refs';
import { PHYSICAL_RULES } from '../insights/registry';
import type { PhysicalRule } from '../insights/types';
import { FindingsEvaluatorContext, HIDE_INFO_STORAGE_KEY } from '../insights/ui/useFindings';
import NodeVisualization from './NodeVisualization';
import { TestRouter } from './testRouter';
import { hasViewOption, toggleViewOption, viewOptionInput } from './viewToolbarTestUtils';

/**
 * Findings on the physical page (ovn-recon-7i6.1): the graph decorator, the drawer's
 * Findings section, the EVPN gate, the hide-info toggle, and a missing source.
 */

// What the NodeNetworkState list watch returns: [data, loaded, error].
let mockNnsList: [unknown, boolean, unknown] = [[], true, undefined];
jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    useK8sWatchResource: (resource: { groupVersionKind: { kind: string } }) =>
        (resource.groupVersionKind.kind === 'NodeNetworkState' ? mockNnsList : [[], true, undefined])
}));

const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

const withState = (nns: NodeNetworkState, name: string, state: string): NodeNetworkState => {
    const copy = JSON.parse(JSON.stringify(nns)) as NodeNetworkState;
    copy.status!.currentState!.interfaces.forEach((iface) => { if (iface.name === name) iface.state = state; });
    return copy;
};

const worker = {
    nns: fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json'),
    cudns: fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json'),
    enactments: fixture<NodeNetworkConfigurationEnactment[]>('nnce', 'primary-cudn-vrf.json')
};
const evpn = {
    nns: fixture<NodeNetworkState>('nns', 'evpn-vxlan.json'),
    cudns: fixture<ClusterUserDefinedNetwork[]>('cudn', 'evpn-vxlan.json'),
    nads: fixture<NetworkAttachmentDefinition[]>('nad', 'evpn-vxlan.json')
};

/** A test-only info rule: no info rule ships yet, so the toggle is covered with this. */
const testInfoRule: PhysicalRule = {
    id: 'test-dated-practice',
    severity: 'info',
    scope: 'node',
    domain: 'physical',
    title: 'Dated practice (test)',
    evaluate: ({ node }) => (node ? [makeFinding({
        ruleId: 'test-dated-practice',
        severity: 'info',
        subject: { kind: 'graph-node', node: 'worker-1', graphNodeId: 'iface:ens192' },
        scope: { node: 'worker-1' },
        summary: 'Interface ens192 on worker-1 follows a dated practice.',
        evidence: [],
        remedy: { text: 'Consider the current guidance.', target: nodeRef('worker-1') }
    })] : [])
};

describe('NodeVisualization findings', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        mockNnsList = [[], true, undefined];
        window.localStorage.clear();
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        jest.restoreAllMocks();
        window.localStorage.clear();
    });

    const render = (
        props: React.ComponentProps<typeof NodeVisualization>,
        { entry = '/ovn-recon/node-network-state/worker-1', evaluator }: { entry?: string; evaluator?: PhysicalEvaluator } = {}
    ) => {
        const page = (
            <TestRouter initialEntry={entry}>
                <NodeVisualization {...props} />
            </TestRouter>
        );
        act(() => {
            root.render(evaluator
                ? <FindingsEvaluatorContext.Provider value={evaluator}>{page}</FindingsEvaluatorContext.Provider>
                : page);
        });
    };

    const badges = () => Array.from(container.querySelectorAll('[data-testid="findings-badge"]'));
    const nodeByName = (prefix: string) => Array.from(container.querySelectorAll<SVGGElement>('g[role="button"]'))
        .find((g) => g.getAttribute('aria-label')?.startsWith(prefix));
    const drawerFindings = () => container.querySelector('[data-testid="drawer-findings"]');
    const nodeTransforms = () => Array.from(container.querySelectorAll('g[role="button"]'))
        .map((g) => `${g.getAttribute('aria-label')?.split(',')[0]}@${g.getAttribute('transform')}`);

    describe('with a firing finding (the uplink of a mapped bridge is down)', () => {
        const firing = { ...worker, nns: withState(worker.nns, 'ens224', 'down') };

        it('decorates that node with a warning count and says so in its accessible name', () => {
            render(firing);
            expect(badges()).toHaveLength(1);
            expect(badges()[0].getAttribute('data-severity')).toBe('warning');
            expect(badges()[0].getAttribute('aria-label')).toBe('1 warning');
            expect(nodeByName('ens224')?.getAttribute('aria-label')).toMatch(/, 1 warning$/);
            expect(nodeByName('ens224')?.contains(badges()[0])).toBe(true);
        });

        it('draws every node where it draws it without findings', () => {
            render(worker);
            const quiet = nodeTransforms();
            render(firing);
            expect(nodeTransforms()).toEqual(quiet);
        });

        it('opens on ?select= with the finding at the top of the Overview tab', () => {
            render(firing, { entry: '/ovn-recon/node-network-state/worker-1?select=iface:ens224' });
            const section = drawerFindings();
            expect(section).not.toBeNull();
            expect(section!.textContent).toContain('Interface ens224 on worker-1 is down.');
            // Evidence, with where each fact was read from.
            expect(section!.textContent).toContain('ens224 (ethernet) is in state down.');
            const provenance = section!.querySelector('[data-testid="finding-provenance"]');
            expect(provenance?.textContent).toContain('NodeNetworkState worker-1');
            expect(provenance?.textContent).toContain('status.currentState.interfaces[name=ens224].state');
            // The remedy links to the object to edit: no enactment claims ens224, so the node.
            const remedy = section!.querySelector('[data-testid="finding-remedy"] a');
            expect(remedy?.textContent).toBe('Edit Node worker-1');
            expect(remedy?.getAttribute('href')).toBe('/k8s/cluster/core~v1~Node/worker-1/yaml');
            // First thing in the tab.
            expect(section!.parentElement?.firstElementChild).toBe(section);
        });
    });

    describe('with no findings', () => {
        it('draws no badge and no Findings section', () => {
            render(worker, { entry: '/ovn-recon/node-network-state/worker-1?select=iface:ens224' });
            expect(badges()).toHaveLength(0);
            expect(container.querySelector('.pf-v6-c-drawer.pf-m-expanded')).not.toBeNull();
            expect(drawerFindings()).toBeNull();
            expect(hasViewOption(container, 'hide-info-findings-toggle')).toBe(false);
        });
    });

    describe('the EVPN gate (ovn-recon-7i6.2)', () => {
        it('shows nothing for the EVPN SVI that is down', () => {
            render(evpn, { entry: '/ovn-recon/node-network-state/worker-evpn?select=iface:svl2.9' });
            expect(badges()).toHaveLength(0);
            expect(drawerFindings()).toBeNull();
        });

        it('still shows an ordinary down port of the same VRF', () => {
            render({ ...evpn, nns: withState(evpn.nns, 'ovn-k8s-mp9', 'down') });
            // ovn-k8s-mp9 draws in the Logical Interfaces lane, hidden by default.
            toggleViewOption(container, 'show-hidden-columns-toggle');
            expect(badges()).toHaveLength(1);
            expect(nodeByName('ovn-k8s-mp9')?.getAttribute('aria-label')).toMatch(/, 1 warning$/);
            expect(nodeByName('svl2.9')?.getAttribute('aria-label')).not.toMatch(/warning/);
        });
    });

    describe('info findings and the hide toggle', () => {
        const evaluator = createPhysicalEvaluator({ rules: [...PHYSICAL_RULES, testInfoRule] });

        it('shows info by default, subdued, and hides it with the toggle, remembering the choice', () => {
            render(worker, { entry: '/ovn-recon/node-network-state/worker-1?select=iface:ens192', evaluator });
            expect(badges().map((badge) => badge.getAttribute('data-severity'))).toEqual(['info']);
            const entry = drawerFindings()!.querySelector('[data-testid="finding"]') as HTMLElement;
            expect(entry.getAttribute('data-severity')).toBe('info');
            expect(entry.style.color).toContain('--pf-t--global--text--color--subtle');

            const toggle = viewOptionInput(container, 'hide-info-findings-toggle');
            expect(toggle).not.toBeNull();
            act(() => toggle!.click());
            expect(badges()).toHaveLength(0);
            expect(drawerFindings()).toBeNull();
            expect(window.localStorage.getItem(HIDE_INFO_STORAGE_KEY)).toBe('true');
        });

        it('starts hidden when the choice was remembered', () => {
            window.localStorage.setItem(HIDE_INFO_STORAGE_KEY, 'true');
            render(worker, { evaluator });
            expect(badges()).toHaveLength(0);
            expect(viewOptionInput(container, 'hide-info-findings-toggle')?.checked).toBe(true);
        });

        it('still works for the page when storage refuses every read and write', () => {
            jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
            jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('SecurityError'); });
            render(worker, { evaluator });
            expect(badges()).toHaveLength(1);
            toggleViewOption(container, 'hide-info-findings-toggle');
            expect(badges()).toHaveLength(0);
        });
    });

    describe('a missing source', () => {
        const coverage = {
            nns: fixture<{ items: NodeNetworkState[] }>('nns', 'cluster-localnet-coverage.json').items,
            cudns: fixture<{ items: ClusterUserDefinedNetwork[] }>('cudn', 'cluster-localnet-coverage.json').items
        };
        const worker1 = coverage.nns.find((nns) => nns.metadata?.name === 'worker-1')!;

        it('shows a network mapped nowhere on its CUDN once every NodeNetworkState is loaded', () => {
            mockNnsList = [coverage.nns, true, undefined];
            render({ nns: worker1, cudns: coverage.cudns }, { entry: '/ovn-recon/node-network-state/worker-1?select=cudn:vlan-333' });
            expect(drawerFindings()?.textContent).toContain(
                'ClusterUserDefinedNetwork vlan-333 names physical network thirdmap, which no node maps to a bridge.');
        });

        it('renders the graph and reports nothing when the NodeNetworkState list failed to load', () => {
            mockNnsList = [undefined, false, new Error('forbidden')];
            render({ nns: worker1, cudns: coverage.cudns }, { entry: '/ovn-recon/node-network-state/worker-1?select=cudn:vlan-333' });
            expect(nodeByName('vlan-333')).toBeDefined();
            expect(badges()).toHaveLength(0);
            expect(drawerFindings()).toBeNull();
        });

        it('renders with no enactments, CUDNs, UDNs or NADs at all', () => {
            mockNnsList = [null, true, undefined];
            render({ nns: worker.nns });
            expect(container.querySelectorAll('g[role="button"]').length).toBeGreaterThan(0);
            expect(badges()).toHaveLength(0);
        });
    });
});
