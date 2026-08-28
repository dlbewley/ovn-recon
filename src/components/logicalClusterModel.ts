import { LogicalTopologySnapshot } from '../types';
import { DEFAULT_NETWORK } from './logicalClassification';
import { buildLadderModel, LadderConstruct, LadderEdge, LadderModel } from './logicalLadderModel';

/**
 * Semantic merge of per-node zone snapshots into one cluster ladder model.
 *
 * Under OVN interconnect every node runs its own NB database, so shared
 * constructs (the transit switch, distributed cluster routers, a Layer2
 * network's cluster-wide switch) appear once per zone with different UUIDs
 * but identical names. Identity across zones is therefore (kind, name) —
 * exactly the name-based association rule classification already relies on.
 *
 * Merge rules per construct:
 * - zones: every zone the construct appears in (provenance).
 * - podPortCount: summed — each zone's switch instance holds only that
 *   zone's local workload ports, so the sum is the cluster total.
 * - remotePeers/localnetPorts: set union.
 * - natCount/staticRouteCount: max — per-zone instances of a distributed
 *   router carry near-identical rule sets; summing would multiply them.
 * - subnet/managementPort/node: first non-empty wins.
 */

export interface ClusterLadderModel extends LadderModel {
    constructs: ClusterLadderConstruct[];
    /** Zone (node) names contributing to each merged construct, by uuid. */
    zonesByUuid: Map<string, string[]>;
    zoneCount: number;
}

export interface ClusterLadderConstruct extends LadderConstruct {
    zones: string[];
}

const constructKey = (construct: LadderConstruct): string => `${construct.kind}:${construct.name}`;

const edgeKey = (kind: string, source: string, target: string): string => {
    const [first, second] = [source, target].sort();
    return `${kind}:${first}:${second}`;
};

export const mergeZones = (snapshots: LogicalTopologySnapshot[]): ClusterLadderModel => {
    const mergedByKey = new Map<string, ClusterLadderConstruct>();
    const mergedEdges = new Map<string, LadderEdge>();
    const networks: string[] = [DEFAULT_NETWORK];
    let zoneCount = 0;

    for (const snapshot of snapshots) {
        if (!snapshot.database) continue;
        zoneCount += 1;
        const zone = snapshot.metadata.nodeName || `zone-${zoneCount}`;
        const zoneModel = buildLadderModel(snapshot.database);

        for (const network of zoneModel.networks) {
            if (!networks.includes(network)) {
                networks.push(network);
            }
        }

        const canonicalUuidByZoneUuid = new Map<string, string>();
        for (const construct of zoneModel.constructs) {
            const key = constructKey(construct);
            canonicalUuidByZoneUuid.set(construct.uuid, key);

            const existing = mergedByKey.get(key);
            if (!existing) {
                mergedByKey.set(key, {
                    ...construct,
                    uuid: key,
                    zones: [zone],
                });
                continue;
            }

            existing.zones.push(zone);
            existing.podPortCount += construct.podPortCount;
            existing.remotePeers = [...new Set([...existing.remotePeers, ...construct.remotePeers])].sort();
            existing.localnetPorts = [...new Set([...existing.localnetPorts, ...construct.localnetPorts])].sort();
            existing.natCount = Math.max(existing.natCount, construct.natCount);
            existing.staticRouteCount = Math.max(existing.staticRouteCount, construct.staticRouteCount);
            existing.subnet = existing.subnet ?? construct.subnet;
            existing.managementPort = existing.managementPort ?? construct.managementPort;
            existing.node = existing.node ?? construct.node;
        }

        for (const edge of zoneModel.edges) {
            const source = canonicalUuidByZoneUuid.get(edge.source);
            const target = canonicalUuidByZoneUuid.get(edge.target);
            if (!source || !target) continue;
            const key = edgeKey(edge.kind, source, target);
            if (mergedEdges.has(key)) continue;
            mergedEdges.set(key, {
                ...edge,
                id: key,
                source,
                target,
            });
        }
    }

    const constructs = [...mergedByKey.values()];
    return {
        constructs,
        constructByUuid: new Map(constructs.map((construct) => [construct.uuid, construct])),
        edges: [...mergedEdges.values()],
        networks,
        zonesByUuid: new Map(constructs.map((construct) => [construct.uuid, construct.zones])),
        zoneCount,
    };
};
