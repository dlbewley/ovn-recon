/**
 * SPIKE ovn-recon-s3t.10 -- @patternfly/react-topology evaluation.
 *
 * Q1 (kill criterion): can a custom layout reproduce the fixed vertical lanes?
 * Q2: can a group span lanes, as VRF containment requires?
 *
 * Headless: exercises Controller + model + a custom Layout. No DOM rendering.
 *
 * The decision (ADOPT) is recorded on the bead; this is kept as the reference
 * implementation for two findings that are easy to rediscover the hard way:
 * grouped children leave graph.getNodes() and must be reached by walking the
 * tree, and group membership is a tree so a node has at most one parent.
 * Retire it when ovn-recon-s3t.9 lands a real layout in src/.
 *
 * Excluded from `npm test`; run with:
 *   npx jest -c spike/react-topology/jest.config.js
 */
import {
    Visualization,
    Graph,
    Layout,
    Node,
    Model,
    ModelKind,
    NodeShape,
} from '@patternfly/react-topology';

// ---------------------------------------------------------------------------
// The lane arrangement we must preserve. Mirrors the current `columns` array
// in NodeVisualization.tsx, at full width (10 lanes).
// ---------------------------------------------------------------------------
const LANES = [
    'lldp', 'eth', 'bond', 'vlan', 'bridge',
    'logical', 'l3', 'networks', 'attachments', 'nads',
] as const;
type LaneId = typeof LANES[number];

const LANE_X = 220;      // colSpacing in the current implementation
const ROW_Y = 100;       // itemHeight + 20
const NODE_W = 160;
const NODE_H = 80;
const PAD = 20;

interface LaneData { lane: LaneId }

/**
 * Fixed-lane layout: X is dictated by lane membership, Y by barycenter
 * ordering within the lane. Implements the whole `Layout` interface, which
 * is only four methods.
 */
class LaneLayout implements Layout {
    constructor(private graph: Graph) {}

    layout(): void {
        // NOTE (spike finding): graph.getNodes() returns only TOP-LEVEL nodes.
        // Once a node has a parent group it disappears from that list, so a
        // lane layout must walk the tree to reach grouped members.
        const collectLeaves = (parents: Node[]): Node[] =>
            parents.flatMap((n) => (n.isGroup() ? collectLeaves(n.getNodes()) : [n]));
        const nodes = collectLeaves(this.graph.getNodes());

        // Bucket by lane, preserving the lane order.
        const byLane = new Map<LaneId, Node[]>();
        LANES.forEach((l) => byLane.set(l, []));
        nodes.forEach((n) => {
            const lane = (n.getData() as LaneData)?.lane;
            if (lane && byLane.has(lane)) byLane.get(lane)!.push(n);
        });

        // Assign positions: X from lane index, Y from order within lane.
        // (A real implementation would barycenter-sort here; ordering is
        // orthogonal to the question this spike is answering.)
        LANES.forEach((lane, laneIndex) => {
            byLane.get(lane)!.forEach((node, row) => {
                node.setDimensions({ width: NODE_W, height: NODE_H } as never);
                node.setPosition({
                    x: PAD + laneIndex * LANE_X,
                    y: PAD + row * ROW_Y,
                } as never);
            });
        });
    }

    stop(): void {}
    destroy(): void {}
}

const controllerWith = (model: Model): Visualization => {
    const vis = new Visualization();
    vis.registerLayoutFactory((_type: string, graph: Graph) => new LaneLayout(graph));
    vis.registerComponentFactory((_kind: ModelKind, _type: string) => undefined as never);
    vis.fromModel(model, false);
    return vis;
};

const node = (id: string, lane: LaneId, extra: Record<string, unknown> = {}) => ({
    id,
    type: 'node',
    width: NODE_W,
    height: NODE_H,
    shape: NodeShape.rect,
    data: { lane },
    ...extra,
});

