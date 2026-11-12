import fs from 'fs';
import path from 'path';

import { ClusterUserDefinedNetwork, NetworkAttachmentDefinition, NodeNetworkState } from '../types';
import { evaluatePhysical } from '../insights';
import { cudnRef, makeFinding, nodeRef } from '../insights/refs';
import {
    filterNodeSummaries,
    findingCountsByNode,
    groupFindingsByRule,
    nodeRole,
    overviewNetworkRows,
    snapshotAges,
    summarizeFleet,
    summarizeNode,
} from './overviewModel';

const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

const node = (name: string, labels: Record<string, string>) => ({ metadata: { name, labels } });

describe('overviewModel', () => {
    describe('summarizeNode', () => {
        it('counts interfaces, bridges, mappings and LLDP neighbors on a bonded host', () => {
            const summary = summarizeNode(fixture<NodeNetworkState>('nns', 'bonded-lldp.json'));
            expect(summary.name).toBe('worker-2.example.com');
            expect(summary.interfacesTotal).toBe(31);
            expect(summary.interfacesUp).toBe(13);
            expect(summary.bridgeMappings).toBe(28);
            expect(summary.lldpNeighbors).toBeGreaterThan(0);
            // br-int is on every node and is deliberately left out.
            expect(summary.bridges).not.toContain('br-int');
            expect(summary.bridges).toContain('br-ex');
        });

        it('summarizes a plain host with no LLDP', () => {
            const summary = summarizeNode(fixture<NodeNetworkState>('nns', 'basic-host.json'));
            expect(summary.interfacesTotal).toBe(4);
            expect(summary.interfacesUp).toBe(4);
            expect(summary.bridgeMappings).toBe(1);
            expect(summary.lldpNeighbors).toBe(0);
        });

        it('tolerates a NodeNetworkState with no status yet', () => {
            const summary = summarizeNode({ metadata: { name: 'new-node' } } as NodeNetworkState);
            expect(summary).toEqual({
                name: 'new-node',
                interfacesUp: 0,
                interfacesTotal: 0,
                bridges: [],
                bridgeMappings: 0,
                lldpNeighbors: 0,
            });
        });
    });

    describe('nodeRole', () => {
        it('reads the standard role labels', () => {
            expect(nodeRole(node('a', { 'node-role.kubernetes.io/worker': '' }))).toBe('worker');
            expect(nodeRole(node('b', { 'node-role.kubernetes.io/control-plane': '' }))).toBe('control plane');
            expect(nodeRole(node('c', { 'node-role.kubernetes.io/master': '' }))).toBe('control plane');
        });

        it('prefers control plane on a compact node that is also a worker', () => {
            expect(nodeRole(node('d', {
                'node-role.kubernetes.io/control-plane': '',
                'node-role.kubernetes.io/worker': '',
            }))).toBe('control plane');
        });

        it('falls back to a custom role, and to nothing without labels or a node', () => {
            expect(nodeRole(node('e', { 'node-role.kubernetes.io/infra': '' }))).toBe('infra');
            expect(nodeRole(node('f', {}))).toBe('');
            expect(nodeRole(undefined)).toBe('');
        });
    });

    describe('summarizeFleet and filtering', () => {
        const summaries = [
            summarizeNode(fixture<NodeNetworkState>('nns', 'bonded-lldp.json')),
            summarizeNode(fixture<NodeNetworkState>('nns', 'basic-host.json')),
        ];

        it('totals mappings, counts distinct bridges, and counts LLDP-reporting nodes', () => {
            const fleet = summarizeFleet(summaries);
            expect(fleet.nodes).toBe(2);
            expect(fleet.bridgeMappings).toBe(29);
            expect(fleet.bridges).toBe(new Set(summaries.flatMap((s) => s.bridges)).size);
            expect(fleet.nodesWithLldp).toBe(1);
        });

        it('filters by name, case-insensitively, and keeps everything on an empty query', () => {
            expect(filterNodeSummaries(summaries, 'EXAMPLE').map((s) => s.name)).toEqual(['worker-2.example.com']);
            expect(filterNodeSummaries(summaries, '  ')).toHaveLength(2);
            expect(filterNodeSummaries(summaries, 'nope')).toHaveLength(0);
        });
    });
});

describe('findings helpers (ovn-recon-7i6.1)', () => {
    const make = (ruleId: string, severity: 'warning' | 'info', node?: string) => makeFinding({
        ruleId, severity,
        subject: node
            ? { kind: 'graph-node', node, graphNodeId: `iface:${ruleId}` }
            : { kind: 'k8s', ref: cudnRef(`net-${ruleId}`) },
        scope: node ? { node } : { network: cudnRef(`net-${ruleId}`) },
        summary: `${ruleId} ${node ?? 'net'}`, evidence: [], remedy: { text: '', target: nodeRef('x') }
    });

    it('counts per node, leaving network-wide findings out', () => {
        const counts = findingCountsByNode([make('a', 'warning', 'n1'), make('b', 'info', 'n1'), make('c', 'warning')]);
        expect(Array.from(counts.entries())).toEqual([['n1', { warning: 1, info: 1, total: 2 }]]);
    });

    it('groups by rule, rules with warnings first, and links each entry to its subject', () => {
        const groups = groupFindingsByRule(
            [make('zeta', 'info', 'n2'), make('alpha', 'info', 'n1'), make('mid', 'warning')],
            ['n2', 'n1'],
            (ruleId) => ruleId.toUpperCase()
        );
        expect(groups.map((g) => [g.title, g.severity])).toEqual([['MID', 'warning'], ['ALPHA', 'info'], ['ZETA', 'info']]);
        expect(groups[0].entries[0]).toEqual(expect.objectContaining({
            where: 'network-wide',
            link: expect.objectContaining({
                to: '/ovn-recon/networks/cudn/net-mid',
                secondary: expect.objectContaining({ to: '/ovn-recon/node-network-state/n1?select=cudn:net-mid' })
            })
        }));
        expect(groups[1].entries[0].where).toBe('on n1');
    });
});

