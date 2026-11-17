import { TopologyEdge } from './nodeVisualizationModel';

/**
 * Ordering only needs to know WHICH nodes are connected, not what the connection means.
 * Taking the narrow shape keeps edge kinds out of the layout entirely.
 */
type Connection = Pick<TopologyEdge, 'source' | 'target'>;

/**
 * Node ordering for the fixed-lane topology graph.
 *
 * Lane membership (which column a node sits in) is decided by node type, not here.
 * The only open question is the order of nodes *within* a lane, and the goal is to
 * minimise edge crossings. That is the standard layered-graph problem, solved with
 * the barycenter heuristic: a node wants to sit level with the average position of
 * the nodes it connects to in neighbouring lanes. Sweeping left-to-right then
 * right-to-left and keeping the best result converges quickly and is deterministic.
 *
 * Replaces an earlier "gravity" scheme that scored nodes with tiered magic constants
 * and hardcoded both a node name (br-ex) and an id prefix (udn-). Product ordering
 * preferences now travel as `groupRankById` instead, so this module stays ignorant
 * of what any particular node means.
 */

/** Sweeps of the barycenter heuristic. Converges well before this on real topologies. */
const DEFAULT_ITERATIONS = 8;

/**
 * Passes of the move-and-resort refinement after the sweeps; most graphs stop
 * improving after one.
 */
const REFINE_PASSES = 3;

/**
 * Candidate orders the refinement may score in all, so a node with dozens of
 * physical networks costs bounded time. Each costs a re-sort and a crossing count.
 */
const REFINE_BUDGET = 400;

/** Rank given to nodes with no lane assignment, sorting them after ranked nodes. */
const UNRANKED = Number.MAX_SAFE_INTEGER;

export interface LayoutLane {
    /** Stable lane key, e.g. 'eth'. Only used for diagnostics. */
    id: string;
    /** Node ids in this lane. Order is a starting point, not a constraint. */
    nodeIds: string[];
}

export interface ComputeNodeOrderParams {
    /** Lanes in left-to-right render order. */
    lanes: LayoutLane[];
    edges: Connection[];
    /**
     * Optional hard grouping within a lane. Nodes sort by group rank first and
     * barycenter second, so a lane can hold ordered sub-groups (bridge mappings
     * above VRFs, CUDNs above UDNs) without this module knowing why.
     */
    groupRankById?: Record<string, number>;
    iterations?: number;
}

type LaneOrder = string[][];

const buildLaneIndex = (lanes: LayoutLane[]): Map<string, number> => {
    const laneIndexById = new Map<string, number>();
    lanes.forEach((lane, laneIndex) => {
        lane.nodeIds.forEach((nodeId) => {
            if (!laneIndexById.has(nodeId)) {
                laneIndexById.set(nodeId, laneIndex);
            }
        });
    });
    return laneIndexById;
};

/**
 * Adjacency limited to edges that actually carry ordering information: both endpoints
 * placed, and in different lanes. A same-lane edge says nothing about vertical order.
 */
const buildNeighbors = (
    edges: Connection[],
    laneIndexById: Map<string, number>
): Map<string, string[]> => {
    const neighbors = new Map<string, string[]>();
    const link = (from: string, to: string) => {
        const existing = neighbors.get(from);
        if (!existing) {
            neighbors.set(from, [to]);
        } else if (!existing.includes(to)) {
            existing.push(to);
        }
    };

    edges.forEach(({ source, target }) => {
        const sourceLane = laneIndexById.get(source);
        const targetLane = laneIndexById.get(target);
        if (sourceLane === undefined || targetLane === undefined) return;
        if (sourceLane === targetLane) return;
        link(source, target);
        link(target, source);
    });

    return neighbors;
};

const rankLookup = (order: LaneOrder): Map<string, number> => {
    const rankById = new Map<string, number>();
    order.forEach((nodeIds) => {
        nodeIds.forEach((nodeId, rank) => rankById.set(nodeId, rank));
    });
    return rankById;
};

/**
 * Average rank of a node's neighbours that live in lanes on the given side.
 * Returns null when the node has nothing to anchor to, in which case it keeps
 * its current position rather than being flung to the top of the lane.
 */