describe('Q1: custom layout can reproduce fixed vertical lanes', () => {
    it('places every node at the X dictated by its lane', () => {
        const model: Model = {
            graph: { id: 'g', type: 'graph', layout: 'lane' },
            nodes: [
                node('iface:eno1', 'eth'),
                node('iface:eno2', 'eth'),
                node('iface:bond0', 'bond'),
                node('iface:br-ex', 'bridge'),
                node('ovn:physnet', 'l3'),
                node('cudn:blue', 'networks'),
                node('nad:ns/blue', 'nads'),
            ],
            edges: [
                { id: 'e1', type: 'edge', source: 'iface:eno1', target: 'iface:bond0' },
                { id: 'e2', type: 'edge', source: 'iface:eno2', target: 'iface:bond0' },
                { id: 'e3', type: 'edge', source: 'iface:bond0', target: 'iface:br-ex' },
            ],
        };

        const vis = controllerWith(model);
        vis.getGraph().layout();

        const xOf = (id: string) => vis.getNodeById(id)!.getPosition().x;
        const laneX = (l: LaneId) => PAD + LANES.indexOf(l) * LANE_X;

        expect(xOf('iface:eno1')).toBe(laneX('eth'));
        expect(xOf('iface:eno2')).toBe(laneX('eth'));
        expect(xOf('iface:bond0')).toBe(laneX('bond'));
        expect(xOf('iface:br-ex')).toBe(laneX('bridge'));
        expect(xOf('ovn:physnet')).toBe(laneX('l3'));
        expect(xOf('cudn:blue')).toBe(laneX('networks'));
        expect(xOf('nad:ns/blue')).toBe(laneX('nads'));
    });

    it('stacks nodes within a lane without overlap', () => {
        const model: Model = {
            graph: { id: 'g', type: 'graph', layout: 'lane' },
            nodes: [node('a', 'eth'), node('b', 'eth'), node('c', 'eth')],
            edges: [],
        };
        const vis = controllerWith(model);
        vis.getGraph().layout();

        const ys = ['a', 'b', 'c'].map((id) => vis.getNodeById(id)!.getPosition().y);
        expect(ys).toEqual([PAD, PAD + ROW_Y, PAD + 2 * ROW_Y]);
        expect(new Set(ys).size).toBe(3);
    });

    it('supports the full 10-lane arrangement', () => {
        const model: Model = {
            graph: { id: 'g', type: 'graph', layout: 'lane' },
            nodes: LANES.map((l) => node(`n:${l}`, l)),
            edges: [],
        };
        const vis = controllerWith(model);
        vis.getGraph().layout();

        LANES.forEach((l, i) => {
            expect(vis.getNodeById(`n:${l}`)!.getPosition().x).toBe(PAD + i * LANE_X);
        });
    });
});

describe('Q2: a group can span lanes', () => {
    it('derives group bounds from children positioned across different lanes', () => {
        // A VRF whose members live in the bridge lane and the l3 lane --
        // the exact shape VRF containment needs.
        const model: Model = {
            graph: { id: 'g', type: 'graph', layout: 'lane' },
            nodes: [
                node('iface:br-ex', 'bridge'),
                node('ovn:physnet', 'l3'),
                {
                    id: 'vrf:blue',
                    type: 'group',
                    group: true,
                    children: ['iface:br-ex', 'ovn:physnet'],
                    data: { lane: 'l3' },
                    style: { padding: 20 },
                },
            ],
            edges: [],
        };

        const vis = controllerWith(model);
        vis.getGraph().layout();

        const group = vis.getNodeById('vrf:blue')!;
        const bounds = group.getBounds();

        const bridgeX = PAD + LANES.indexOf('bridge') * LANE_X;
        const l3X = PAD + LANES.indexOf('l3') * LANE_X;

        // The group must enclose members sitting in two different lanes.
        expect(group.isGroup()).toBe(true);
        expect(bounds.x).toBeLessThanOrEqual(bridgeX);
        expect(bounds.x + bounds.width).toBeGreaterThanOrEqual(l3X + NODE_W);
        // ...and therefore be wider than a single lane.
        expect(bounds.width).toBeGreaterThan(LANE_X);
    });

    it('confirms the single-parent constraint (a node cannot be in two groups)', () => {
        const model: Model = {
            graph: { id: 'g', type: 'graph', layout: 'lane' },
            nodes: [
                node('iface:eno1', 'eth'),
                { id: 'grpA', type: 'group', group: true, children: ['iface:eno1'], data: { lane: 'eth' } },
                { id: 'grpB', type: 'group', group: true, children: ['iface:eno1'], data: { lane: 'eth' } },
            ],
            edges: [],
        };
        const vis = controllerWith(model);
        vis.getGraph().layout();

        const parent = vis.getNodeById('iface:eno1')!.getParent();
        // Whichever wins, it is exactly one -- membership is a tree, not a set.
        expect(['grpA', 'grpB']).toContain((parent as { getId(): string }).getId());
        const a = vis.getNodeById('grpA')!.getChildren().length;
        const b = vis.getNodeById('grpB')!.getChildren().length;
        expect(a + b).toBe(1);
    });
});
