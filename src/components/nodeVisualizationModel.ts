import { GraphContext } from '../topology/context';
import { NODE_TYPES } from '../topology/descriptors';
import { resolveInterfaceRef } from '../topology/ids';
import { LaneViewState, visibleItems } from '../topology/lanes';

export interface TopologyEdge {
    source: string;
    target: string;
}

/** An edge that could not be drawn because one end names something not on this node. */
export interface UnresolvedEdge {
    /** What produced it, e.g. 'controller' or 'bridge-mapping'. */
    rule: string;
    /** The name that did not resolve. */
    reference: string;
    /** The node that carried the reference. */
    from: string;
}

export interface TopologyEdgeResult {
    edges: TopologyEdge[];
    /**
     * References that pointed at nothing. Previously these were dropped in silence,
     * which made a dangling controller look identical to a node with no edges.
     */
    unresolved: UnresolvedEdge[];
}

/**
 * Controllers that legitimately name something nmstate does not report as an interface.
 *
 * `ovs-system` is the OVS kernel datapath device. Veths and the Geneve tunnel are
 * enslaved to it, and it appears in no NodeNetworkState -- both real captures show it.
 * Reporting these would fire on every cluster, which is how a useful warning becomes
 * noise nobody reads.
 */
const KNOWN_UNREPORTED_CONTROLLERS = new Set(['ovs-system']);

/**
 * Collect every edge the node types contribute.
 *
 * The rules used to live here as one block per relationship, so adding a node type meant
 * editing this file as well as the lane table, the renderer and the view model. Each
 * descriptor now owns the edges it draws, and this walks the table.
 */
export const buildTopologyEdges = (ctx: GraphContext, view: LaneViewState): TopologyEdgeResult => {
    const edges: TopologyEdge[] = [];
    const edgeKeys = new Set<string>();
    const unresolved: UnresolvedEdge[] = [];

    const sink = {
        edge: (source: string | undefined, target: string | undefined) => {
            if (!source || !target) return;
            const key = `${source}=>${target}`;
            if (edgeKeys.has(key)) return;
            edgeKeys.add(key);
            edges.push({ source, target });
        },
        named: (
            rule: string,
            from: string,
            reference: string | undefined,
            direction: 'to' | 'from'
        ) => {
            if (!reference) return;
            const target = resolveInterfaceRef(reference, ctx);
            if (!target) {
                if (!KNOWN_UNREPORTED_CONTROLLERS.has(reference)) {
                    unresolved.push({ rule, reference, from });
                }
                return;
            }
            if (direction === 'to') sink.edge(from, target);
            else sink.edge(target, from);
        }
    };

    NODE_TYPES.forEach((descriptor) => {
        if (!descriptor.edges) return;
        // A hidden lane contributes no edges, so path highlighting cannot walk into
        // nodes that are not drawn.
        visibleItems(ctx, view, descriptor).forEach((item) => descriptor.edges!(item, ctx, sink));
    });

    return { edges, unresolved };
};
