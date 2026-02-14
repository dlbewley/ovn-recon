import { LogicalTopologySnapshot } from '../types';

const baseMetadata = (nodeName: string): LogicalTopologySnapshot['metadata'] => ({
    schemaVersion: 'v1alpha1',
    generatedAt: '2026-01-01T00:00:00Z',
    sourceHealth: 'healthy',
    nodeName,
});

export const logicalTopologyFixtures: Record<string, LogicalTopologySnapshot> = {
    'worker-a': {
        metadata: baseMetadata('worker-a'),
        nodes: [
            { id: 'lr-cluster', kind: 'logical_router', label: 'cluster-router' },
            { id: 'ls-red', kind: 'logical_switch', label: 'red-net' },
            { id: 'lsp-red-a', kind: 'logical_switch_port', label: 'pod-a' },
        ],
        edges: [
            { id: 'e1', source: 'lr-cluster', target: 'ls-red', kind: 'router_to_switch' },
            { id: 'e2', source: 'ls-red', target: 'lsp-red-a', kind: 'switch_to_port' },
        ],
        groups: [{ id: 'g-red', label: 'Namespace red', nodeIds: ['ls-red', 'lsp-red-a'] }],
        warnings: [],
    },
    'worker-dense': {
        metadata: baseMetadata('worker-dense'),
        nodes: [
            { id: 'lr-core', kind: 'logical_router', label: 'core' },
            { id: 'ls-a', kind: 'logical_switch', label: 'net-a' },
            { id: 'ls-b', kind: 'logical_switch', label: 'net-b' },
            { id: 'ls-c', kind: 'logical_switch', label: 'net-c' },
            { id: 'lsp-a1', kind: 'logical_switch_port', label: 'a1' },
            { id: 'lsp-a2', kind: 'logical_switch_port', label: 'a2' },
            { id: 'lsp-b1', kind: 'logical_switch_port', label: 'b1' },
            { id: 'lsp-b2', kind: 'logical_switch_port', label: 'b2' },
            { id: 'lsp-c1', kind: 'logical_switch_port', label: 'c1' },
            { id: 'lsp-c2', kind: 'logical_switch_port', label: 'c2' },
        ],
        edges: [
            { id: 'e-a', source: 'lr-core', target: 'ls-a', kind: 'router_to_switch' },
            { id: 'e-b', source: 'lr-core', target: 'ls-b', kind: 'router_to_switch' },
            { id: 'e-c', source: 'lr-core', target: 'ls-c', kind: 'router_to_switch' },
            { id: 'e-a1', source: 'ls-a', target: 'lsp-a1', kind: 'switch_to_port' },
            { id: 'e-a2', source: 'ls-a', target: 'lsp-a2', kind: 'switch_to_port' },
            { id: 'e-b1', source: 'ls-b', target: 'lsp-b1', kind: 'switch_to_port' },
            { id: 'e-b2', source: 'ls-b', target: 'lsp-b2', kind: 'switch_to_port' },
            { id: 'e-c1', source: 'ls-c', target: 'lsp-c1', kind: 'switch_to_port' },
            { id: 'e-c2', source: 'ls-c', target: 'lsp-c2', kind: 'switch_to_port' },
        ],
        groups: [
            { id: 'g-a', label: 'A', nodeIds: ['ls-a', 'lsp-a1', 'lsp-a2'] },
            { id: 'g-b', label: 'B', nodeIds: ['ls-b', 'lsp-b1', 'lsp-b2'] },
            { id: 'g-c', label: 'C', nodeIds: ['ls-c', 'lsp-c1', 'lsp-c2'] },
        ],
        warnings: [],
    },
    'worker-parse-edge': {
        metadata: {
            schemaVersion: 'v1alpha1',
            generatedAt: '2026-01-01T00:15:00Z',
            sourceHealth: 'degraded',
            nodeName: 'worker-parse-edge',
        },
        nodes: [
            { id: 'lr-edge', kind: 'logical_router', label: 'edge-router' },
            { id: 'ls-edge', kind: 'logical_switch', label: 'edge-net' },
        ],
        edges: [
            {
                id: 'e-edge',
                source: 'lr-edge',
                target: 'ls-edge',
                kind: 'router_to_switch',
                data: {
                    rawFieldRecovered: true,
                    normalizationPath: 'single_quote_fix',
                },
            },
        ],
        groups: [],
        warnings: [
            {
                code: 'PARSER_NORMALIZED',
                message: 'Input required normalization due to inconsistent OVN command output',
            },
        ],
    },
};

export const getLogicalTopologyFixture = (nodeName: string): LogicalTopologySnapshot | undefined =>
    logicalTopologyFixtures[nodeName] || logicalTopologyFixtures['worker-a'];