const barycenterOf = (
    nodeId: string,
    laneIndex: number,
    direction: 'forward' | 'backward',
    neighbors: Map<string, string[]>,
    laneIndexById: Map<string, number>,
    rankById: Map<string, number>
): number | null => {
    const adjacent = neighbors.get(nodeId);
    if (!adjacent || adjacent.length === 0) return null;

    let total = 0;
    let count = 0;
    adjacent.forEach((neighborId) => {
        const neighborLane = laneIndexById.get(neighborId);
        if (neighborLane === undefined) return;
        const isReference = direction === 'forward' ? neighborLane < laneIndex : neighborLane > laneIndex;
        if (!isReference) return;
        const rank = rankById.get(neighborId);
        if (rank === undefined) return;
        total += rank;
        count += 1;
    });

    return count === 0 ? null : total / count;
};

/**
 * Name order with numbers compared as numbers, so eth2 sorts before eth10. The final
 * tie-break everywhere in this module: nodes that wire alike keep this order.
 */
export const naturalCompare = (a: string, b: string): number =>
    a.localeCompare(b, undefined, { numeric: true });

/**
 * Lane-skipping edges as chains of adjacent-lane segments (ovn-recon-nt4.16).
 *
 * Crossings and barycenters are only defined between adjacent lanes. An edge from
 * the eth lane straight to a bridge used to be compared with nothing, so a NIC's arc
 * over a bond and its VLAN never counted as a crossing and the lane kept alphabetical
 * order over it. The standard layered-graph treatment: one virtual node per lane the
 * edge passes through. Virtual nodes take part in ordering and counting only; they
 * are never drawn and never appear in computeNodeOrder's result.
 */
interface AugmentedGraph {
    /** Real node ids per lane, deduplicated, in the caller's lane order. */
    realLanes: string[][];
    /** Virtual node ids per lane. */
    virtualLanes: string[][];
    virtualIds: Set<string>;
    laneIndexById: Map<string, number>;
    /** Every segment joins adjacent lanes, oriented low lane to high lane. */
    segments: { lo: string; hi: string }[];
    /** A virtual node's neighbour in the lane before it. */
    predecessorOf: Map<string, string>;
    /** The real edge a virtual node stands in for. */
    virtualEnds: Map<string, { lo: string; hi: string; loLane: number; hiLane: number }>;
    /** Every real neighbour of a real node, whatever lane it is in: what the renderer anchors to. */
    realNeighbors: Map<string, string[]>;
}

const VIRTUAL_PREFIX = '\u0000virtual:';

const augment = (lanes: LayoutLane[], edges: Connection[]): AugmentedGraph => {
    const laneIndexById = buildLaneIndex(lanes);
    const realLanes = lanes.map((lane, laneIndex) =>
        Array.from(new Set(lane.nodeIds)).filter((id) => laneIndexById.get(id) === laneIndex));
    const virtualLanes: string[][] = lanes.map(() => []);
    const virtualIds = new Set<string>();
    const predecessorOf = new Map<string, string>();
    const virtualEnds = new Map<string, { lo: string; hi: string; loLane: number; hiLane: number }>();
    const realNeighbors = new Map<string, string[]>();
    const segmentKeys = new Set<string>();
    const segments: { lo: string; hi: string }[] = [];

    const addSegment = (lo: string, hi: string) => {
        const key = `${lo}\u0000${hi}`;
        if (segmentKeys.has(key)) return;
        segmentKeys.add(key);
        segments.push({ lo, hi });
    };

    edges.forEach(({ source, target }) => {
        const sourceLane = laneIndexById.get(source);
        const targetLane = laneIndexById.get(target);
        if (sourceLane === undefined || targetLane === undefined) return;
        if (source !== target) {
            realNeighbors.set(source, [...(realNeighbors.get(source) ?? []), target]);
            realNeighbors.set(target, [...(realNeighbors.get(target) ?? []), source]);
        }
        if (sourceLane === targetLane) return;
        const [lo, hi] = sourceLane < targetLane ? [source, target] : [target, source];
        const [loLane, hiLane] = sourceLane < targetLane ? [sourceLane, targetLane] : [targetLane, sourceLane];

        let previous = lo;
        for (let lane = loLane + 1; lane < hiLane; lane += 1) {
            // Keyed by the edge's ends, so a repeated edge reuses its chain.
            const virtualId = `${VIRTUAL_PREFIX}${lo}\u0000${hi}@${lane}`;
            if (!virtualIds.has(virtualId)) {
                virtualIds.add(virtualId);
                virtualLanes[lane].push(virtualId);
                laneIndexById.set(virtualId, lane);
                predecessorOf.set(virtualId, previous);
                virtualEnds.set(virtualId, { lo, hi, loLane, hiLane });
            }
            addSegment(previous, virtualId);
            previous = virtualId;
        }
        addSegment(previous, hi);
    });

    return { realLanes, virtualLanes, virtualIds, laneIndexById, segments, predecessorOf, virtualEnds, realNeighbors };
};

