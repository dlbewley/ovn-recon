import { ClusterLogicalTopology, LogicalTopologySnapshot, SnapshotSection } from '../types';

// The collector is reachable through several console proxy shapes depending
// on console version and plugin proxy configuration; try each in order.
const COLLECTOR_PROXY_PREFIXES = [
    '/api/plugins/ovn-recon/api/v1/snapshots',
    '/api/plugins/ovn-recon/backend/api/v1/snapshots',
    '/api/proxy/plugin/ovn-recon/backend/api/v1/snapshots',
    '/api/proxy/plugin/ovn-recon/api/v1/snapshots',
];

// Only one prefix ever works on a given console; remember it so later
// requests skip the two or three guaranteed failures.
let lastWorkingPrefix: string | null = null;

const orderedPrefixes = (): string[] =>
    lastWorkingPrefix
        ? [lastWorkingPrefix, ...COLLECTOR_PROXY_PREFIXES.filter((prefix) => prefix !== lastWorkingPrefix)]
        : [...COLLECTOR_PROXY_PREFIXES];

const fetchFirst = async <T>(buildUrl: (prefix: string) => string): Promise<T> => {
    const attempts: string[] = [];

    for (const prefix of orderedPrefixes()) {
        const url = buildUrl(prefix);
        try {
            const response = await fetch(url, {
                headers: {
                    Accept: 'application/json',
                },
            });

            if (!response.ok) {
                attempts.push(`${url} -> HTTP ${response.status}`);
                continue;
            }

            const payload = await response.json() as T;
            lastWorkingPrefix = prefix;
            return payload;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            attempts.push(`${url} -> ${message}`);
        }
    }

    throw new Error(`Collector request failed. Attempts: ${attempts.join('; ')}`);
};

export interface SnapshotFetchOptions {
    /**
     * Optional sections to add to the response. Omitted or empty requests the
     * ladder payload, which is what the topology pages fetch; the sections
     * are megabytes on a real cluster, so only the views that render them ask.
     */
    include?: readonly SnapshotSection[];
}

/** Sections deduplicated and sorted, so equal requests are spelled the same. */
export const normalizeSections = (include?: readonly SnapshotSection[]): SnapshotSection[] =>
    Array.from(new Set(include ?? [])).sort();

/**
 * The include query string, or '' when no section is requested: the same
 * request always produces the same URL.
 */
export const includeQuery = (include?: readonly SnapshotSection[]): string => {
    const sections = normalizeSections(include);
    return sections.length > 0 ? `?include=${sections.join(',')}` : '';
};

export const fetchCollectorSnapshot = (
    nodeName: string,
    options: SnapshotFetchOptions = {},
): Promise<LogicalTopologySnapshot> => {
    const encodedNodeName = encodeURIComponent(nodeName);
    const query = includeQuery(options.include);
    return fetchFirst((prefix) => `${prefix}/${encodedNodeName}${query}`);
};

/**
 * The aggregate carries one snapshot per zone, and the optional sections are
 * near-identical in every zone, so the cluster views fetch it without
 * `include` and read section data from one representative node's snapshot.
 */
export const fetchClusterTopology = (options: SnapshotFetchOptions = {}): Promise<ClusterLogicalTopology> => {
    const query = includeQuery(options.include);
    return fetchFirst((prefix) => `${prefix}${query}`);
};
