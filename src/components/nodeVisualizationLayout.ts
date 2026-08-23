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

const orderLane = (
    nodeIds: string[],
    laneIndex: number,
    direction: 'forward' | 'backward',
    neighbors: Map<string, string[]>,
    laneIndexById: Map<string, number>,
    rankById: Map<string, number>,
    groupRankById: Record<string, number>
): string[] => {
    const keyed = nodeIds.map((nodeId, currentRank) => ({
        nodeId,
        currentRank,
        groupRank: groupRankById[nodeId] ?? 0,
        // Nodes with no anchor hold station at their current rank.
        barycenter: barycenterOf(nodeId, laneIndex, direction, neighbors, laneIndexById, rankById) ?? currentRank
    }));

    return keyed
        .slice()
        .sort((a, b) => {
            if (a.groupRank !== b.groupRank) return a.groupRank - b.groupRank;
            if (a.barycenter !== b.barycenter) return a.barycenter - b.barycenter;
            // Stable and deterministic: previous rank, then id.
            if (a.currentRank !== b.currentRank) return a.currentRank - b.currentRank;
            return a.nodeId.localeCompare(b.nodeId);
        })
        .map((entry) => entry.nodeId);
};

/**
 * Edge crossings under a given ordering. Two edges spanning the same pair of lanes
 * cross when their endpoints are in opposite vertical order at each end.
 *
 * Exported so tests can assert that a change actually improves the layout rather
 * than merely changing it.
 */
export const countCrossings = (
    lanes: LayoutLane[],
    edges: Connection[],
    rankById: Record<string, number>
): number => {
    const laneIndexById = buildLaneIndex(lanes);

    // Normalise each edge to (lower lane endpoint, higher lane endpoint) and bucket
    // by the lane pair it spans; only edges in the same bucket can cross.
    const buckets = new Map<string, { lo: string; hi: string }[]>();
    edges.forEach(({ source, target }) => {
        const sourceLane = laneIndexById.get(source);
        const targetLane = laneIndexById.get(target);
        if (sourceLane === undefined || targetLane === undefined) return;
        if (sourceLane === targetLane) return;
        const [lo, hi] = sourceLane < targetLane ? [source, target] : [target, source];
        const [loLane, hiLane] = sourceLane < targetLane ? [sourceLane, targetLane] : [targetLane, sourceLane];
        const key = `${loLane}:${hiLane}`;
        const bucket = buckets.get(key);
        if (bucket) {
            bucket.push({ lo, hi });
        } else {
            buckets.set(key, [{ lo, hi }]);
        }
    });

    let crossings = 0;
    buckets.forEach((bucket) => {
        for (let i = 0; i < bucket.length; i += 1) {
            for (let j = i + 1; j < bucket.length; j += 1) {
                const loDelta = (rankById[bucket[i].lo] ?? 0) - (rankById[bucket[j].lo] ?? 0);
                const hiDelta = (rankById[bucket[i].hi] ?? 0) - (rankById[bucket[j].hi] ?? 0);
                if (loDelta * hiDelta < 0) crossings += 1;
            }
        }
    });

    return crossings;
};

const toRankRecord = (order: LaneOrder): Record<string, number> => {
    const rankById: Record<string, number> = {};
    order.forEach((nodeIds) => {
        nodeIds.forEach((nodeId, rank) => {
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
    const laneIndexById = buildLaneIndex(lanes);
    const neighbors = buildNeighbors(edges, laneIndexById);

    // Seed deterministically: group rank first, then id. Without a stable seed the
    // result would depend on the order resources happened to arrive from the API.
    let order: LaneOrder = lanes.map((lane) =>
        Array.from(new Set(lane.nodeIds)).sort((a, b) => {
            const groupDelta = (groupRankById[a] ?? 0) - (groupRankById[b] ?? 0);
            return groupDelta !== 0 ? groupDelta : a.localeCompare(b);
        })
    );

    let best = order;
    let bestCrossings = countCrossings(lanes, edges, toRankRecord(order));

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
                laneIndexById,
                rankById,
                groupRankById
            );
        });

        order = next;
        const crossings = countCrossings(lanes, edges, toRankRecord(order));
        if (crossings < bestCrossings) {
            bestCrossings = crossings;
            best = order;
        }
    }

    return toRankRecord(best);
};

/**
 * Sort items into their computed within-lane order. Items with no rank sort last,
 * then alphabetically, so an unranked node never silently jumps to the top.
 */
export const sortByRank = <T,>(items: T[], getId: (item: T) => string, rankById: Record<string, number>): T[] =>
    items.slice().sort((a, b) => {
        const aId = getId(a);
        const bId = getId(b);
        // `??`, not `||`: rank 0 is the top of the lane.
        const rankDelta = (rankById[aId] ?? UNRANKED) - (rankById[bId] ?? UNRANKED);
        if (rankDelta !== 0) return rankDelta;
        return aId.localeCompare(bId);
    });
