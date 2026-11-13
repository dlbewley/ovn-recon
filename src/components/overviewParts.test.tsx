import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import type { SeverityCounts } from '../insights/selectors';
import { ClusterLogicalTopology, LogicalTopologySnapshot } from '../types';
import CollectorStatus, { CollectorState, useCollectorState } from './CollectorStatus';
import NetworksTable from './NetworksTable';
import NodesTable, { NodesTableProps } from './NodesTable';
import { NodeSummary, OverviewNetworkRow } from './overviewModel';
import { TestRouter } from './testRouter';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';

/**
 * The overview's nodes table, networks table and collector line as components of
 * their own (ovn-recon-gbr.3): each draws from its props with no overview page, card
 * or title around it. What they show inside the overview is held by the overview's
 * own suites, which this change left as they were.
 */

// jest.mock factories may only close over identifiers prefixed `mock`.
const mockGate = { enabled: true, loaded: true };

jest.mock('./useOvnCollectorFeatureGate', () => ({
    useOvnCollectorFeatureGate: () => ({ ...mockGate }),
}));

const counts = (overrides: Partial<SeverityCounts>): SeverityCounts => ({
    warning: 0, info: 0, total: 0, ...overrides,
} as SeverityCounts);

const summary = (name: string, overrides: Partial<NodeSummary> = {}): NodeSummary => ({
    name,
    interfacesUp: 3,
    interfacesTotal: 5,
    bridges: ['br-ex'],
    bridgeMappings: 1,
    lldpNeighbors: 0,
    ...overrides,
});

const networkRow = (name: string, overrides: Partial<OverviewNetworkRow> = {}): OverviewNetworkRow => ({
    key: `cudn//${name}`,
    record: { kind: 'cudn', name, topology: 'Localnet', role: 'Secondary' } as OverviewNetworkRow['record'],
    path: `/ovn-recon/networks/cudn/${name}`,
    wired: { wired: 2, total: 3 },
    notCreated: false,
    findings: counts({}),
    ...overrides,
});

const topology = (warnings: ClusterLogicalTopology['warnings'] = []): ClusterLogicalTopology => {
    const snapshot: LogicalTopologySnapshot = {
        ...(cnv1 as unknown as LogicalTopologySnapshot),
        metadata: { ...(cnv1 as unknown as LogicalTopologySnapshot).metadata, generatedAt: new Date().toISOString() },
    };
    return {
        metadata: { schemaVersion: '2', generatedAt: new Date().toISOString(), sourceHealth: 'healthy' },
        snapshots: [snapshot, snapshot],
        warnings,
    };
};

const collectorState = (overrides: Partial<CollectorState> = {}): CollectorState => ({
    enabled: true, gateLoaded: true, topology: topology(), error: '', loading: false, ...overrides,
});

