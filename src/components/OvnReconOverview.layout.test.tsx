import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import {
    ClusterLogicalTopology,
    ClusterUserDefinedNetwork,
    LogicalTopologySnapshot,
    NetworkAttachmentDefinition,
    NodeNetworkState,
} from '../types';
import { CollectorState, OverviewBody, OverviewBodyProps } from './OvnReconOverview';
import { TestRouter } from './testRouter';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';

/**
 * The overview's layout (ovn-recon-nt4.9) and its networks table (ovn-recon-nfs.6),
 * drawn by the page body from data it is handed: the ten-node localnet-coverage
 * capture, with the collector answering and with it disabled.
 */

const items = <T,>(...segments: string[]): T[] => {
    const data = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8'),
    ) as T[] | { items: T[] };
    return Array.isArray(data) ? data : data.items;
};

// The body only draws; the SDK is needed for the document title alone.
jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    DocumentTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useK8sWatchResource: () => [[], true, undefined],
}));

const coverage = {
    nns: items<NodeNetworkState>('nns', 'cluster-localnet-coverage.json'),
    cudns: items<ClusterUserDefinedNetwork>('cudn', 'cluster-localnet-coverage.json'),
    nads: items<NetworkAttachmentDefinition>('nad', 'cluster-localnet-coverage.json'),
};

const snapshot = (): LogicalTopologySnapshot => ({
    ...(cnv1 as unknown as LogicalTopologySnapshot),
    metadata: { ...(cnv1 as unknown as LogicalTopologySnapshot).metadata, generatedAt: new Date().toISOString() },
});

const topology = (): ClusterLogicalTopology => ({
    metadata: { schemaVersion: '2', generatedAt: new Date().toISOString(), sourceHealth: 'healthy' },
    snapshots: [snapshot(), snapshot(), snapshot()],
    warnings: [],
});

const collectorOn = (): CollectorState => ({
    enabled: true, gateLoaded: true, topology: topology(), error: '', loading: false,
});
const collectorOff: CollectorState = {
    enabled: false, gateLoaded: true, topology: null, error: '', loading: false,
};

const props = (overrides: Partial<OverviewBodyProps> = {}): OverviewBodyProps => ({
    nodeNetworkStates: coverage.nns,
    nodeNetworkStatesLoaded: true,
    nodes: coverage.nns.map((nns) => ({
        metadata: {
            name: nns.metadata?.name,
            labels: { [`node-role.kubernetes.io/${nns.metadata?.name?.startsWith('control') ? 'control-plane' : 'worker'}`]: '' },
        },
    })),
    cudns: coverage.cudns,
    udns: [],
    nads: coverage.nads,
    routeAdvertisements: [],
    enactments: [],
    networksLoaded: true,
    collector: collectorOn(),
    ...overrides,
});

