import { computeNodeOrder, countCrossings, sortByRank, LayoutLane } from './nodeVisualizationLayout';
import { TopologyEdge } from './nodeVisualizationModel';

/** Ordering only reads source and target, so the tests supply just those. */
type Connection = Pick<TopologyEdge, 'source' | 'target'>;

/** Two NICs into a bond, up through a bridge to a localnet network and its attachment. */
const simpleLanes: LayoutLane[] = [
    { id: 'eth', nodeIds: ['eno1', 'eno2'] },
    { id: 'bond', nodeIds: ['bond0'] },
    { id: 'bridge', nodeIds: ['br-ex'] },
    { id: 'l3', nodeIds: ['ovn-physnet'] },
    { id: 'networks', nodeIds: ['cudn-a'] }
];

const simpleEdges: Connection[] = [
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
        const edges: Connection[] = [
            { source: 'a', target: 'y' },
            { source: 'b', target: 'x' }
        ];

        expect(countCrossings(lanes, edges, { a: 0, b: 1, x: 0, y: 1 })).toBe(1);
        // Swap the right-hand lane and the same edges no longer cross.
        expect(countCrossings(lanes, edges, { a: 0, b: 1, x: 1, y: 0 })).toBe(0);
    });

    it('ignores edges within a single lane, which carry no ordering information', () => {
        const lanes: LayoutLane[] = [{ id: 'only', nodeIds: ['a', 'b', 'c'] }];
        const edges: Connection[] = [{ source: 'a', target: 'c' }, { source: 'b', target: 'c' }];

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
        const edges: Connection[] = [
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
        const edges: Connection[] = [
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
        const edges: Connection[] = [{ source: 'eno1', target: 'bond0' }];

        const ranks = computeNodeOrder({ lanes, edges });

        expect(ranks.bond0).toBe(0);
        expect(ranks.orphan).toBe(1);
    });

    it('tolerates edges that reference nodes outside any lane', () => {
        const edges: Connection[] = [
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

describe('computeEdgeBow (ovn-recon-s3t.49)', () => {
    const { computeEdgeBow } = jest.requireActual('./nodeVisualizationLayout');
    const box = (x: number, y: number) => ({ x, y, width: 160, height: 80 });

    it('leaves a clear segment straight', () => {
        expect(computeEdgeBow({ x: 200, y: 60 }, { x: 480, y: 60 }, [box(240, 200)])).toBeNull();
        expect(computeEdgeBow({ x: 200, y: 60 }, { x: 480, y: 60 }, [])).toBeNull();
    });

    it('bows around a node sitting exactly on the sight-line', () => {
        // The cnv-2 case: parent-aligned VLAN at the same y as the parent's
        // lane-skipping edge to its bridge.
        const bow = computeEdgeBow({ x: 200, y: 320 }, { x: 480, y: 320 }, [box(240, 280)]);
        expect(bow).not.toBeNull();
        // The curve's control point pushes clear of the box plus margin.
        expect(Math.abs(bow!.controlY - 320)).toBeGreaterThan(50);
        expect(bow!.controlX).toBe(340);
    });

    it('bows toward the side needing the smaller deviation', () => {
        // Line crosses the box near its top edge: up is the short way out.
        const nearTop = computeEdgeBow({ x: 200, y: 290 }, { x: 480, y: 290 }, [box(240, 280)]);
        expect(nearTop!.controlY).toBeLessThan(290);
        // Near the bottom edge: down is shorter.
        const nearBottom = computeEdgeBow({ x: 200, y: 350 }, { x: 480, y: 350 }, [box(240, 280)]);
        expect(nearBottom!.controlY).toBeGreaterThan(350);
    });

    it('ignores obstacles outside the horizontal span, and backwards edges', () => {
        expect(computeEdgeBow({ x: 200, y: 60 }, { x: 480, y: 60 }, [box(500, 40)])).toBeNull();
        expect(computeEdgeBow({ x: 200, y: 60 }, { x: 480, y: 60 }, [box(0, 40)])).toBeNull();
        // The hidden-lane bridge-port edge runs right to left; it stays straight.
        expect(computeEdgeBow({ x: 480, y: 60 }, { x: 200, y: 60 }, [box(240, 40)])).toBeNull();
    });
});
