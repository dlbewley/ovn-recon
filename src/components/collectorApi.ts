import { ClusterLogicalTopology, LogicalTopologySnapshot, SnapshotSection } from '../types';

// The collector is reachable through several console proxy shapes depending
// on console version and plugin proxy configuration; try each in order. Each
// entry is the collector's /api/v1 root as seen through that shape.
//
// On a default install only the first works: the console's plugin ASSET
// handler forwards the request to the plugin's own nginx, which proxies
// /api/v1/ to the collector. That handler forwards the request PATH only and
// drops the query string, so nothing the collector needs may travel in a
// query parameter (ovn-recon-e2b.12).
const COLLECTOR_PROXY_PREFIXES = [
    '/api/plugins/ovn-recon/api/v1',
    '/api/plugins/ovn-recon/backend/api/v1',
    '/api/proxy/plugin/ovn-recon/backend/api/v1',
    '/api/proxy/plugin/ovn-recon/api/v1',
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
 * The path segment that selects optional sections, or '' when none is
 * requested: `/sections/policy,services`. The same request always produces
 * the same URL.
 *
 * Sections travel in the path, not as `?include=`, because the console drops
 * query strings on the way to the collector (see COLLECTOR_PROXY_PREFIXES).
 * The collector serves both spellings identically.
 */
export const sectionsPath = (include?: readonly SnapshotSection[]): string => {
    const sections = normalizeSections(include);
    return sections.length > 0 ? `/sections/${sections.join(',')}` : '';
};

export const fetchCollectorSnapshot = (
    nodeName: string,
    options: SnapshotFetchOptions = {},
): Promise<LogicalTopologySnapshot> => {
    const encodedNodeName = encodeURIComponent(nodeName);
    const sections = sectionsPath(options.include);
    return fetchFirst((prefix) => `${prefix}${sections}/snapshots/${encodedNodeName}`);
};

/**
 * The aggregate carries one snapshot per zone, and the optional sections are
 * near-identical in every zone, so the cluster views fetch it without
 * `include` and read section data from one representative node's snapshot.
 */
export const fetchClusterTopology = (options: SnapshotFetchOptions = {}): Promise<ClusterLogicalTopology> => {
    const sections = sectionsPath(options.include);
    return fetchFirst((prefix) => `${prefix}${sections}/snapshots`);
};
