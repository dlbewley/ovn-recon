import { GraphContext } from './context';
import { AnyNodeTypeDescriptor, descriptorsInLane } from './descriptors';

/**
 * The lanes of the physical topology graph, as one ordered table.
 *
 * Lane identity used to live in five parallel structures that had to be kept in step by
 * hand: a `columns` array, eight near-identical position blocks, eleven sort calls, a
 * `maxRows` list, and sixteen render branches keyed on `col.key`. Nothing enforced that
 * a change touched all five, and each omission failed differently and silently -- a
 * missing position block left a node with no coordinates, a missing render branch left
 * it positioned but invisible.
 *
 * A lane is a column. A lane has one or more GROUPS stacked within it, which is how the
 * Layer 3 lane carries bridge mappings above VRFs under separate sub-headers.
 */

/** What the toolbar toggles currently say. */
export interface LaneViewState {
    showHiddenColumns: boolean;
    showNads: boolean;
    /** True only when the node has LLDP data AND the toggle is on. */
    showLldp: boolean;
}

export interface Lane {
    id: string;
    /** Header for the lane. Omit when its descriptors carry their own group titles. */
    title?: string;
    /**
     * Whether the lane appears at all. Distinct from being empty: a lane can be present
     * and empty (which reserves its column) or absent entirely (which does not).
     */
    visible: (ctx: GraphContext, view: LaneViewState, itemCount: number) => boolean;
    /**
     * Lanes whose vertical placement is not a simple stack. Only LLDP needs this: its
     * neighbours align with the interface they were seen on rather than stacking from
     * the top, so it borrows the physical lane's ordering.
     */
    customLayout?: true;
}

/** The default rule: show a lane when it has something in it, or when nothing is hidden. */
const whenPopulated = (_ctx: GraphContext, view: LaneViewState, itemCount: number): boolean =>
    view.showHiddenColumns || itemCount > 0;

/**
 * Lane headers, in render order. What goes IN each lane is declared by the node type
 * descriptors, which name the lane they belong to -- so adding a node type means adding
 * a descriptor, not editing this list.
 */
export const LANES: Lane[] = [
    {
        id: 'lldp',
        title: 'LLDP Neighbors',
        customLayout: true,
        // Gated on a toggle rather than on being populated: a node with no LLDP data
        // offers no toggle at all.
        visible: (_ctx, view) => view.showLldp
    },
    { id: 'eth', title: 'Physical Interfaces', visible: whenPopulated },
    { id: 'bond', title: 'Bonds', visible: whenPopulated },
    { id: 'vlan', title: 'VLAN Interfaces', visible: whenPopulated },
    { id: 'bridge', title: 'Bridges', visible: whenPopulated },
    {
        id: 'logical',
        title: 'Logical Interfaces',
        // Hidden unless everything is shown, however populated it is. That is why the
        // interface holding the node's own address is invisible by default -- see
        // ovn-recon-x23, which ovn-recon-s3t.26 supersedes by drawing ports on bridges.
        visible: (_ctx, view) => view.showHiddenColumns
    },
    // Two descriptors share this lane, each with its own sub-header.
    { id: 'l3', visible: whenPopulated },
    { id: 'networks', title: 'Networks', visible: whenPopulated },
    // Always present, even when empty: its header is drawn unconditionally.
    { id: 'attachments', title: 'Attachments', visible: () => true },
    { id: 'nads', title: 'NADs', visible: (_ctx, view) => view.showNads }
];

export interface LaneMetrics {
    padding: number;
    itemHeight: number;
    itemGap: number;
    colSpacing: number;
}

export interface PlacedNode {
    id: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    item: any;
    /** Everything the renderer needs to draw it. */
    descriptor: AnyNodeTypeDescriptor;
    laneId: string;
    x: number;
    y: number;
    height: number;
    color: string;
}

/**
 * Items a lane holds, one entry per descriptor drawing in it.
 *
 * Two lanes are gated on a toggle rather than on content, so the view state suppresses
 * their items rather than the descriptor knowing about toolbar state.
 */
/**
 * Two lanes are gated on a toggle rather than on content. Suppression lives here rather
 * than in the descriptors, which know nothing about toolbar state.
 */
export const isLaneSuppressed = (laneId: string | null, view: LaneViewState): boolean =>
    (laneId === 'nads' && !view.showNads) || (laneId === 'lldp' && !view.showLldp);

/**
 * Items each descriptor contributes, honouring toggle suppression.
 *
 * Shared by the layout and the edge builder so a hidden lane contributes no edges
 * either -- otherwise path highlighting would traverse into nodes that are not drawn.
 */