/**
 * Interleave a lane's virtual nodes among its real nodes by key, keeping the real
 * nodes' order as given: before each real node, every virtual node keyed below it.
 * Ties go to the real node, and a real node with no key takes its predecessor's.
 */
const interleave = (
    real: { id: string; key: number | null }[],
    virtual: { id: string; key: number }[]
): string[] => {
    const pending = virtual.slice().sort((a, b) => (a.key - b.key) || naturalCompare(a.id, b.id));
    const merged: string[] = [];
    let carried = Number.NEGATIVE_INFINITY;
    real.forEach(({ id, key }) => {
        const effective = key ?? carried;
        carried = effective;
        while (pending.length > 0 && pending[0].key < effective) {
            merged.push(pending.shift()!.id);
        }
        merged.push(id);
    });
    pending.forEach(({ id }) => merged.push(id));
    return merged;
};

/**
 * Place every virtual node, lane by lane from the left, level with its predecessor,
 * leaving the real nodes in the order given. The view of a long edge countCrossings
 * takes when the caller ranked only real nodes, and the sweep's starting point.
 */
const placeVirtualNodes = (graph: AugmentedGraph, realOrder: string[][]): LaneOrder => {
    const neighbors = buildNeighbors(
        graph.segments.map(({ lo, hi }) => ({ source: lo, target: hi })),
        graph.laneIndexById
    );
    const order: LaneOrder = [];
    realOrder.forEach((realIds, laneIndex) => {
        const rankById = rankLookup(order);
        const real = realIds.map((id) => ({
            id,
            key: barycenterOf(id, laneIndex, 'forward', neighbors, graph.laneIndexById, rankById)
        }));
        const virtual = graph.virtualLanes[laneIndex].map((id) => ({
            id,
            key: rankById.get(graph.predecessorOf.get(id)!) ?? 0
        }));
        order.push(interleave(real, virtual));
    });
    return order;
};

/**
 * Where each node will be drawn, in rows, mimicking placeLanes (src/topology/lanes.ts):
 * lanes fill left to right; a real node sinks to the mean height of its real
 * neighbours already placed and never rises above the lane's stack cursor. A virtual
 * node sits where the straight line of its edge crosses its lane.
 *
 * Ranks alone miss what this sees (ovn-recon-nt4.16): a NIC fanning out to three VFs
 * takes one row in its lane but three in the next, pushing every later VF down, so
 * two orders with the same rank crossings can draw very differently. Row heights
 * are uniform here; the real ones vary a little, so this stays an estimate.
 */
const estimateRows = (graph: AugmentedGraph, order: LaneOrder): Map<string, number> => {
    const rowById = new Map<string, number>();
    order.forEach((nodeIds) => {
        let cursor = 0;
        nodeIds.forEach((id) => {
            if (graph.virtualIds.has(id)) return;
            const anchors = (graph.realNeighbors.get(id) ?? [])
                .map((neighborId) => rowById.get(neighborId))
                .filter((row): row is number => row !== undefined);
            const row = anchors.length === 0
                ? cursor
                : Math.max(cursor, anchors.reduce((sum, value) => sum + value, 0) / anchors.length);
            rowById.set(id, row);
            cursor = row + 1;
        });
    });
    graph.virtualEnds.forEach(({ lo, hi, loLane, hiLane }, id) => {
        const from = rowById.get(lo) ?? 0;
        const to = rowById.get(hi) ?? 0;
        const along = (graph.laneIndexById.get(id)! - loLane) / (hiLane - loLane);
        rowById.set(id, from + (to - from) * along);
    });
    return rowById;
};