describe('overviewNetworkRows (ovn-recon-nfs.6)', () => {
    const items = <T,>(...segments: string[]): T[] => {
        const data = fixture<T[] | { items: T[] }>(...segments);
        return Array.isArray(data) ? data : data.items;
    };
    // The ten-node capture: thirdmap and secondmap are mapped on no node.
    const nns = items<NodeNetworkState>('nns', 'cluster-localnet-coverage.json');
    const cudns = items<ClusterUserDefinedNetwork>('cudn', 'cluster-localnet-coverage.json');
    const nads = items<NetworkAttachmentDefinition>('nad', 'cluster-localnet-coverage.json');
    const inputs = { cudns, udns: [], nads, routeAdvertisements: [] };
    const findings = evaluatePhysical.network({ cudns, udns: [], nads, nodeNetworkStates: nns });

    it('gives each network its page, the nodes it is wired on and its findings', () => {
        const rows = overviewNetworkRows(inputs, nns, findings);
        // The NADs here are all copies a CUDN generated, so they are not rows of their own.
        expect(rows.map((row) => row.record.kind)).toEqual(Array(6).fill('cudn'));
        const byName = new Map(rows.map((row) => [row.record.name, row]));
        expect(byName.get('machinenet')).toMatchObject({
            path: '/ovn-recon/networks/cudn/machinenet',
            wired: { wired: 10, total: 10 },
            notCreated: false,
            findings: { warning: 0, info: 0, total: 0 },
        });
        expect(byName.get('vlan-1924')!.wired).toEqual({ wired: 4, total: 10 });
        expect(byName.get('vlan-999')).toMatchObject({
            wired: { wired: 0, total: 10 },
            findings: { warning: 1, info: 0, total: 1 },
        });
    });

    it('puts networks with warnings first, then info, keeping the list order within each', () => {
        const info = makeFinding({
            ruleId: 'test-info', severity: 'info',
            subject: { kind: 'k8s', ref: cudnRef('vlan-1926') },
            scope: { network: cudnRef('vlan-1926') },
            summary: 'An info finding.', evidence: [], remedy: { text: '', target: cudnRef('vlan-1926') }
        });
        expect(overviewNetworkRows(inputs, nns, [...findings, info]).map((row) => row.record.name))
            .toEqual(['vlan-333', 'vlan-333-again', 'vlan-999', 'vlan-1926', 'machinenet', 'vlan-1924']);
        expect(overviewNetworkRows(inputs, nns, []).map((row) => row.record.name))
            .toEqual(['machinenet', 'vlan-1924', 'vlan-1926', 'vlan-333', 'vlan-333-again', 'vlan-999']);
    });

    it('leaves the nodes unknown, rather than zero, without NodeNetworkStates', () => {
        overviewNetworkRows(inputs, undefined, findings).forEach((row) => expect(row.wired).toBeUndefined());
        overviewNetworkRows(inputs, [], findings).forEach((row) => expect(row.wired).toBeUndefined());
    });

    it('flags a network whose NetworkCreated condition is False', () => {
        const failed: ClusterUserDefinedNetwork = {
            ...cudns[0],
            status: { conditions: [{ type: 'NetworkCreated', status: 'False', reason: 'NetworkAttachmentDefinitionSyncError' }] },
        };
        const rows = overviewNetworkRows({ ...inputs, cudns: [failed, ...cudns.slice(1)] }, nns, []);
        expect(rows.filter((row) => row.notCreated).map((row) => row.record.name)).toEqual([failed.metadata!.name]);
    });
});

describe('snapshotAges (ovn-recon-nt4.9)', () => {
    it('reads the oldest and newest snapshot, skipping missing and unparseable times', () => {
        const now = Date.now();
        const ages = snapshotAges([
            new Date(now - 90000).toISOString(),
            undefined,
            'not a time',
            new Date(now - 5000).toISOString(),
        ]);
        expect(ages.oldestMs).toBeGreaterThanOrEqual(90000);
        expect(ages.oldestMs).toBeLessThan(95000);
        expect(ages.newestMs).toBeGreaterThanOrEqual(5000);
        expect(ages.newestMs).toBeLessThan(10000);
    });

    it('knows nothing without a usable time', () => {
        expect(snapshotAges([])).toEqual({ oldestMs: null, newestMs: null });
        expect(snapshotAges([undefined, 'nope'])).toEqual({ oldestMs: null, newestMs: null });
    });
});