describe('the overview\'s parts on their own (ovn-recon-gbr.3)', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        mockGate.enabled = true;
        mockGate.loaded = true;
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        jest.restoreAllMocks();
    });

    const render = async (element: React.ReactElement) => {
        await act(async () => {
            root.render(<TestRouter initialEntry="/a/host/page">{element}</TestRouter>);
        });
    };

    const expectNoCardOrTitle = () => {
        expect(container.querySelector('.pf-v6-c-card')).toBeNull();
        expect(container.querySelector('h1')).toBeNull();
        expect(container.querySelector('nav[aria-label="Breadcrumb"]')).toBeNull();
    };

    describe('NodesTable', () => {
        const nodesProps = (overrides: Partial<NodesTableProps> = {}): NodesTableProps => ({
            summaries: [
                summary('control-0', { bridges: ['br-ex', 'br-vmdata'], bridgeMappings: 2, lldpNeighbors: 2 }),
                summary('worker-0'),
                summary('worker-1'),
            ],
            roles: new Map([['control-0', 'control plane'], ['worker-0', 'worker']]),
            findingCounts: new Map([['worker-0', counts({ warning: 2, total: 2 })]]),
            loaded: true,
            showLogical: true,
            ...overrides,
        });

        const rowNames = () => Array.from(container.querySelectorAll('[data-testid^="overview-node-"]'))
            .map((row) => row.querySelector('td')!.textContent);
        const cells = (name: string) =>
            Array.from(container.querySelectorAll(`[data-testid="overview-node-${name}"] td`)).map((td) => td.textContent);
        const filter = () => container.querySelector<HTMLInputElement>('input[aria-label="Filter nodes by name"]')!;
        const type = async (value: string) => {
            await act(async () => {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                setter?.call(filter(), value);
                filter().dispatchEvent(new Event('input', { bubbles: true }));
            });
        };

        it('draws its toolbar and one row per node, with no card or title around it', async () => {
            await render(<NodesTable {...nodesProps()} />);

            expectNoCardOrTitle();
            expect(rowNames()).toEqual(['control-0', 'worker-0', 'worker-1']);
            expect(cells('control-0')).toEqual([
                'control-0', 'control plane', '', '3 up / 5', 'br-ex, br-vmdata', '2', '2', 'Physical · Logical · NNS',
            ]);
            // A node the Node list does not name has no role, not a wrong one.
            expect(cells('worker-1')[1]).toBe('');
            expect(container.textContent).toContain('3 nodes with NodeNetworkState');
            expect(container.querySelector('[data-testid="overview-fleet-summary"]')!.textContent)
                .toBe('4 bridge mappings across 2 bridges · 1 node reports LLDP neighbors');
        });

        it('links each node to its views, and its findings count to the node page', async () => {
            await render(<NodesTable {...nodesProps()} />);

            const row = container.querySelector('[data-testid="overview-node-worker-0"]')!;
            expect(Array.from(row.querySelectorAll('td:last-child a')).map((anchor) => anchor.getAttribute('href'))).toEqual([
                '/ovn-recon/node-network-state/worker-0',
                '/ovn-recon/ovn/worker-0',
                '/k8s/cluster/nmstate.io~v1beta1~NodeNetworkState/worker-0',
            ]);
            const findings = container.querySelector('[data-testid="overview-findings-worker-0"] a')!;
            expect(findings.getAttribute('href')).toBe('/ovn-recon/node-network-state/worker-0');
            expect(findings.getAttribute('aria-label')).toBe('2 warnings on worker-0');
            expect(container.querySelector('[data-testid="overview-findings-worker-1"] a')).toBeNull();
        });

        it('offers no logical view while the collector is off', async () => {
            await render(<NodesTable {...nodesProps({ showLogical: false })} />);
            expect(cells('worker-0')[7]).toBe('Physical · NNS');
        });

        it('narrows the rows by name with its own filter', async () => {
            await render(<NodesTable {...nodesProps()} />);

            await type('WORK');
            expect(rowNames()).toEqual(['worker-0', 'worker-1']);
            expect(container.textContent).toContain('2 of 3 nodes with NodeNetworkState');

            await type('nope');
            expect(rowNames()).toEqual([]);
            expect(container.querySelector('tbody')!.textContent).toBe('No nodes match.');
        });

        it('says what it is waiting for, what failed, and when there is nothing', async () => {
            await render(<NodesTable {...nodesProps({ loaded: false })} />);
            expect(container.querySelector('tbody')!.textContent).toBe('Loading...');

            await render(<NodesTable {...nodesProps({ summaries: [], loaded: false, error: 'forbidden' })} />);
            expect(container.querySelector('tbody')!.textContent).toBe('Error loading NodeNetworkStates: forbidden');

            await render(<NodesTable {...nodesProps({ summaries: [] })} />);
            expect(container.querySelector('tbody')!.textContent).toBe('No NodeNetworkState resources found.');
        });
    });

    describe('NetworksTable', () => {
        const rowNames = () => Array.from(container.querySelectorAll('[data-testid^="overview-network-cudn-"]'))
            .map((row) => row.querySelector('td')!.textContent);

        it('draws the rows it is handed, with no card or title around it', async () => {
            const rows = [
                networkRow('vlan-10', { findings: counts({ warning: 1, total: 1 }) }),
                networkRow('vlan-20', { wired: undefined }),
            ];
            await render(<NetworksTable rows={rows} loaded />);

            expectNoCardOrTitle();
            expect(rowNames()).toEqual(['vlan-10', 'vlan-20']);
            const cells = (name: string) =>
                Array.from(container.querySelectorAll(`[data-testid="overview-network-cudn-${name}"] td`)).map((td) => td.textContent);
            expect(cells('vlan-10').slice(0, 5)).toEqual(['vlan-10', 'CUDN', 'Localnet', 'Secondary', '2 of 3']);
            expect(cells('vlan-20')).toEqual(['vlan-20', 'CUDN', 'Localnet', 'Secondary', '-', '']);
            const findings = container.querySelector('[data-testid="overview-network-findings-cudn-vlan-10"] a')!;
            expect(findings.getAttribute('href')).toBe('/ovn-recon/networks/cudn/vlan-10');
            expect(findings.getAttribute('aria-label')).toBe('1 warning on vlan-10');
        });

        it('does not cap the list: that is the host\'s choice', async () => {
            const rows = Array.from({ length: 14 }, (_unused, index) => networkRow(`net-${String(index).padStart(2, '0')}`));
            await render(<NetworksTable rows={rows} loaded />);
            expect(rowNames()).toHaveLength(14);
        });

        it('marks a network that was not created', async () => {
            await render(<NetworksTable rows={[networkRow('vlan-10', { notCreated: true })]} loaded />);
            expect(container.querySelector('[data-testid="overview-network-not-created"]')!.textContent).toBe('Not created');
        });

        it('says when it is loading and when there are no networks', async () => {
            await render(<NetworksTable rows={[networkRow('vlan-10')]} loaded={false} />);
            expect(container.querySelector('tbody')!.textContent).toBe('Loading...');

            await render(<NetworksTable rows={[]} loaded />);
            expect(container.querySelector('tbody')!.textContent).toBe('No networks found.');
        });
    });

    describe('CollectorStatus', () => {
        const buttonTexts = () => Array.from(container.querySelectorAll('button')).map((button) => button.textContent);
        const openDetails = async (): Promise<string> => {
            const button = Array.from(container.querySelectorAll('button'))
                .find((candidate) => candidate.textContent === 'Collector details')!;
            await act(async () => {
                button.click();
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
            // PatternFly mounts the popover in document.body.
            return document.querySelector('[data-testid="overview-collector-details"]')?.textContent ?? '';
        };

        it('is one line with its details popover, and nothing of the overview around it', async () => {
            await render(<CollectorStatus collector={collectorState()} />);

            expectNoCardOrTitle();
            expect(container.textContent).toContain('Assembled from 2 nodes');
            expect(container.textContent).not.toContain('Cluster logical topology');
            expect(container.querySelector('a')).toBeNull();
            expect(buttonTexts()).toEqual(['Collector details']);

            const details = await openDetails();
            expect(details).toContain('Node databases2');
            expect(details).toContain('Refreshedevery 60 seconds');
        });

        it('puts a host\'s label first and its action last', async () => {
            await render(
                <CollectorStatus
                    collector={collectorState()}
                    label={<strong data-testid="host-label">Collector</strong>}
                    action={<a href="/somewhere" data-testid="host-action">Open</a>}
                />,
            );

            const items = Array.from(container.querySelectorAll('.pf-v6-l-flex')[0].children);
            expect(items[0].querySelector('[data-testid="host-label"]')).not.toBeNull();
            expect(items[items.length - 1].querySelector('[data-testid="host-action"]')).not.toBeNull();
            expect(container.textContent).toContain('Assembled from 2 nodes');
        });

        it('says when the gate is unknown, the collector is off, or it does not answer', async () => {
            await render(<CollectorStatus collector={collectorState({ gateLoaded: false, enabled: false, topology: null })} />);
            expect(container.textContent).toBe('Loading...');
            expect(buttonTexts()).toEqual([]);

            await render(<CollectorStatus collector={collectorState({ enabled: false, topology: null })} />);
            expect(container.textContent).toContain('Collector not enabled');
            expect(await openDetails()).toContain('spec.collector.enabled');
        });

        it('names an unreachable collector and counts its warnings', async () => {
            await render(<CollectorStatus collector={collectorState({ topology: null, error: 'HTTP 503' })} />);
            expect(container.textContent).toContain('Collector unreachable');

            await render(
                <CollectorStatus
                    collector={collectorState({ topology: topology([{ code: 'A', message: 'one' }, { code: 'B', message: 'two' }]) })}
                />,
            );
            expect(container.textContent).toContain('2 collector warnings');
        });
    });

    describe('useCollectorState', () => {
        const Probe: React.FC<{ onState: (state: CollectorState) => void }> = ({ onState }) => {
            const state = useCollectorState();
            onState(state);
            return null;
        };

        const settle = async () => {
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
        };

        it('asks the collector for its aggregate while the gate is on', async () => {
            const payload = topology();
            global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => payload }) as unknown as typeof fetch;
            const states: CollectorState[] = [];

            await render(<Probe onState={(state) => states.push(state)} />);
            await settle();

            const last = states[states.length - 1];
            expect(last).toMatchObject({ enabled: true, gateLoaded: true, error: '', loading: false });
            expect(last.topology).toBe(payload);
        });

        it('never asks a disabled collector', async () => {
            mockGate.enabled = false;
            global.fetch = jest.fn() as unknown as typeof fetch;
            const states: CollectorState[] = [];

            await render(<Probe onState={(state) => states.push(state)} />);
            await settle();

            expect(global.fetch).not.toHaveBeenCalled();
            expect(states[states.length - 1]).toMatchObject({ enabled: false, gateLoaded: true, topology: null });
        });
    });
});