/**
 * Crossings between adjacent-lane segments, compared at their estimated drawn
 * heights; equal heights fall back to the order in the lane.
 */
const countSegmentCrossings = (graph: AugmentedGraph, order: LaneOrder): number => {
    const rankById = rankLookup(order);
    const rowById = estimateRows(graph, order);
    const compare = (a: string, b: string): number =>
        ((rowById.get(a) ?? 0) - (rowById.get(b) ?? 0)) || ((rankById.get(a) ?? 0) - (rankById.get(b) ?? 0));

    const buckets = new Map<number, { lo: string; hi: string }[]>();
    graph.segments.forEach((segment) => {
        const lane = graph.laneIndexById.get(segment.lo)!;
        const bucket = buckets.get(lane) ?? [];
        bucket.push(segment);
        buckets.set(lane, bucket);
    });

    let crossings = 0;
    buckets.forEach((bucket) => {
        for (let i = 0; i < bucket.length; i += 1) {
            for (let j = i + 1; j < bucket.length; j += 1) {
                if (compare(bucket[i].lo, bucket[j].lo) * compare(bucket[i].hi, bucket[j].hi) < 0) crossings += 1;
            }
        }
    });
    return crossings;
};

const orderLane = (
    nodeIds: string[],
    laneIndex: number,
    direction: 'forward' | 'backward',
    neighbors: Map<string, string[]>,
    laneIndexById: Map<string, number>,
    rankById: Map<string, number>,
    groupRankById: Record<string, number>,
    virtualIds: Set<string>
): string[] => {
    const keyed = nodeIds.map((nodeId, currentRank) => ({
        nodeId,
        currentRank,
        groupRank: groupRankById[nodeId] ?? 0,
        // Nodes with no anchor hold station at their current rank.
        barycenter: barycenterOf(nodeId, laneIndex, direction, neighbors, laneIndexById, rankById) ?? currentRank
    }));

    // Real nodes honour group ranks; virtual nodes belong to no group and slot in
    // between them by barycenter alone.
    const real = keyed
        .filter((entry) => !virtualIds.has(entry.nodeId))
        .sort((a, b) => {
            if (a.groupRank !== b.groupRank) return a.groupRank - b.groupRank;
            if (a.barycenter !== b.barycenter) return a.barycenter - b.barycenter;
            // Stable and deterministic: previous rank, then natural name order.
            if (a.currentRank !== b.currentRank) return a.currentRank - b.currentRank;
            return naturalCompare(a.nodeId, b.nodeId);
        });
    const virtual = keyed.filter((entry) => virtualIds.has(entry.nodeId));

    return interleave(
        real.map((entry) => ({ id: entry.nodeId, key: entry.barycenter })),
        virtual.map((entry) => ({ id: entry.nodeId, key: entry.barycenter }))
    );
};

/**
 * Edge crossings under a given ordering of the real nodes.
 *
 * Each lane-skipping edge counts as a chain through the lanes it passes (see
 * `augment`), so an eth -> bridge edge crosses the eth -> bond and bond -> vlan edges
 * it passes over. Two segments between the same adjacent lanes cross when their ends
 * are in opposite vertical order at the heights they will be drawn (`estimateRows`).
 *
 * Exported so tests can assert that a change actually improves the layout rather
 * than merely changing it.
 */
export const countCrossings = (
    lanes: LayoutLane[],
    edges: Connection[],
    rankById: Record<string, number>
): number => {
    const graph = augment(lanes, edges);
    const realOrder = graph.realLanes.map((ids) =>
        ids.slice().sort((a, b) => ((rankById[a] ?? 0) - (rankById[b] ?? 0)) || naturalCompare(a, b)));
    return countSegmentCrossings(graph, placeVirtualNodes(graph, realOrder));
};

