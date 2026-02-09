import { Interface } from '../types';
import { TopologyEdge } from './nodeVisualizationModel';

interface ComputeGravityByIdParams {
    topologyEdges: TopologyEdge[];
    interfaces: Interface[];
    physicalNodeIds: Set<string>;
    importantNodes?: Set<string>;
}

const buildConnectionGraph = (topologyEdges: TopologyEdge[]): Record<string, string[]> => {
    const connectionGraph: Record<string, string[]> = {};
    const addConnectionEdge = (source: string, target: string) => {
        if (!connectionGraph[source]) connectionGraph[source] = [];
        if (!connectionGraph[target]) connectionGraph[target] = [];
        if (!connectionGraph[source].includes(target)) connectionGraph[source].push(target);
        if (!connectionGraph[target].includes(source)) connectionGraph[target].push(source);
    };

    topologyEdges.forEach((edge) => addConnectionEdge(edge.source, edge.target));
    return connectionGraph;
};

export const computeGravityById = ({
    topologyEdges,
    interfaces,
    physicalNodeIds,
    importantNodes = new Set<string>(['br-ex'])
}: ComputeGravityByIdParams): Record<string, number> => {
    const connectionGraph = buildConnectionGraph(topologyEdges);

    const findLongestPath = (startNode: string, visited: Set<string> = new Set(), path: string[] = []): string[] => {
        if (visited.has(startNode)) return path;
        visited.add(startNode);
        const currentPath = [...path, startNode];
        const neighbors = connectionGraph[startNode] || [];

        if (neighbors.length === 0) {
            return currentPath;
        }

        let longestPath = currentPath;
        for (const neighbor of neighbors) {
            if (!currentPath.includes(neighbor)) {
                const subPath = findLongestPath(neighbor, new Set(visited), currentPath);
                if (subPath.length > longestPath.length) {
                    longestPath = subPath;
                }
            }
        }

        return longestPath;
    };

    const allPaths: string[][] = [];
    physicalNodeIds.forEach((nodeId) => {
        if (connectionGraph[nodeId]) {
            const path = findLongestPath(nodeId);
            if (path.length >= 2) {
                allPaths.push(path);
            }
        }
    });

    const pathsWithImportantNodes = new Set<number>();
    allPaths.forEach((path, pathIndex) => {
        if (path.some((nodeId) => importantNodes.has(nodeId))) {
            pathsWithImportantNodes.add(pathIndex);
        }
    });

    const pathMetadata = allPaths.map((path, index) => ({
        path,
        index,
        hasImportantNode: pathsWithImportantNodes.has(index),
        length: path.length
    }));

    pathMetadata.sort((a, b) => {
        if (a.hasImportantNode !== b.hasImportantNode) {
            return a.hasImportantNode ? -1 : 1;
        }
        return b.length - a.length;
    });

    const gravityById: Record<string, number> = {};
    const pathMembership: Record<string, { pathLength: number; position: number; hasImportantNode: boolean }[]> = {};

    pathMetadata.forEach((meta) => {
        const pathLength = meta.path.length;
        const hasImportantNode = meta.hasImportantNode;
        meta.path.forEach((nodeId, position) => {
            if (!pathMembership[nodeId]) {
                pathMembership[nodeId] = [];
            }
            pathMembership[nodeId].push({ pathLength, position, hasImportantNode });
        });
    });

    Object.keys(pathMembership).forEach((nodeId) => {
        const memberships = pathMembership[nodeId];
        const bestPath = memberships.reduce((best, current) => {
            if (current.hasImportantNode && !best.hasImportantNode) return current;
            if (!current.hasImportantNode && best.hasImportantNode) return best;
            if (current.pathLength > best.pathLength) return current;
            if (current.pathLength < best.pathLength) return best;
            return current.position < best.position ? current : best;
        });
        const importantBonus = bestPath.hasImportantNode ? 500 : 0;
        const pathGravity = 1000 - (bestPath.pathLength * 100) - bestPath.position - importantBonus;
        gravityById[nodeId] = pathGravity;
    });

    Object.keys(connectionGraph).forEach((nodeId) => {
        if (!gravityById[nodeId]) {
            const connectionCount = connectionGraph[nodeId]?.length || 0;
            gravityById[nodeId] = 10000 + connectionCount;
        }
    });

    const nodesInImportantPath = new Set<string>();
    const findImportantPathNodes = (nodeId: string, visited: Set<string> = new Set(), depth = 0) => {
        if (visited.has(nodeId) || depth > 5) return;
        visited.add(nodeId);
        nodesInImportantPath.add(nodeId);

        const neighbors = connectionGraph[nodeId] || [];
        neighbors.forEach((neighbor) => {
            if (!visited.has(neighbor)) {
                findImportantPathNodes(neighbor, new Set(visited), depth + 1);
            }
        });
    };

    importantNodes.forEach((nodeId) => {
        nodesInImportantPath.add(nodeId);
        if (connectionGraph[nodeId]) {
            findImportantPathNodes(nodeId);
        }
    });

    const physicalInterfacesSlaveToImportantNode = new Set<string>();
    interfaces.forEach((iface) => {
        const master = iface.controller || iface.master;
        if (master && importantNodes.has(master)) {
            physicalInterfacesSlaveToImportantNode.add(iface.name);
        }
    });

    physicalInterfacesSlaveToImportantNode.forEach((ifaceName) => {
        gravityById[ifaceName] = 25;
    });

    nodesInImportantPath.forEach((nodeId) => {
        if (importantNodes.has(nodeId)) {
            if (!physicalInterfacesSlaveToImportantNode.has(nodeId)) {
                gravityById[nodeId] = 50;
            }
        } else if (physicalInterfacesSlaveToImportantNode.has(nodeId)) {
            return;
        } else if (gravityById[nodeId] && gravityById[nodeId] >= 10000) {
            gravityById[nodeId] = Math.max(0, gravityById[nodeId] - 5000);
        } else if (gravityById[nodeId] && gravityById[nodeId] >= 1000) {
            gravityById[nodeId] = Math.max(0, gravityById[nodeId] - 500);
        } else if (gravityById[nodeId] && gravityById[nodeId] >= 100) {
            gravityById[nodeId] = Math.max(0, gravityById[nodeId] - 50);
        } else if (!gravityById[nodeId]) {
            gravityById[nodeId] = 200;
        }
    });

    Object.keys(gravityById)
        .filter((id) => id.startsWith('udn-'))
        .forEach((id) => {
            gravityById[id] = (gravityById[id] ?? 10000) + 50000;
        });

    return gravityById;
};

export const sortByGravity = <T,>(items: T[], getId: (item: T) => string, gravityById: Record<string, number>): T[] =>
    items.slice().sort((a, b) => {
        const aId = getId(a);
        const bId = getId(b);
        const gravityDiff = (gravityById[aId] || 10000) - (gravityById[bId] || 10000);
        if (gravityDiff !== 0) return gravityDiff;
        return aId.localeCompare(bId);
    });
