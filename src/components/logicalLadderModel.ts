import { LogicalDatabase, NATRow, StaticRouteRow } from '../types';
import {
    ClassifiedConstruct,
    ClassifiedPort,
    classifyDatabase,
    classifySwitchPort,
} from './logicalClassification';

/**
 * Graph model for the ladder view: classified constructs (routers/switches)
 * plus the edges between them, derived from NB port linkage.
 *
 * Pod-scale switch ports never become graph nodes. They aggregate onto their
 * owning switch (podPortCount, managementPort, localnetPorts, remotePeers),
 * per the kck.1 decision that the drawer lists ports on demand.
 */

export interface LadderConstruct extends ClassifiedConstruct {
    /** Host subnet from other_config, when the switch declares one. */
    subnet?: string;
    /** Workload (pod) ports attached to this switch. */
    podPortCount: number;
    /** The workload ports themselves, for the drawer's searchable list. */
    podPorts: ClassifiedPort[];
    /** Name of the k8s management port, when present. */
    managementPort?: string;
    /** Localnet port names: the seam to a physical bridge mapping. */
    localnetPorts: string[];
    /** Peer nodes reachable through remote ports (transit switches). */
    remotePeers: string[];
    /** NAT and static route rule counts on a router. */
    natCount: number;
    staticRouteCount: number;
    /** The rules themselves, resolved from the router's uuid references. */
    natRules: NATRow[];
    staticRouteRules: StaticRouteRow[];
}

export type LadderEdgeKind = 'router-link' | 'router-peer';

/**
 * The function of an edge, decoded from OVN-Kubernetes router port naming:
 * rtoj- (router to join), rtoe- (router to external), rtos-/trtos- (router
 * to workload switch — the subnet gateway address), rtots- (router to
 * transit switch — the tunnel address), rtotr-/trtor- (peered routers —
 * interconnect). Gives the address labels a readable purpose.
 */
export type LadderEdgeRole = 'join' | 'external' | 'gateway' | 'tunnel' | 'interconnect' | 'link';

export interface LadderEdge {
    id: string;
    /** Construct uuids. */
    source: string;
    target: string;
    kind: LadderEdgeKind;
    role: LadderEdgeRole;
    /**
     * Addresses on the router side of a router-link, or on the source router's
     * port of a router-peer.
     */
    networks: string[];
    /** Addresses on the target router's port of a router-peer. */
    peerNetworks?: string[];
}

const edgeRoleForRouterPort = (portName: string): LadderEdgeRole => {
    if (portName.startsWith('rtoj-')) return 'join';
    if (portName.startsWith('rtoe-')) return 'external';
    if (portName.startsWith('rtos-') || portName.startsWith('trtos-')) return 'gateway';
    if (portName.startsWith('rtots-')) return 'tunnel';
    return 'link';
};

export interface LadderModel {
    constructs: LadderConstruct[];
    constructByUuid: Map<string, LadderConstruct>;
    edges: LadderEdge[];
    /** Network identities present, DEFAULT_NETWORK first. */
    networks: string[];
}