/** Ranks of the real nodes only, renumbered from 0 per lane. */
const toRankRecord = (order: LaneOrder, virtualIds: Set<string>): Record<string, number> => {
    const rankById: Record<string, number> = {};
    order.forEach((nodeIds) => {
        nodeIds
            .filter((nodeId) => !virtualIds.has(nodeId))
            .forEach((nodeId, rank) => {
                rankById[nodeId] = rank;
            });
    });
    return rankById;
};

/**
 * Rank of each node within its lane, chosen to minimise edge crossings.
 * Deterministic: identical input always yields identical output.
 */
export const computeNodeOrder = ({
    lanes,
    edges,
    groupRankById = {},
    iterations = DEFAULT_ITERATIONS
}: ComputeNodeOrderParams): Record<string, number> => {
    const graph = augment(lanes, edges);
    const neighbors = buildNeighbors(
        graph.segments.map(({ lo, hi }) => ({ source: lo, target: hi })),
        graph.laneIndexById
    );

    // Seed deterministically: group rank first, then natural name order. Without a
    // stable seed the result would depend on the order resources happened to arrive
    // from the API. Virtual nodes start level with their predecessors.
    let order: LaneOrder = placeVirtualNodes(graph, graph.realLanes.map((ids) =>
        ids.slice().sort((a, b) => {
            const groupDelta = (groupRankById[a] ?? 0) - (groupRankById[b] ?? 0);
            return groupDelta !== 0 ? groupDelta : naturalCompare(a, b);
        })
    ));

    let best = order;
    let bestCrossings = countSegmentCrossings(graph, order);

    for (let pass = 0; pass < iterations && bestCrossings > 0; pass += 1) {
        const direction: 'forward' | 'backward' = pass % 2 === 0 ? 'forward' : 'backward';
        const laneSequence = direction === 'forward'
            ? order.map((_, index) => index)
            : order.map((_, index) => order.length - 1 - index);

        const next: LaneOrder = order.map((nodeIds) => nodeIds.slice());
        laneSequence.forEach((laneIndex) => {
            // Rebuild ranks each lane so a sweep sees the lanes it has already moved.
            const rankById = rankLookup(next);
            next[laneIndex] = orderLane(
                next[laneIndex],
                laneIndex,
                direction,
                neighbors,
                graph.laneIndexById,
                rankById,
                groupRankById,
                graph.virtualIds
            );
        });

        order = next;
        const crossings = countSegmentCrossings(graph, order);
        if (crossings < bestCrossings) {
            bestCrossings = crossings;
            best = order;
        }
    }

    // Barycenters cannot see a fan-out: a NIC with three VFs averages level with its
    // first VF, though it pushes every VF after them down. Try moving each real node
    // to every other slot of its group, re-sort the lanes around the move, and keep
    // any order that draws fewer crossings. A move, not a swap: a fanning NIC often
    // has to pass several others before the count drops.
    const resortAround = (candidate: LaneOrder, laneIndex: number): LaneOrder => {
        const next = candidate.map((nodeIds) => nodeIds.slice());
        const resort = (index: number, direction: 'forward' | 'backward') => {
            next[index] = orderLane(next[index], index, direction, neighbors, graph.laneIndexById,
                rankLookup(next), groupRankById, graph.virtualIds);
        };
        for (let index = laneIndex + 1; index < next.length; index += 1) resort(index, 'forward');
        for (let index = laneIndex - 1; index >= 0; index -= 1) resort(index, 'backward');
        return next;
    };

    /** The lane with real node `from` moved to the slot real node `to` holds. */
    const moved = (laneIds: string[], from: string, to: string): string[] => {
        const without = laneIds.filter((id) => id !== from);
        const at = without.indexOf(to);
        const after = laneIds.indexOf(from) < laneIds.indexOf(to);
        without.splice(after ? at + 1 : at, 0, from);
        return without;
    };

    let budget = REFINE_BUDGET;
    let improved = true;
    for (let pass = 0; pass < REFINE_PASSES && improved && bestCrossings > 0 && budget > 0; pass += 1) {
        improved = false;
        for (let laneIndex = 0; laneIndex < best.length && bestCrossings > 0 && budget > 0; laneIndex += 1) {
            const realIds = () => best[laneIndex].filter((id) => !graph.virtualIds.has(id));
            for (const from of realIds()) {
                if (bestCrossings === 0 || budget <= 0) break;
                const group = groupRankById[from] ?? 0;
                for (const to of realIds()) {
                    if (to === from || (groupRankById[to] ?? 0) !== group) continue;
                    if (budget <= 0) break;
                    budget -= 1;
                    const shifted = best.map((nodeIds) => nodeIds.slice());
                    shifted[laneIndex] = moved(shifted[laneIndex], from, to);
                    const candidate = resortAround(shifted, laneIndex);
                    const crossings = countSegmentCrossings(graph, candidate);
                    if (crossings < bestCrossings) {
                        best = candidate;
                        bestCrossings = crossings;
                        improved = true;
                        break;
                    }
                }
            }
        }
    }

    return toRankRecord(best, graph.virtualIds);
};

