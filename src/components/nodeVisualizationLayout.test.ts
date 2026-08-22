import { computeNodeOrder, countCrossings, sortByRank, LayoutLane } from './nodeVisualizationLayout';
import { TopologyEdge } from './nodeVisualizationModel';

/** Two NICs into a bond, up through a bridge to a localnet network and its attachment. */
const simpleLanes: LayoutLane[] = [
    { id: 'eth', nodeIds: ['eno1', 'eno2'] },
    { id: 'bond', nodeIds: ['bond0'] },
    { id: 'bridge', nodeIds: ['br-ex'] },
    { id: 'l3', nodeIds: ['ovn-physnet'] },
    { id: 'networks', nodeIds: ['cudn-a'] }
];

const simpleEdges: TopologyEdge[] = [
    { source: 'eno1', target: 'bond0' },
    { source: 'eno2', target: 'bond0' },
    { source: 'bond0', target: 'br-ex' },
    { source: 'br-ex', target: 'ovn-physnet' },
    { source: 'ovn-physnet', target: 'cudn-a' }
];

describe('countCrossings', () => {
    it('counts a deliberate crossing between two lanes', () => {
        const lanes: LayoutLane[] = [
            { id: 'left', nodeIds: ['a', 'b'] },
            { id: 'right', nodeIds: ['x', 'y'] }
        ];
        const edges: TopologyEdge[] = [
            { source: 'a', target: 'y' },
            { source: 'b', target: 'x' }
        ];

        expect(countCrossings(lanes, edges, { a: 0, b: 1, x: 0, y: 1 })).toBe(1);
        // Swap the right-hand lane and the same edges no longer cross.
        expect(countCrossings(lanes, edges, { a: 0, b: 1, x: 1, y: 0 })).toBe(0);
    });

    it('ignores edges within a single lane, which carry no ordering information', () => {
        const lanes: LayoutLane[] = [{ id: 'only', nodeIds: ['a', 'b', 'c'] }];
        const edges: TopologyEdge[] = [{ source: 'a', target: 'c' }, { source: 'b', target: 'c' }];

        expect(countCrossings(lanes, edges, { a: 0, b: 1, c: 2 })).toBe(0);
    });
});

describe('computeNodeOrder', () => {
    it('assigns a contiguous rank per lane starting at 0', () => {
        const ranks = computeNodeOrder({ lanes: simpleLanes, edges: simpleEdges });

        expect(new Set([ranks.eno1, ranks.eno2])).toEqual(new Set([0, 1]));
        expect(ranks.bond0).toBe(0);
        expect(ranks['cudn-a']).toBe(0);
    });

    it('untangles a crossed topology', () => {
        // Deliberately adversarial: alphabetical seeding puts these in the crossing order.
        const lanes: LayoutLane[] = [
            { id: 'eth', nodeIds: ['eno1', 'eno2', 'eno3'] },
            { id: 'bond', nodeIds: ['bondA', 'bondB', 'bondC'] }
        ];
        const edges: TopologyEdge[] = [
            { source: 'eno1', target: 'bondC' },
            { source: 'eno2', target: 'bondB' },
            { source: 'eno3', target: 'bondA' }
        ];

        const seeded = { eno1: 0, eno2: 1, eno3: 2, bondA: 0, bondB: 1, bondC: 2 };
        expect(countCrossings(lanes, edges, seeded)).toBe(3);

        const ranks = computeNodeOrder({ lanes, edges });
        expect(countCrossings(lanes, edges, ranks)).toBe(0);
    });

    it('is deterministic for identical input', () => {
        const first = computeNodeOrder({ lanes: simpleLanes, edges: simpleEdges });
        const second = computeNodeOrder({ lanes: simpleLanes, edges: simpleEdges });

        expect(first).toEqual(second);
    });

    it('does not depend on the order resources arrived in', () => {
        // Watched resources arrive in arbitrary order; the rendered graph must not move
        // around because of it.
        const shuffled: LayoutLane[] = simpleLanes.map((lane) => ({
            id: lane.id,
            nodeIds: lane.nodeIds.slice().reverse()
        }));

        expect(computeNodeOrder({ lanes: shuffled, edges: simpleEdges }))
            .toEqual(computeNodeOrder({ lanes: simpleLanes, edges: simpleEdges }));
    });

    it('honours group rank ahead of barycenter, so lane sub-groups stay together', () => {
        // Replaces the old hardcoded `udn-` prefix penalty: the caller says CUDNs come
        // before UDNs, and the layout module stays ignorant of what those are.
        const lanes: LayoutLane[] = [
            { id: 'l3', nodeIds: ['ovn-physnet'] },
            { id: 'networks', nodeIds: ['cudn-a', 'udn-ns1-x'] }
        ];
        const edges: TopologyEdge[] = [
            // The edge pulls the UDN toward the top; group rank must still win.
            { source: 'ovn-physnet', target: 'udn-ns1-x' }
        ];

        const ranks = computeNodeOrder({ lanes, edges, groupRankById: { 'udn-ns1-x': 1 } });

        expect(ranks['cudn-a']).toBeLessThan(ranks['udn-ns1-x']);
    });

    it('keeps unanchored nodes in a stable position rather than floating them to the top', () => {
        const lanes: LayoutLane[] = [
            { id: 'eth', nodeIds: ['eno1'] },
            { id: 'bond', nodeIds: ['bond0', 'orphan'] }
        ];
        const edges: TopologyEdge[] = [{ source: 'eno1', target: 'bond0' }];

        const ranks = computeNodeOrder({ lanes, edges });

        expect(ranks.bond0).toBe(0);
        expect(ranks.orphan).toBe(1);
    });

    it('tolerates edges that reference nodes outside any lane', () => {
        const edges: TopologyEdge[] = [
            ...simpleEdges,
            { source: 'br-ex', target: 'not-rendered' }
        ];

        expect(() => computeNodeOrder({ lanes: simpleLanes, edges })).not.toThrow();
        expect(computeNodeOrder({ lanes: simpleLanes, edges })['not-rendered']).toBeUndefined();
    });
});

describe('sortByRank', () => {
    it('sorts rank 0 first, not last', () => {
        // Regression against the previous `|| 10000`, which read rank 0 as unranked and
        // sorted the top node to the bottom of its lane.
        const items = [{ id: 'unranked' }, { id: 'top' }, { id: 'middle' }];

        const sorted = sortByRank(items, (item) => item.id, { top: 0, middle: 1 });

        expect(sorted.map((item) => item.id)).toEqual(['top', 'middle', 'unranked']);
    });

    it('sorts by lexical id when rank is tied', () => {
        const items = [{ id: 'node-b' }, { id: 'node-a' }];

        const sorted = sortByRank(items, (item) => item.id, { 'node-a': 3, 'node-b': 3 });

        expect(sorted.map((item) => item.id)).toEqual(['node-a', 'node-b']);
    });
});
