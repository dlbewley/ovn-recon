import {
    filterLogicalEdges,
    filterLogicalNodes,
    freshnessFromAge,
    layoutLogicalNodes,
    logicalNodeKinds,
    parseSnapshotAgeMs,
} from './logicalTopologyModel';
import { logicalTopologyFixtures } from './logicalTopologyFixtures';

describe('logicalTopologyModel', () => {
    it('filters nodes and edges consistently for dense fixtures', () => {
        const snapshot = logicalTopologyFixtures['worker-dense'];
        const nodes = filterLogicalNodes(snapshot, 'a1', 'logical_switch_port');
        const visibleIds = new Set(nodes.map((node) => node.id));
        const edges = filterLogicalEdges(snapshot, visibleIds);

        expect(nodes.map((node) => node.id)).toEqual(['lsp-a1']);
        expect(edges).toHaveLength(0);
    });

    it('wraps dense layouts into sub-columns while keeping unique coordinates', () => {
        const densePortNodes = Array.from({ length: 24 }, (_, idx) => ({
            id: `port-${String(idx).padStart(2, '0')}`,
            kind: 'logical_switch_port',
            label: `port-${String(idx).padStart(2, '0')}`,
        }));

        const layout = layoutLogicalNodes(densePortNodes);

        expect(layout['port-00']).toEqual({ x: 160, y: 120 });
        expect(layout['port-12']).toEqual({ x: 340, y: 120 });
        expect(layout['port-23']).toEqual({ x: 340, y: 1330 });

        const uniqueLocations = new Set(Object.values(layout).map((point) => `${point.x}:${point.y}`));
        expect(uniqueLocations.size).toBe(densePortNodes.length);
    });

    it('returns sorted unique kinds', () => {
        const snapshot = logicalTopologyFixtures['worker-dense'];
        expect(logicalNodeKinds(snapshot)).toEqual(['logical_router', 'logical_switch', 'logical_switch_port']);
    });

    it('computes freshness buckets from snapshot age', () => {
        expect(freshnessFromAge(null)).toBe('unknown');
        expect(freshnessFromAge(60 * 1000)).toBe('fresh');
        expect(freshnessFromAge(3 * 60 * 1000)).toBe('warning');
        expect(freshnessFromAge(12 * 60 * 1000)).toBe('critical');
    });

    it('parses generated timestamp age when valid', () => {
        const now = Date.now();
        const generated = new Date(now - 90 * 1000).toISOString();
        const ageMs = parseSnapshotAgeMs(generated);

        expect(ageMs).not.toBeNull();
        expect(ageMs as number).toBeGreaterThanOrEqual(89 * 1000);
        expect(ageMs as number).toBeLessThanOrEqual(91 * 1000);
    });
});
