import { ClusterLogicalTopology, LogicalTopologySnapshot } from '../types';

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

export const fetchCollectorSnapshot = (nodeName: string): Promise<LogicalTopologySnapshot> => {
    const encodedNodeName = encodeURIComponent(nodeName);
    return fetchFirst((prefix) => `${prefix}/${encodedNodeName}`);
};

export const fetchClusterTopology = (): Promise<ClusterLogicalTopology> =>
    fetchFirst((prefix) => prefix);
