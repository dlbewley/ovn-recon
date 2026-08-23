import { GraphContext } from './context';

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

export interface LaneGroup<T = never> {
    /** Sub-header drawn above this group. Omit when the lane's own title serves. */
    title?: string;
    items: (ctx: GraphContext, view: LaneViewState) => T[];
    nodeId: (item: T, ctx: GraphContext) => string;
    /**
     * Passed to the node renderer as its type. Defaults to the item's own `type`.
     * A function when the type varies per item, as in the Networks lane where CUDNs and
     * UDNs share a lane but render differently.
     */
    renderType?: string | ((item: T) => string);
    /**
     * The object handed to the renderer, when the lane's items are wrappers rather than
     * the resource itself. The Networks lane carries { kind, item } so it can hold two
     * resource types in one lane.
     */
    renderItem?: (item: T) => unknown;
    color: (item: T) => string;
    /** Node height, when it varies with content. Defaults to the standard height. */
    height?: (item: T) => number;
    /** Extra gap above this group, applied only when both it and the previous have items. */
    gapBefore?: number;
}

export interface Lane {
    id: string;
    /** Header for the lane. Omit when the groups carry their own. */
    title?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    groups: LaneGroup<any>[];
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

export const LANE_IDS = [
    'lldp', 'eth', 'bond', 'vlan', 'bridge', 'logical', 'l3', 'networks', 'attachments', 'nads'
] as const;

export type LaneId = typeof LANE_IDS[number];

/**
 * Build the lane table.
 *
 * Takes its accessors as parameters rather than importing them, so this module stays
 * free of React and of the component's local helpers. ovn-recon-s3t.9 inverts this:
 * each node kind's descriptor will declare the lane it belongs to, and the table becomes
 * a list of lane headers rather than a list of item accessors.
 */
export interface LaneAccessors {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
}

export const buildLanes = (a: LaneAccessors): Lane[] => [
    {
        id: 'lldp',
        title: 'LLDP Neighbors',
        customLayout: true,
        groups: [{
            items: (ctx, view) => (view.showLldp ? a.lldpNeighbors : []),
            nodeId: (n: { id: string }) => n.id,
            renderType: 'lldp-neighbor',
            color: () => '#2E7D32'
        }],
        // Unlike every other lane this one is gated on a toggle, not on being populated:
        // a node with no LLDP data offers no toggle at all.
        visible: (_ctx, view) => view.showLldp
    },
    {
        id: 'eth',
        title: 'Physical Interfaces',
        groups: [{
            items: (ctx) => a.byRole(ctx, 'physical'),
            nodeId: a.interfaceId,
            color: () => '#0066CC'
        }],
        visible: whenPopulated
    },
    {
        id: 'bond',
        title: 'Bonds',
        groups: [{
            items: (ctx) => a.byRole(ctx, 'bond'),
            nodeId: a.interfaceId,
            color: () => '#663399'
        }],
        visible: whenPopulated
    },
    {
        id: 'vlan',
        title: 'VLAN Interfaces',
        groups: [{
            items: (ctx) => a.byRole(ctx, 'vlan'),
            nodeId: a.interfaceId,
            color: () => '#9933CC'
        }],
        visible: whenPopulated
    },
    {
        id: 'bridge',
        title: 'Bridges',
        groups: [{
            items: (ctx) => a.byRole(ctx, 'bridge'),
            nodeId: a.interfaceId,
            color: () => '#FF6600'
        }],
        visible: whenPopulated
    },
    {
        id: 'logical',
        title: 'Logical Interfaces',
        groups: [{
            items: (ctx) => a.byRole(ctx, 'bridge-port'),
            nodeId: a.interfaceId,
            color: () => '#0099CC'
        }],
        // Hidden unless everything is shown, however populated it is. That is why the
        // interface holding the node's own address is invisible by default -- see
        // ovn-recon-x23, which ovn-recon-s3t.26 supersedes by drawing ports on bridges.
        visible: (_ctx, view) => view.showHiddenColumns
    },
    {
        id: 'l3',
        groups: [
            {
                title: 'Bridge Mappings',
                items: (ctx) => ctx.bridgeMappings,
                nodeId: (m: { localnet?: string }) => a.bridgeMappingId(m.localnet),
                renderType: 'ovn-mapping',
                color: () => '#009900'
            },
            {
                title: 'VRFs',
                items: (ctx) => a.byRole(ctx, 'vrf'),
                nodeId: a.interfaceId,
                renderType: 'vrf',
                color: () => '#CC6600',
                gapBefore: 40
            }
        ],
        visible: whenPopulated
    },
    {
        id: 'networks',
        title: 'Networks',
        groups: [{
            items: () => a.networkItems,
            nodeId: a.networkId,
            renderType: (n: { kind: string }) => n.kind,
            renderItem: (n: { item: unknown }) => n.item,
            color: (n: { kind: string }) => (n.kind === 'cudn' ? '#CC0099' : '#0084A8')
        }],
        visible: whenPopulated
    },
    {
        id: 'attachments',
        title: 'Attachments',
        groups: [{
            items: () => a.attachmentNodes,
            nodeId: a.attachmentId,
            renderType: 'attachment',
            color: () => '#F0AB00',
            height: a.attachmentHeight
        }],
        // Always present, even when empty: its header is drawn unconditionally today.
        visible: () => true
    },
    {
        id: 'nads',
        title: 'NADs',
        groups: [{
            items: (ctx, view) => (view.showNads ? ctx.nads : []),
            nodeId: a.nadId,
            renderType: 'nad',
            color: () => '#CC9900'
        }],
        visible: (_ctx, view) => view.showNads
    }
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
    laneId: string;
    x: number;
    y: number;
    height: number;
    renderType?: string;
    color: string;
}

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
    lanes: Lane[],
    ctx: GraphContext,
    view: LaneViewState,
    metrics: LaneMetrics,
    /** Rank within lane, from the ordering pass. */
    rankById: Record<string, number>,
    /** Positions for lanes that place themselves. */
    customPositions: (laneId: string, x: number) => PlacedNode[] | null
): LaneLayout => {
    const { padding, itemHeight, itemGap, colSpacing } = metrics;

    const populated = lanes.map((lane) => ({
        lane,
        groups: lane.groups.map((group) => ({ group, items: group.items(ctx, view) }))
    }));

    const visible = populated.filter(({ lane, groups }) =>
        lane.visible(ctx, view, groups.reduce((n, g) => n + g.items.length, 0)));

    const positions: Record<string, { x: number; y: number }> = {};
    let maxY = 0;

    const placed = visible.map(({ lane, groups }, laneIndex) => {
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

        const renderGroups = groups.map(({ group, items }) => {
            if (group.gapBefore && previousHadItems && items.length > 0) {
                y += group.gapBefore;
            }
            const ordered = items
                .slice()
                .sort((p, q) => {
                    const rankDelta = (rankById[group.nodeId(p, ctx)] ?? Number.MAX_SAFE_INTEGER)
                        - (rankById[group.nodeId(q, ctx)] ?? Number.MAX_SAFE_INTEGER);
                    if (rankDelta !== 0) return rankDelta;
                    return group.nodeId(p, ctx).localeCompare(group.nodeId(q, ctx));
                });

            const nodes: PlacedNode[] = ordered.map((item) => {
                const id = group.nodeId(item, ctx);
                const height = group.height ? group.height(item) : itemHeight;
                const node: PlacedNode = {
                    id,
                    item: group.renderItem ? group.renderItem(item) : item,
                    laneId: lane.id, x, y, height,
                    renderType: typeof group.renderType === 'function'
                        ? group.renderType(item)
                        : group.renderType,
                    color: group.color(item)
                };
                positions[id] = { x, y };
                y += height + itemGap;
                maxY = Math.max(maxY, y);
                return node;
            });

            if (items.length > 0) previousHadItems = true;
            return { title: group.title, nodes };
        });

        return { lane, x, groups: renderGroups };
    });

    return { lanes: placed, positions, maxY };
};

/**
 * The input the ordering pass needs: node ids per lane, and a rank per node reflecting
 * which group within its lane it belongs to.
 *
 * Derived from the same table the layout uses, so the two cannot drift. This was
 * previously a seventh hand-maintained list, with the group ranks assigned separately
 * by name -- VRFs and UDNs were pushed down by rules written out longhand. Group order
 * in the table now says it instead.
 */
export const laneOrderingInput = (
    lanes: Lane[],
    ctx: GraphContext,
    view: LaneViewState
): { lanes: { id: string; nodeIds: string[] }[]; groupRankById: Record<string, number> } => {
    const groupRankById: Record<string, number> = {};
    const ordered = lanes.map((lane) => {
        const nodeIds: string[] = [];
        lane.groups.forEach((group, groupIndex) => {
            group.items(ctx, view).forEach((item) => {
                const id = group.nodeId(item, ctx);
                nodeIds.push(id);
                if (groupIndex > 0) groupRankById[id] = groupIndex;
            });
        });
        return { id: lane.id, nodeIds };
    });
    return { lanes: ordered, groupRankById };
};
