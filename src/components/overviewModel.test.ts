import fs from 'fs';
import path from 'path';

import { ClusterUserDefinedNetwork, NodeNetworkState } from '../types';
import {
    filterNodeSummaries,
    formatCudnBreakdown,
    nodeRole,
    summarizeFleet,
    summarizeNetworks,
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

    describe('summarizeNetworks', () => {
        it('counts each kind and breaks CUDNs down by topology', () => {
            const cudns = fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json');
            const summary = summarizeNetworks(cudns, [], [{} as never], [{} as never, {} as never]);
            expect(summary.cudns).toBe(cudns.length);
            expect(Object.values(summary.cudnsByTopology).reduce((a, b) => a + b, 0)).toBe(cudns.length);
            expect(summary.udns).toBe(0);
            expect(summary.nads).toBe(1);
            expect(summary.routeAdvertisements).toBe(2);
        });

        it('formats the breakdown largest first', () => {
            expect(formatCudnBreakdown({ Layer2: 1, Localnet: 3 })).toBe('3 Localnet, 1 Layer2');
            expect(formatCudnBreakdown({})).toBe('');
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
