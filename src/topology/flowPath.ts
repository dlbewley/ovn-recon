import { TopologyEdge } from '../components/nodeVisualizationModel';
import { edgeKey } from './ids';
import { Graph } from './types';

/**
 * The flow path lit when a node is selected: everything upstream of it and
 * everything downstream, with the edges between.
 *
 * Lifted out of the component so the walk can be tested against edge lists
 * directly (ovn-recon-2h2). The walk is by connectivity, not by edge kind: a
 * reference edge carries no traffic but still says which networks ride on a
 * bridge, and that is what a user selecting the bridge wants to see.
 */

/** Adjacency from the edge list; direction follows the edges, upstream is source-ward. */
export const buildFlowGraph = (edges: TopologyEdge[]): Graph => {
    const g: Graph = { nodes: {} };
    const addNode = (id: string) => {
        if (!g.nodes[id]) g.nodes[id] = { id, upstream: [], downstream: [] };
    };
    edges.forEach(({ source, target }) => {
        addNode(source);
        addNode(target);
        if (!g.nodes[source].downstream.includes(target)) g.nodes[source].downstream.push(target);
        if (!g.nodes[target].upstream.includes(source)) g.nodes[target].upstream.push(source);
    });
    return g;
};

/**
 * Node ids and edge keys on the path through `startNodeId`.
 *
 * An opaque node (see NodeTypeDescriptor.opaque) is entered and lit, but the walk
 * stops there: what it forwards between its ports is not something this graph
 * knows. The start node is never opaque to its own selection -- selecting br-int
 * lights every port and patch it has.
 */
export const flowPath = (graph: Graph, startNodeId: string, opaque: Set<string> = new Set()): Set<string> => {
    const path = new Set<string>();
    const visited = new Set<string>();

    const traverse = (nodeId: string, direction: 'upstream' | 'downstream') => {
        if (visited.has(nodeId)) return;
        visited.add(nodeId);
        path.add(nodeId);
        if (nodeId !== startNodeId && opaque.has(nodeId)) return;

        const node = graph.nodes[nodeId];
        if (!node) return;

        const nextNodes = direction === 'upstream' ? node.upstream : node.downstream;
        nextNodes.forEach((nextId) => {
            // One key per edge: edgeKey normalises direction.
            path.add(edgeKey(nodeId, nextId));
            traverse(nextId, direction);
        });
    };

    traverse(startNodeId, 'upstream');
    visited.clear(); // Overlap between the two directions is allowed.
    traverse(startNodeId, 'downstream');

    return path;
};