/**
 * Sort items into their computed within-lane order. Items with no rank sort last,
 * then in natural name order, so an unranked node never silently jumps to the top.
 */
export const sortByRank = <T,>(items: T[], getId: (item: T) => string, rankById: Record<string, number>): T[] =>
    items.slice().sort((a, b) => {
        const aId = getId(a);
        const bId = getId(b);
        // `??`, not `||`: rank 0 is the top of the lane.
        const rankDelta = (rankById[aId] ?? UNRANKED) - (rankById[bId] ?? UNRANKED);
        if (rankDelta !== 0) return rankDelta;
        return naturalCompare(aId, bId);
    });

/** A node's box, as an obstacle for edge routing. */
export interface EdgeObstacle {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Where a lane-crossing edge must bow to avoid running through a node
 * (ovn-recon-s3t.49).
 *
 * Anchor alignment (s3t.47) deliberately puts a child level with its parent --
 * and the parent's lane-skipping edges then pass straight through the child's
 * lane at that exact height, reading as a chain that does not exist. When the
 * straight segment would cross a node box in an intermediate lane, the edge
 * renders as a quadratic arc instead, bowing to whichever side needs the
 * smaller deviation. A clear segment returns null and stays a straight line.
 */
export const computeEdgeBow = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    obstacles: EdgeObstacle[],
    margin = 10
): { controlX: number; controlY: number } | null => {
    const run = to.x - from.x;
    // Backwards or degenerate edges (the hidden-lane bridge-port case) stay straight.
    if (run <= 1) return null;

    const yAt = (x: number): number => from.y + (to.y - from.y) * ((x - from.x) / run);

    // For each intersected box: how far the line must move, per direction, and
    // where along the edge the obstruction sits (for the quadratic's geometry --
    // a control offset c displaces the curve by 2t(1-t)c at parameter t).
    let needUp = 0;
    let needDown = 0;
    obstacles.forEach((box) => {
        const left = Math.max(box.x, from.x);
        const right = Math.min(box.x + box.width, to.x);
        if (right <= left) return;

        const yLeft = yAt(left);
        const yRight = yAt(right);
        const top = box.y - margin;
        const bottom = box.y + box.height + margin;
        if (Math.max(yLeft, yRight) <= top || Math.min(yLeft, yRight) >= bottom) return;

        const t = ((left + right) / 2 - from.x) / run;
        const lineY = yAt((left + right) / 2);
        const displacementScale = Math.max(2 * t * (1 - t), 0.2);
        needUp = Math.max(needUp, (lineY - top) / displacementScale);
        needDown = Math.max(needDown, (bottom - lineY) / displacementScale);
    });

    if (needUp === 0 && needDown === 0) return null;

    const controlOffset = needUp <= needDown ? -needUp : needDown;
    return {
        controlX: Math.round((from.x + to.x) / 2),
        controlY: Math.round((from.y + to.y) / 2 + controlOffset)
    };
};