export const visibleItems = (
    ctx: GraphContext,
    view: LaneViewState,
    descriptor: AnyNodeTypeDescriptor
): unknown[] => (isLaneSuppressed(descriptor.lane, view) ? [] : descriptor.items(ctx));

const laneContents = (
    lane: Lane,
    ctx: GraphContext,
    view: LaneViewState
): { descriptor: AnyNodeTypeDescriptor; items: unknown[] }[] =>
    descriptorsInLane(lane.id).map((descriptor) => ({
        descriptor, items: visibleItems(ctx, view, descriptor)
    }));

export interface LaneLayout {
    /** Lanes that are visible, in render order, with their x position. */
    lanes: { lane: Lane; x: number; groups: { title?: string; nodes: PlacedNode[] }[] }[];
    positions: Record<string, { x: number; y: number }>;
    /** Lowest point any lane reached, for sizing the canvas. */
    maxY: number;
}

/**
 * Place every node in every visible lane.
 *
 * One pass produces both the position map the connectors read and the render list, so
 * the two cannot disagree -- which they previously did, six lanes recomputing Y at
 * render time while the connectors read the map.
 */
export const layoutLanes = (
    ctx: GraphContext,
    view: LaneViewState,
    metrics: LaneMetrics,
    /** Rank within lane, from the ordering pass. */
    rankById: Record<string, number>,
    /** Placement for lanes that place themselves. */
    customPositions: (laneId: string, x: number) => PlacedNode[] | null
): LaneLayout => {
    const { padding, itemHeight, itemGap, colSpacing } = metrics;

    const populated = LANES.map((lane) => ({ lane, contents: laneContents(lane, ctx, view) }));
    const visible = populated.filter(({ lane, contents }) =>
        lane.visible(ctx, view, contents.reduce((n, c) => n + c.items.length, 0)));

    const positions: Record<string, { x: number; y: number }> = {};
    let maxY = 0;

    const placed = visible.map(({ lane, contents }, laneIndex) => {
        const x = padding + laneIndex * colSpacing;

        if (lane.customLayout) {
            const nodes = customPositions(lane.id, x) ?? [];
            nodes.forEach((n) => {
                positions[n.id] = { x: n.x, y: n.y };
                maxY = Math.max(maxY, n.y + n.height);
            });
            return { lane, x, groups: [{ title: undefined, nodes }] };
        }

        let y = padding;
        let previousHadItems = false;

        const groups = contents.map(({ descriptor, items }) => {
            if (descriptor.gapBefore && previousHadItems && items.length > 0) {
                y += descriptor.gapBefore;
            }
            const ordered = items.slice().sort((p, q) => {
                const pid = descriptor.id(p, ctx);
                const qid = descriptor.id(q, ctx);
                const rankDelta = (rankById[pid] ?? Number.MAX_SAFE_INTEGER)
                    - (rankById[qid] ?? Number.MAX_SAFE_INTEGER);
                return rankDelta !== 0 ? rankDelta : pid.localeCompare(qid);
            });

            const nodes: PlacedNode[] = ordered.map((item) => {
                const id = descriptor.id(item, ctx);
                const height = descriptor.height ? descriptor.height(item, itemHeight) : itemHeight;
                const node: PlacedNode = {
                    id, item, descriptor, laneId: lane.id, x, y, height, color: descriptor.color
                };
                positions[id] = { x, y };
                y += height + itemGap;
                maxY = Math.max(maxY, y);
                return node;
            });

            if (items.length > 0) previousHadItems = true;
            return { title: descriptor.groupTitle, nodes };
        });

        return { lane, x, groups };
    });

    return { lanes: placed, positions, maxY };
};

/**
 * The input the ordering pass needs: node ids per lane, and a rank per node reflecting
 * which group within its lane it belongs to.
 *
 * Derived from the same descriptors the layout uses, so the two cannot drift. Group
 * ranks used to be assigned by naming VRFs and UDNs longhand; descriptor order within a
 * lane now says it instead.
 */
export const laneOrderingInput = (
    ctx: GraphContext,
    view: LaneViewState
): { lanes: { id: string; nodeIds: string[] }[]; groupRankById: Record<string, number> } => {
    const groupRankById: Record<string, number> = {};
    const lanes = LANES.map((lane) => {
        const nodeIds: string[] = [];
        laneContents(lane, ctx, view).forEach(({ descriptor, items }, groupIndex) => {
            items.forEach((item) => {
                const id = descriptor.id(item, ctx);
                nodeIds.push(id);
                if (groupIndex > 0) groupRankById[id] = groupIndex;
            });
        });
        return { id: lane.id, nodeIds };
    });
    return { lanes, groupRankById };
};