export const buildLadderModel = (database: LogicalDatabase): LadderModel => {
    const classified = classifyDatabase(database);

    const switchPortByUuid = new Map(database.logicalSwitchPorts.map((port) => [port.uuid, port]));
    const routerPortByName = new Map(database.logicalRouterPorts.map((port) => [port.name, port]));

    const routerUuidByPortUuid = new Map<string, string>();
    for (const router of database.logicalRouters) {
        for (const portUuid of router.ports) {
            routerUuidByPortUuid.set(portUuid, router.uuid);
        }
    }

    const constructs: LadderConstruct[] = [];
    const constructByUuid = new Map<string, LadderConstruct>();

    for (const construct of classified.constructs) {
        const ladderConstruct: LadderConstruct = {
            ...construct,
            podPortCount: 0,
            podPorts: [],
            localnetPorts: [],
            remotePeers: [],
            natCount: 0,
            staticRouteCount: 0,
            natRules: [],
            staticRouteRules: [],
        };
        constructs.push(ladderConstruct);
        constructByUuid.set(construct.uuid, ladderConstruct);
    }

    const natByUuid = new Map(database.nats.map((nat) => [nat.uuid, nat]));
    const routeByUuid = new Map(database.staticRoutes.map((route) => [route.uuid, route]));

    for (const router of database.logicalRouters) {
        const construct = constructByUuid.get(router.uuid);
        if (!construct) continue;
        construct.natRules = (router.nat ?? [])
            .map((uuid) => natByUuid.get(uuid))
            .filter((nat): nat is NATRow => nat != null);
        construct.staticRouteRules = (router.staticRoutes ?? [])
            .map((uuid) => routeByUuid.get(uuid))
            .filter((route): route is StaticRouteRow => route != null);
        construct.natCount = construct.natRules.length;
        construct.staticRouteCount = construct.staticRouteRules.length;
    }

    const edges: LadderEdge[] = [];
    const seenEdgeIds = new Set<string>();
    const addEdge = (edge: LadderEdge) => {
        if (seenEdgeIds.has(edge.id)) return;
        seenEdgeIds.add(edge.id);
        edges.push(edge);
    };

    for (const logicalSwitch of database.logicalSwitches) {
        const construct = constructByUuid.get(logicalSwitch.uuid);
        if (!construct) continue;

        construct.subnet = logicalSwitch.otherConfig?.subnet;

        for (const portUuid of logicalSwitch.ports) {
            const row = switchPortByUuid.get(portUuid);
            if (!row) continue;
            const port = classifySwitchPort(row);

            switch (port.role) {
                case 'pod-port':
                    construct.podPortCount += 1;
                    construct.podPorts.push(port);
                    break;
                case 'management-port':
                    construct.managementPort = port.name;
                    break;
                case 'localnet-port':
                    construct.localnetPorts.push(port.name);
                    break;
                case 'remote-port':
                    if (port.node) construct.remotePeers.push(port.node);
                    break;
                case 'router-link-port': {
                    const routerPortName = row.options?.['router-port'];
                    const routerPort = routerPortName ? routerPortByName.get(routerPortName) : undefined;
                    const routerUuid = routerPort ? routerUuidByPortUuid.get(routerPort.uuid) : undefined;
                    if (routerUuid && constructByUuid.has(routerUuid)) {
                        addEdge({
                            id: `link:${logicalSwitch.uuid}:${routerUuid}`,
                            source: logicalSwitch.uuid,
                            target: routerUuid,
                            kind: 'router-link',
                            role: edgeRoleForRouterPort(routerPort?.name ?? ''),
                            networks: routerPort?.networks ?? [],
                        });
                    }
                    break;
                }
                default:
                    break;
            }
        }

        construct.remotePeers.sort();
        construct.localnetPorts.sort();
        construct.podPorts.sort((a, b) => a.name.localeCompare(b.name));
    }

    // Router-to-router adjacency travels as peered router ports (e.g. a UDN
    // gateway router peering with its network's transit router).
    for (const port of database.logicalRouterPorts) {
        if (!port.peer) continue;
        const peerPort = routerPortByName.get(port.peer);
        if (!peerPort) continue;

        const sourceRouter = routerUuidByPortUuid.get(port.uuid);
        const targetRouter = routerUuidByPortUuid.get(peerPort.uuid);
        if (!sourceRouter || !targetRouter || sourceRouter === targetRouter) continue;

        // Each peering appears twice (once per port); keep one edge with a
        // direction-independent id, preserving which networks sit on which end.
        const [first, second] = [sourceRouter, targetRouter].sort();
        const flipped = first !== sourceRouter;
        addEdge({
            id: `peer:${first}:${second}`,
            source: first,
            target: second,
            kind: 'router-peer',
            role: 'interconnect',
            networks: (flipped ? peerPort.networks : port.networks) ?? [],
            peerNetworks: (flipped ? port.networks : peerPort.networks) ?? [],
        });
    }

    return {
        constructs,
        constructByUuid,
        edges,
        networks: classified.networks,
    };
};
