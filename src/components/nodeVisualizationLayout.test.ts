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

describe('lane-skipping edges (ovn-recon-nt4.16)', () => {
    /**
     * The reported node: ens192 + ens224 -> bond0 -> bond0.1926 -> br-ex, and
     * ens161 + ens256 straight to br-vmdata. Alphabetical order interleaves the two
     * pairs, so ens161's edge to br-vmdata arcs over the bond and crosses its edges.
     */
    const lanes: LayoutLane[] = [
        { id: 'eth', nodeIds: ['ens161', 'ens192', 'ens224', 'ens256'] },
        { id: 'bond', nodeIds: ['bond0'] },
        { id: 'vlan', nodeIds: ['bond0.1926'] },
        { id: 'bridge', nodeIds: ['br-ex', 'br-vmdata'] }
    ];
    const edges: Connection[] = [
        { source: 'ens192', target: 'bond0' },
        { source: 'ens224', target: 'bond0' },
        { source: 'bond0', target: 'bond0.1926' },
        { source: 'bond0.1926', target: 'br-ex' },
        { source: 'ens161', target: 'br-vmdata' },
        { source: 'ens256', target: 'br-vmdata' }
    ];
    const alphabetical = {
        ens161: 0, ens192: 1, ens224: 2, ens256: 3, bond0: 0, 'bond0.1926': 0, 'br-ex': 0, 'br-vmdata': 1
    };

    it('counts a crossing between an edge that skips lanes and the adjacent-lane edges it passes', () => {
        const lanes2: LayoutLane[] = [
            { id: 'eth', nodeIds: ['a', 'b'] },
            { id: 'bond', nodeIds: ['bond'] },
            { id: 'bridge', nodeIds: ['x', 'y'] }
        ];
        const edges2: Connection[] = [
            { source: 'a', target: 'y' },       // skips the bond lane
            { source: 'b', target: 'bond' },
            { source: 'bond', target: 'x' }
        ];
        expect(countCrossings(lanes2, edges2, { a: 0, b: 1, bond: 0, x: 0, y: 1 })).toBe(1);
        expect(countCrossings(lanes2, edges2, { a: 1, b: 0, bond: 0, x: 0, y: 1 })).toBe(0);
    });

    it('scores the alphabetical order of the reported node as crossed', () => {
        expect(countCrossings(lanes, edges, alphabetical)).toBeGreaterThan(0);
    });

    it('orders the bond members together, with zero crossings', () => {
        const ranks = computeNodeOrder({ lanes, edges });
        const eth = ['ens161', 'ens192', 'ens224', 'ens256'].sort((a, b) => ranks[a] - ranks[b]);
        expect(eth).toEqual(['ens192', 'ens224', 'ens161', 'ens256']);
        expect(countCrossings(lanes, edges, ranks)).toBe(0);
    });

    it('keeps virtual nodes out of the result, with contiguous ranks per lane', () => {
        const ranks = computeNodeOrder({ lanes, edges });
        expect(Object.keys(ranks).sort()).toEqual(lanes.flatMap((lane) => lane.nodeIds).sort());
        expect(new Set(['ens161', 'ens192', 'ens224', 'ens256'].map((id) => ranks[id]))).toEqual(new Set([0, 1, 2, 3]));
    });

    it('keeps interfaces that wire alike in natural name order', () => {
        const natural: LayoutLane[] = [
            { id: 'eth', nodeIds: ['eth10', 'eth2', 'eth1'] },
            { id: 'bond', nodeIds: ['bond0'] }
        ];
        const toBond: Connection[] = ['eth1', 'eth2', 'eth10'].map((source) => ({ source, target: 'bond0' }));
        const ranks = computeNodeOrder({ lanes: natural, edges: toBond });
        expect(['eth10', 'eth2', 'eth1'].sort((a, b) => ranks[a] - ranks[b])).toEqual(['eth1', 'eth2', 'eth10']);
    });

    it('puts a NIC that fans out to several VFs below the bond members it would cross', () => {
        // The sriov fixture: one NIC with three VFs, two bonded NICs with a VF each.
        // By rank both orders are crossing-free; drawn, the three-VF fan from a NIC
        // above the bond members runs down past them and crosses their bond edges.
        const lanes: LayoutLane[] = [
            { id: 'eth', nodeIds: ['enp65s0f0', 'enp65s0f1', 'enp194s0f0np0', 'enp194s0f1np1'] },
            { id: 'vf', nodeIds: ['v4', 'v5', 'v6', 'v2a', 'v2b'] },
            { id: 'bond', nodeIds: ['bond0'] },
            { id: 'vlan', nodeIds: ['bond0.50'] },
            { id: 'bridge', nodeIds: ['br-ex', 'br-mirror', 'br-vmdata'] }
        ];
        const edges: Connection[] = [
            ['enp65s0f0', 'br-mirror'], ['enp65s0f1', 'v4'], ['enp65s0f1', 'v5'], ['enp65s0f1', 'v6'],
            ['enp194s0f0np0', 'v2a'], ['enp194s0f1np1', 'v2b'],
            ['enp194s0f0np0', 'bond0'], ['enp194s0f1np1', 'bond0'],
            ['bond0', 'bond0.50'], ['bond0.50', 'br-ex'], ['bond0', 'br-vmdata']
        ].map(([source, target]) => ({ source, target }));

        const fanAbove = {
            enp65s0f0: 0, enp65s0f1: 1, enp194s0f0np0: 2, enp194s0f1np1: 3,
            v4: 0, v5: 1, v6: 2, v2a: 3, v2b: 4, bond0: 0, 'bond0.50': 0, 'br-mirror': 0, 'br-ex': 1, 'br-vmdata': 2
        };
        expect(countCrossings(lanes, edges, fanAbove)).toBeGreaterThan(0);

        const ranks = computeNodeOrder({ lanes, edges });
        const eth = lanes[0].nodeIds.slice().sort((a, b) => ranks[a] - ranks[b]);
        expect(eth).toEqual(['enp65s0f0', 'enp194s0f0np0', 'enp194s0f1np1', 'enp65s0f1']);
        expect(countCrossings(lanes, edges, ranks)).toBe(0);
    });

    it('keeps group ranks when a long edge passes through a grouped lane', () => {
        // A long edge through the l3 lane must not split physical networks from VRFs.
        const grouped: LayoutLane[] = [
            { id: 'bridge', nodeIds: ['br-ex', 'br-vm'] },
            { id: 'l3', nodeIds: ['physnet', 'vrf-a'] },
            { id: 'networks', nodeIds: ['cudn-a', 'cudn-b'] }
        ];
        const groupedEdges: Connection[] = [
            { source: 'br-ex', target: 'physnet' },
            { source: 'br-vm', target: 'cudn-a' },
            { source: 'vrf-a', target: 'cudn-b' },
            { source: 'physnet', target: 'cudn-b' }
        ];
        const ranks = computeNodeOrder({ lanes: grouped, edges: groupedEdges, groupRankById: { 'vrf-a': 1 } });
        expect(ranks.physnet).toBeLessThan(ranks['vrf-a']);
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

    it('sorts by natural id order when rank is tied', () => {
        const items = [{ id: 'node-b' }, { id: 'node-a' }, { id: 'eth10' }, { id: 'eth2' }];

        const sorted = sortByRank(items, (item) => item.id, { 'node-a': 3, 'node-b': 3, eth10: 1, eth2: 1 });

        expect(sorted.map((item) => item.id)).toEqual(['eth2', 'eth10', 'node-a', 'node-b']);
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
