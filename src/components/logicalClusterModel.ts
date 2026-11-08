import { LogicalTopologySnapshot, NATRow, StaticRouteRow } from '../types';
import { DEFAULT_NETWORK } from './logicalClassification';
import {
    buildLadderModel,
    LadderConstruct,
    LadderEdge,
    LadderModel,
    LadderPort,
    switchPortTypeLabel,
} from './logicalLadderModel';

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
 * - podPorts/ports: union by port name; the first zone's row is kept (a
 *   transit port tstor-<node> is a router port in its own zone and a remote
 *   port elsewhere, so its type reflects whichever zone came first).
 * - remotePeers/localnetPorts: set union.
 * - natCount/staticRouteCount: max — per-zone instances of a distributed
 *   router carry near-identical rule sets; summing would multiply them.
 * - policy/load balancer/ACL/QoS reference counts: max, for the same reason.
 * - gatewayPorts: union by port name — a distributed gateway port is one
 *   port hosted on one chassis, replicated into every zone's database.
 * - enabled: false if any zone says so, else the first value seen.
 * - subnet/managementPort/node: first non-empty wins.
 */

export interface ClusterLadderModel extends LadderModel {
    constructs: ClusterLadderConstruct[];
    constructByUuid: Map<string, ClusterLadderConstruct>;
    /** Zone (node) names contributing to each merged construct, by uuid. */
    zonesByUuid: Map<string, string[]>;
    zoneCount: number;
}

export interface ClusterLadderConstruct extends LadderConstruct {
    zones: string[];
}

// Identity across zones is (kind, network, name): OVN names are already
// unique per network, and including the network keeps same-named
// bridge-mapping constructs (e.g. 'physnet') in different bands distinct.
const constructKey = (construct: LadderConstruct): string =>
    `${construct.kind}:${construct.network}:${construct.name}`;

// Per-zone instances of a distributed router carry near-identical rule sets
// under different UUIDs; identity across zones is the rule's semantic content.
const natRuleKey = (nat: NATRow): string =>
    [nat.type, nat.externalIp ?? '', nat.logicalIp ?? '', nat.logicalPort ?? ''].join('|');

const staticRouteKey = (route: StaticRouteRow): string =>
    [route.ipPrefix, route.nexthop ?? '', route.policy ?? '', route.outputPort ?? ''].join('|');

const mergeBy = <T>(existing: T[], incoming: T[], keyOf: (item: T) => string): T[] => {
    const seen = new Set(existing.map(keyOf));
    const merged = [...existing];
    for (const item of incoming) {
        const key = keyOf(item);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
    }
    return merged;
};

const compareMergedPorts = (a: LadderPort, b: LadderPort): number =>
    switchPortTypeLabel(a.row).localeCompare(switchPortTypeLabel(b.row)) || a.name.localeCompare(b.name);

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
            existing.podPorts = mergeBy(existing.podPorts, construct.podPorts, (port) => port.name);
            existing.ports = mergeBy(existing.ports, construct.ports, (port) => port.name).sort(compareMergedPorts);
            existing.remotePeers = [...new Set([...existing.remotePeers, ...construct.remotePeers])].sort();
            existing.localnetPorts = [...new Set([...existing.localnetPorts, ...construct.localnetPorts])].sort();
            existing.natRules = mergeBy(existing.natRules, construct.natRules, natRuleKey);
            existing.staticRouteRules = mergeBy(existing.staticRouteRules, construct.staticRouteRules, staticRouteKey);
            existing.natCount = existing.natRules.length;
            existing.staticRouteCount = existing.staticRouteRules.length;
            existing.policyCount = Math.max(existing.policyCount, construct.policyCount);
            existing.loadBalancerCount = Math.max(existing.loadBalancerCount, construct.loadBalancerCount);
            existing.loadBalancerGroupCount = Math.max(existing.loadBalancerGroupCount, construct.loadBalancerGroupCount);
            existing.aclCount = Math.max(existing.aclCount, construct.aclCount);
            existing.qosRuleCount = Math.max(existing.qosRuleCount, construct.qosRuleCount);
            existing.gatewayPorts = mergeBy(existing.gatewayPorts, construct.gatewayPorts, (placement) => placement.port);
            existing.enabled =
                existing.enabled === false || construct.enabled === false ? false : existing.enabled ?? construct.enabled;
            existing.subnet = existing.subnet ?? construct.subnet;
            existing.bridge = existing.bridge ?? construct.bridge;
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
