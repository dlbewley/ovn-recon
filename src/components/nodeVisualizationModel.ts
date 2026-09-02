import { GraphContext } from '../topology/context';
import { NODE_TYPES } from '../topology/descriptors';
import { resolveInterfaceRef } from '../topology/ids';
import { LaneViewState, visibleItems } from '../topology/lanes';
import { Provenance } from '../topology/types';

/**
 * What an edge MEANS. The graph used to draw one kind of line for all of these, and the
 * columnar layout then added a fifth semantic nobody declared -- that column position is
 * position in a path. Membership edges violate that by pointing back at their container;
 * reference edges fabricate a hop that does not exist.
 *
 * The review named three kinds. There are four: LLDP does not fit any of them, because a
 * neighbour is neither part of the interface nor layered on it nor a name for it -- it is
 * the device at the other end of a cable. Forcing it into `layering` would have been
 * tidier and wrong.
 */
export type EdgeKind =
    /** The source is a port OF the target. `ens192` is a port of `br-ex`. */
    | 'membership'
    /** Traffic flows through. `ens224.456` is carried on `ens224`. */
    | 'layering'
    /** A name for the same thing, or a declaration about it. Nothing flows through. */
    | 'reference'
    /** Two devices at opposite ends of a physical link, on different nodes. */
    | 'peer';

/**
 * Everything an edge says about itself beyond its endpoints (ovn-recon-s3t.30).
 *
 * A line on the canvas used to be indistinguishable whether it came from
 * `controller: br-ex` or from a truncated-name guess. The sink now refuses an
 * edge that cannot explain itself, so every rule states what it means, how far
 * to trust it, and which fields it was read from -- per instance, not per rule.
 */
export interface EdgeMeaning {
    kind: EdgeKind;
    /** Same scale as a Fact's: read from reported state, asserted by a spec, or guessed. */
    provenance: Provenance;
    /** One sentence naming the fields this particular edge derives from. */
    rationale: string;
}

export interface TopologyEdge extends EdgeMeaning {
    source: string;
    target: string;
    /** The rule that produced it, e.g. 'controller'. A stable slug; detail belongs in rationale. */
    rule: string;
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
        edge: (
            source: string | undefined,
            target: string | undefined,
            rule: string,
            meaning: EdgeMeaning
        ) => {
            if (!source || !target) return;
            const key = `${source}=>${target}`;
            if (edgeKeys.has(key)) return;
            edgeKeys.add(key);
            edges.push({ source, target, rule, ...meaning });
        },
        named: (
            rule: string,
            from: string,
            reference: string | undefined,
            direction: 'to' | 'from',
            meaning: EdgeMeaning
        ) => {
            if (!reference) return;
            const target = resolveInterfaceRef(reference, ctx);
            if (!target) {
                if (!KNOWN_UNREPORTED_CONTROLLERS.has(reference)) {
                    unresolved.push({ rule, reference, from });
                }
                return;
            }
            if (direction === 'to') sink.edge(from, target, rule, meaning);
            else sink.edge(target, from, rule, meaning);
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
