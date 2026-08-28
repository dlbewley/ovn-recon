import { ClusterLogicalTopology, LogicalTopologySnapshot } from '../types';

// The collector is reachable through several console proxy shapes depending
// on console version and plugin proxy configuration; try each in order.
const COLLECTOR_PROXY_PREFIXES = [
    '/api/plugins/ovn-recon/api/v1/snapshots',
    '/api/plugins/ovn-recon/backend/api/v1/snapshots',
    '/api/proxy/plugin/ovn-recon/backend/api/v1/snapshots',
    '/api/proxy/plugin/ovn-recon/api/v1/snapshots',
];

const fetchFirst = async <T>(paths: string[]): Promise<T> => {
    const attempts: string[] = [];

    for (const url of paths) {
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

            return await response.json() as T;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            attempts.push(`${url} -> ${message}`);
        }
    }

    throw new Error(`Collector request failed. Attempts: ${attempts.join('; ')}`);
};

export const fetchCollectorSnapshot = (nodeName: string): Promise<LogicalTopologySnapshot> => {
    const encodedNodeName = encodeURIComponent(nodeName);
    return fetchFirst(COLLECTOR_PROXY_PREFIXES.map((prefix) => `${prefix}/${encodedNodeName}`));
};

export const fetchClusterTopology = (): Promise<ClusterLogicalTopology> =>
    fetchFirst(COLLECTOR_PROXY_PREFIXES);
