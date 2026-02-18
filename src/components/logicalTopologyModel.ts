import { LogicalTopologyEdge, LogicalTopologyNode, LogicalTopologySnapshot } from '../types';

export interface Point {
    x: number;
    y: number;
}

export type SnapshotFreshnessState = 'fresh' | 'warning' | 'critical' | 'unknown';

const KIND_ORDER = ['logical_router', 'logical_switch', 'logical_switch_port'];

const STALE_WARNING_MS = 2 * 60 * 1000;
const STALE_CRITICAL_MS = 10 * 60 * 1000;

export const layoutLogicalNodes = (nodes: LogicalTopologyNode[]): Record<string, Point> => {
    const kinds = Array.from(new Set(nodes.map((node) => node.kind))).sort((a, b) => {
        const aIndex = KIND_ORDER.indexOf(a);
        const bIndex = KIND_ORDER.indexOf(b);
        if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
        if (aIndex === -1) return 1;
        if (bIndex === -1) return -1;
        return aIndex - bIndex;
    });

    const byKind = kinds.reduce((acc, kind) => {
        acc[kind] = nodes.filter((node) => node.kind === kind).sort((a, b) => a.label.localeCompare(b.label));
        return acc;
    }, {} as Record<string, LogicalTopologyNode[]>);

    const positions: Record<string, Point> = {};
    kinds.forEach((kind, kindIndex) => {
        byKind[kind].forEach((node, nodeIndex) => {
            const subColumn = Math.floor(nodeIndex / 12);
            const row = nodeIndex % 12;
            positions[node.id] = {
                x: 160 + (kindIndex * 420) + (subColumn * 180),
                y: 120 + row * 110,
            };
        });
    });

    return positions;
};

export const filterLogicalNodes = (
    snapshot: LogicalTopologySnapshot | null,
    search: string,
    kindFilter: string,
): LogicalTopologyNode[] => {
    if (!snapshot) return [];

    const query = search.trim().toLowerCase();
    return snapshot.nodes.filter((node) => {
        const matchesKind = kindFilter === 'all' || node.kind === kindFilter;
        const matchesSearch = query === ''
            || node.label.toLowerCase().includes(query)
            || node.id.toLowerCase().includes(query)
            || node.kind.toLowerCase().includes(query);
        return matchesKind && matchesSearch;
    });
};

export const filterLogicalEdges = (
    snapshot: LogicalTopologySnapshot | null,
    visibleNodeIds: Set<string>,
): LogicalTopologyEdge[] => {
    if (!snapshot) return [];
    return snapshot.edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target));
};

export const logicalNodeKinds = (snapshot: LogicalTopologySnapshot | null): string[] => {
    if (!snapshot) return [];
    return Array.from(new Set(snapshot.nodes.map((node) => node.kind))).sort();
};

export const parseSnapshotAgeMs = (generatedAt: string): number | null => {
    const generated = new Date(generatedAt).getTime();
    if (Number.isNaN(generated)) return null;
    return Math.max(0, Date.now() - generated);
};

export const freshnessFromAge = (ageMs: number | null): SnapshotFreshnessState => {
    if (ageMs == null) return 'unknown';
    if (ageMs >= STALE_CRITICAL_MS) return 'critical';
    if (ageMs >= STALE_WARNING_MS) return 'warning';
    return 'fresh';
};