describe('OvnReconOverview layout', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        window.localStorage.clear();
        global.fetch = jest.fn() as unknown as typeof fetch;
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        jest.restoreAllMocks();
    });

    const render = async (bodyProps: OverviewBodyProps) => {
        await act(async () => {
            root.render(
                <TestRouter initialEntry="/ovn-recon">
                    <OverviewBody {...bodyProps} />
                </TestRouter>,
            );
        });
    };

    const gridItems = (): HTMLElement[] =>
        Array.from(container.querySelectorAll<HTMLElement>('[data-testid="overview-grid"] > .pf-v6-l-grid__item'));

    /** Columns a cell takes from the xl breakpoint; a cell with no xl span keeps its default. */
    const xlSpan = (item: HTMLElement): number => {
        const xl = Array.from(item.classList).map((name) => /^pf-m-(\d+)-col-on-xl$/.exec(name)).find(Boolean);
        const base = Array.from(item.classList).map((name) => /^pf-m-(\d+)-col$/.exec(name)).find(Boolean);
        return Number((xl ?? base)![1]);
    };

    /** What each cell holds, by the test id of its one child. */
    const cellIds = (): (string | null)[] =>
        gridItems().map((item) => item.querySelector('[data-testid]')?.getAttribute('data-testid') ?? null);

    const expectNoHoles = () => {
        const cells = gridItems();
        expect(cells.length).toBeGreaterThan(0);
        // Stacked on a narrow screen: every cell is the full width by default.
        cells.forEach((cell) => expect(cell.classList.contains('pf-m-12-col')).toBe(true));
        // Wide: each row's cells add up to exactly the twelve columns.
        let row = 0;
        cells.forEach((cell) => {
            row += xlSpan(cell);
            expect(row).toBeLessThanOrEqual(12);
            if (row === 12) row = 0;
        });
        expect(row).toBe(0);
        // And no cell is drawn empty.
        cells.forEach((cell) => expect((cell.textContent ?? '').trim()).not.toBe(''));
    };

    const ORDER = [
        'overview-search',
        'overview-findings-card',
        'overview-networks-card',
        'overview-nodes-card',
        'overview-collector-status',
    ];

    it('runs search, findings beside networks, nodes, then the collector line, filling every row', async () => {
        await render(props());

        expect(cellIds()).toEqual(ORDER);
        expect(gridItems().map(xlSpan)).toEqual([12, 4, 8, 12, 12]);
        expectNoHoles();

        const status = container.querySelector('[data-testid="overview-collector-status"]')!;
        expect(status.textContent).toContain('Assembled from 3 nodes');
        expect(status.querySelector('a[href="/ovn-recon/ovn"]')).not.toBeNull();
        // The collector is one line now, not a card among the others.
        expect(container.querySelector('[data-testid="overview-collector-card"]')).toBeNull();
        expect(container.querySelector('[data-testid="overview-physical-card"]')).toBeNull();
    });

    it('keeps every cell in place, with nothing empty, when the collector is disabled', async () => {
        await render(props({ collector: collectorOff }));

        expect(cellIds()).toEqual(ORDER);
        expect(gridItems().map(xlSpan)).toEqual([12, 4, 8, 12, 12]);
        expectNoHoles();

        const status = container.querySelector('[data-testid="overview-collector-status"]')!;
        expect(status.textContent).toContain('Collector not enabled');
        expect(container.querySelector('a[href^="/ovn-recon/ovn"]')).toBeNull();
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('fills every cell while nothing has loaded yet', async () => {
        await render(props({
            nodeNetworkStates: undefined,
            nodeNetworkStatesLoaded: false,
            nodes: [],
            cudns: [],
            nads: [],
            networksLoaded: false,
            collector: { enabled: false, gateLoaded: false, topology: null, error: '', loading: false },
        }));

        expect(cellIds()).toEqual(ORDER);
        expectNoHoles();
    });

    describe('networks table', () => {
        const networkRow = (name: string) => container.querySelector(`[data-testid="overview-network-cudn-${name}"]`)!;
        const cells = (name: string) => Array.from(networkRow(name).querySelectorAll('td')).map((td) => td.textContent);
        const rowNames = () => Array.from(container.querySelectorAll('[data-testid^="overview-network-cudn-"]'))
            .map((tr) => tr.querySelector('td')!.textContent);

        it('lists the localnet-coverage networks with the nodes each is wired on and its findings', async () => {
            await render(props());

            // Mapped on no node first: those are the ones with a warning.
            expect(rowNames()).toEqual(['vlan-333', 'vlan-333-again', 'vlan-999', 'machinenet', 'vlan-1924', 'vlan-1926']);
            expect(cells('machinenet')).toEqual(['machinenet', 'CUDN', 'Localnet', 'Secondary', '10 of 10', '']);
            expect(cells('vlan-1924').slice(0, 5)).toEqual(['vlan-1924', 'CUDN', 'Localnet', 'Secondary', '4 of 10']);
            expect(cells('vlan-333').slice(0, 5)).toEqual(['vlan-333', 'CUDN', 'Localnet', 'Secondary', '0 of 10']);

            // Each row opens its network page, from the name and from the findings count.
            expect(networkRow('vlan-1924').querySelector('a')!.getAttribute('href')).toBe('/ovn-recon/networks/cudn/vlan-1924');
            const findings = container.querySelector('[data-testid="overview-network-findings-cudn-vlan-333"] a')!;
            expect(findings.getAttribute('href')).toBe('/ovn-recon/networks/cudn/vlan-333');
            expect(findings.getAttribute('aria-label')).toBe('1 warning on vlan-333');
            expect(findings.querySelector('[data-testid="count-warning"]')!.textContent).toContain('1');

            const card = container.querySelector('[data-testid="overview-networks-card"]')!;
            expect(card.querySelector('a[href="/ovn-recon/networks"]')!.textContent).toBe('Networks');
            // Six networks fit: nothing is left out, so nothing points elsewhere for the rest.
            expect(container.querySelector('[data-testid="overview-networks-more"]')).toBeNull();
        });

        it('does not claim a network is wired nowhere while no node state is known', async () => {
            await render(props({
                nodeNetworkStates: undefined,
                nodeNetworkStatesLoaded: false,
                nodeNetworkStatesError: 'forbidden',
            }));

            expect(cells('machinenet')).toEqual(['machinenet', 'CUDN', 'Localnet', 'Secondary', '-', '']);
            expect(cells('vlan-333')[4]).toBe('-');
        });

        it('caps a long list and points at the networks page for the rest', async () => {
            const many = Array.from({ length: 12 }, (_unused, index): ClusterUserDefinedNetwork => ({
                ...coverage.cudns[0],
                metadata: { ...coverage.cudns[0].metadata, name: `net-${String(index).padStart(2, '0')}` },
            }));
            await render(props({ cudns: many, nads: [] }));

            expect(rowNames()).toHaveLength(10);
            const more = container.querySelector('[data-testid="overview-networks-more"]')!;
            expect(more.textContent).toContain('Showing 10 of 12 networks.');
            expect(more.querySelector('a')!.getAttribute('href')).toBe('/ovn-recon/networks');
        });

        it('says so when there are no networks, and when they are still loading', async () => {
            await render(props({ cudns: [], nads: [] }));
            expect(container.querySelector('[data-testid="overview-networks-card"]')!.textContent).toContain('No networks found.');

            await render(props({ cudns: [], nads: [], networksLoaded: false }));
            expect(container.querySelector('[data-testid="overview-networks-card"] tbody')!.textContent).toBe('Loading...');
        });
    });
});
