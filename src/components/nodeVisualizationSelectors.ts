import { bridgeMappingNodeId, lldpNodeId } from '../topology/ids';
import { sha256Hex } from '../topology/sha256';
import { subnetCidrs } from '../topology/subnets';
import {
    ClusterUserDefinedNetwork,
    Interface,
    Ipv4AddressEntry,
    LabelSelector,
    NodeNetworkConfigurationEnactment,
    NodeNetworkState,
    NetworkAttachmentDefinition,
    RouteAdvertisements,
    UserDefinedNetwork,
    Vtep
} from '../types';

interface MatchExpression {
    key: string;
    operator: string;
    values?: string[];
}

export interface VrfConnectionInfo {
    brIntPorts: Interface[];
}

export interface VrfAssociatedRoute {
    destination: string;
    nextHopAddress?: string;
    nextHopInterface?: string;
    tableId?: string;
    metric?: string;
    protocol?: string;
}

/** An interface a VRF's own route table sends traffic out of. */
export interface VrfEgress {
    /** The next-hop interface named by the routes. */
    interfaceName: string;
    /** Destinations routed through it, default route first. */
    destinations: string[];
    /** The VRF's route table the routes were read from. */
    tableId: string;
}

export interface LldpNeighborNode {
    id: string;
    label: string;
    localInterface: string;
    neighborIndex: number;
    systemName?: string;
    portId?: string;
    chassisId?: string;
    systemDescription?: string;
    capabilities: string[];
    rawTlvs: Record<string, unknown>[];
}

/** True when the IPv4 address (with or without /len) lies inside the CIDR. */
export const ipv4InCidr = (address: string, cidr: string): boolean => {
    const toBits = (ip: string): number | null => {
        const octets = ip.split('.').map(Number);
        if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return null;
        return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
    };
    const [network, lenText] = cidr.split('/');
    const len = Number(lenText);
    const ipBits = toBits(address.split('/')[0]);
    const netBits = toBits(network);
    if (ipBits === null || netBits === null || Number.isNaN(len) || len < 0 || len > 32) return false;
    const mask = len === 0 ? 0 : (~0 << (32 - len)) >>> 0;
    return (ipBits & mask) === (netBits & mask);
};

/** Kernel IFNAMSIZ minus the NUL: the longest name a VRF interface can carry. */
const VRF_NAME_LIMIT = 15;

export interface PrimaryNetworkMatch {
    kind: 'cudn' | 'udn';
    name: string;
    namespace?: string;
    /**
     * Which signals matched, for the edge rule and the fact hint.
     * status      -- the network's own status.vrfName is this VRF. Declared.
     * network-id  -- the VRF is named mp<ID>-udn-vrf and a NAD of the network carries that ID.
     * name        -- the VRF carries the network's name.
     * subnet      -- a VRF port address lies inside the network's subnet. Corroboration only.
     */
    signals: ('status' | 'network-id' | 'subnet' | 'name')[];
    /**
     * The port address found inside one of the network's subnets, when one was.
     * Named so the edge rationale can cite the actual evidence (ovn-recon-s3t.30).
     */
    corroboration?: { port: string; address: string; subnet: string };
    /** The network ID read out of the VRF name, when the `network-id` signal matched. */
    networkId?: string;
    /** The NetworkAttachmentDefinition carrying that ID. */
    nad?: { namespace: string; name: string };
}

/**
 * The network ID in a VRF named `mp<ID>-udn-vrf` (ovn-recon-s3t.57).
 *
 * OVN-Kubernetes names a Primary network's VRF after the CUDN only when the CUDN's
 * name fits in a 15-character interface name; otherwise, and always for a namespaced
 * UDN, it falls back to this ID-derived form (go-controller/pkg/util/multi_network.go,
 * GetNetworkVRFName). Upstream never truncates a name to make it fit.
 */
export const parseNetworkIdFromVrfName = (vrfName: string | undefined): string | undefined =>
    /^mp(\d+)-udn-vrf$/.exec(vrfName ?? '')?.[1];

/**
 * The Primary Layer2/Layer3 network this VRF exists to serve (ovn-recon-s3t.28).
 *
 * A Primary UDN or CUDN creates a per-node VRF as a side effect; Localnet
 * networks can never be Primary and are excluded outright.
 *
 * AN IDENTIFYING SIGNAL IS REQUIRED, SUBNET ONLY CORROBORATES. Three things can
 * identify the network, strongest first (ovn-recon-s3t.57):
 *
 *   status      the network's status.vrfName is this VRF. Newer OVN-Kubernetes
 *               publishes it precisely so nobody has to derive the name.
 *   network-id  the VRF is named mp<ID>-udn-vrf -- the form used when the network's
 *               name does not fit in an interface name, and always for a namespaced
 *               UDN -- and a NetworkAttachmentDefinition of the network carries that
 *               ID. Needs the NADs; without them the ID says nothing.
 *   name        the VRF carries the network's name, verbatim or truncated to the
 *               kernel's 15-character limit.
 *
 * Subnets are NOT unique across UDNs/CUDNs -- networks map to OVS logical switches
 * uplinked to OVN routers that NAT overlapping ranges apart -- so a
 * subnet-containment match on its own could pick the wrong network. It serves only
 * to break ties when several long network names share a truncated prefix.
 */
export const findPrimaryNetworkForVrf = (
    vrf: Interface,
    cudns: ClusterUserDefinedNetwork[],
    udns: UserDefinedNetwork[],
    interfaces: Interface[],
    nads: NetworkAttachmentDefinition[] = []
): PrimaryNetworkMatch | undefined => {
    const portAddresses = getVrfConnectionInfo(vrf, interfaces)
        .brIntPorts.flatMap((port) => getIpv4Addresses(port).map((address) => ({ port: port.name, address })));

    const nameMatches = (name: string): boolean =>
        name === vrf.name || name.substring(0, VRF_NAME_LIMIT) === vrf.name;

    // The network whose ID the VRF name carries, when it carries one and exactly one
    // network claims it.
    const networkId = parseNetworkIdFromVrfName(vrf.name);
    const byId = networkId ? findNetworkByNetworkId(networkId, cudns, udns, nads) : undefined;
    const idMatches = (candidate: Candidate): boolean => {
        const network = byId?.network;
        if (!network || network.kind !== candidate.kind || network.name !== candidate.name) return false;
        return network.kind === 'cudn' || network.namespace === candidate.namespace;
    };

    interface Candidate {
        kind: 'cudn' | 'udn';
        name: string;
        namespace?: string;
        subnets: string[];
        /** status.vrfName, when the network publishes one. */
        vrfName?: string;
    }
    const candidates: Candidate[] = [
        ...cudns.flatMap((cudn): Candidate[] => {
            const network = cudn.spec?.network;
            const layer = network?.topology === 'Layer2' ? network.layer2
                : network?.topology === 'Layer3' ? network.layer3
                    : undefined;
            if (layer?.role !== 'Primary') return [];
            return [{
                kind: 'cudn',
                name: cudn.metadata?.name || '',
                subnets: subnetCidrs(layer.subnets),
                vrfName: cudn.status?.vrfName
            }];
        }),
        ...udns.flatMap((udn): Candidate[] => {
            const layer = udn.spec?.topology === 'Layer2' ? udn.spec.layer2
                : udn.spec?.topology === 'Layer3' ? udn.spec.layer3
                    : undefined;
            if (layer?.role !== 'Primary') return [];
            return [{
                kind: 'udn',
                name: udn.metadata?.name || '',
                namespace: udn.metadata?.namespace,
                subnets: subnetCidrs(layer.subnets),
                vrfName: udn.status?.vrfName
            }];
        })
    ];

    const matches = candidates
        .map((candidate): PrimaryNetworkMatch => {
            const corroboration = candidate.subnets
                .flatMap((subnet) => portAddresses
                    .filter(({ address }) => ipv4InCidr(address, subnet))
                    .map((hit) => ({ ...hit, subnet })))[0];
            const byNetworkId = idMatches(candidate);
            return {
                kind: candidate.kind,
                name: candidate.name,
                namespace: candidate.namespace,
                signals: [
                    ...(candidate.vrfName && candidate.vrfName === vrf.name ? ['status' as const] : []),
                    ...(byNetworkId ? ['network-id' as const] : []),
                    ...(corroboration ? ['subnet' as const] : []),
                    ...(nameMatches(candidate.name) ? ['name' as const] : [])
                ],
                ...(corroboration ? { corroboration } : {}),
                ...(byNetworkId
                    ? {
                        networkId,
                        nad: byId?.nad?.metadata?.name
                            ? { namespace: byId.nad.metadata.namespace || 'default', name: byId.nad.metadata.name }
                            : undefined
                    }
                    : {})
            };
        })
        // Something must identify the network; a subnet hit alone is not an association.
        .filter((match) => match.signals.some((signal) => signal !== 'subnet'));

    return matches.find((match) => match.signals.includes('status'))
        ?? matches.find((match) => match.signals.includes('network-id'))
        ?? matches.find((match) => match.signals.includes('subnet'))
        ?? matches[0];
};

/** One policy's claim on an interface or bridge mapping, from its enactment. */
export interface NncpClaim {
    policyName: string;
    /** The enactment's worst active condition: Failing beats Progressing beats Available. */
    status: 'Available' | 'Failing' | 'Progressing' | 'Unknown';
}

const enactmentPolicyName = (enactment: NodeNetworkConfigurationEnactment): string =>
    enactment.metadata?.labels?.['nmstate.io/policy']
    // Enactments are named <node>.<policy>; the label is the reliable source and
    // this is only the fallback for a stripped fixture.
    || (enactment.metadata?.name || '').split('.').slice(1).join('.');

const enactmentStatus = (enactment: NodeNetworkConfigurationEnactment): NncpClaim['status'] => {
    const isTrue = (type: string) =>
        enactment.status?.conditions?.some((c) => c.type === type && c.status === 'True');
    if (isTrue('Failing')) return 'Failing';
    if (isTrue('Progressing')) return 'Progressing';
    if (isTrue('Available')) return 'Available';
    return 'Unknown';
};

const toClaim = (enactment: NodeNetworkConfigurationEnactment): NncpClaim => ({
    policyName: enactmentPolicyName(enactment),
    status: enactmentStatus(enactment)
});

/**
 * The policies whose enactments on this node applied the named interface.
 * OBSERVED, not guessed: an enactment's desiredState is the record of what its
 * policy configured. More than one claim is a configuration overlap worth
 * flagging; zero claims (with enactments present) means the installer or
 * OVN-Kubernetes created it.
 */
export const getPoliciesClaimingInterface = (
    interfaceName: string,
    enactments: NodeNetworkConfigurationEnactment[]
): NncpClaim[] => enactments
    .filter((enactment) => (enactment.status?.desiredState?.interfaces || [])
        .some((iface) => iface.name === interfaceName))
    .map(toClaim);

export const getPoliciesClaimingBridgeMapping = (
    localnet: string,
    enactments: NodeNetworkConfigurationEnactment[]
): NncpClaim[] => enactments
    .filter((enactment) => (enactment.status?.desiredState?.ovn?.['bridge-mappings'] || [])
        .some((mapping) => mapping.localnet === localnet))
    .map(toClaim);

/**
 * A label selector in kubectl's set-based notation, e.g.
 * "network/machine=, tier in (web, api)". An empty selector matches everything,
 * which the caller should say in words rather than showing an empty string.
 */
export const formatLabelSelector = (selector: LabelSelector | undefined): string => {
    if (!selector) return '';
    const parts: string[] = [];
    Object.entries(selector.matchLabels || {}).forEach(([key, value]) => parts.push(`${key}=${value}`));
    (selector.matchExpressions || []).forEach((expr) => {
        const values = (expr.values || []).join(', ');
        switch (expr.operator) {
            case 'In': parts.push(`${expr.key} in (${values})`); break;
            case 'NotIn': parts.push(`${expr.key} notin (${values})`); break;
            case 'Exists': parts.push(expr.key); break;
            case 'DoesNotExist': parts.push(`!${expr.key}`); break;
            default: parts.push(`${expr.key} ${expr.operator.toLowerCase()} (${values})`);
        }
    });
    return parts.join(', ');
};

const matchesLabelSelector = (
    labels: Record<string, string>,
    matchLabels?: Record<string, string>,
    matchExpressions?: MatchExpression[]
): boolean => {
    if (matchLabels && !Object.entries(matchLabels).every(([key, value]) => labels[key] === value)) {
        return false;
    }

    if (!matchExpressions) {
        return true;
    }

    return matchExpressions.every((expr) => {
        const labelValue = labels[expr.key];
        const values = expr.values || [];

        if (expr.operator === 'In') return values.includes(labelValue);
        if (expr.operator === 'NotIn') return !values.includes(labelValue);
        if (expr.operator === 'Exists') return Object.prototype.hasOwnProperty.call(labels, expr.key);
        if (expr.operator === 'DoesNotExist') return !Object.prototype.hasOwnProperty.call(labels, expr.key);
        return false;
    });
};

export const routeAdvertisementSelectsCudn = (
    routeAdvertisement: RouteAdvertisements,
    cudn: ClusterUserDefinedNetwork
): boolean => {
    const topology = cudn.spec?.network?.topology;
    if (topology !== 'Layer2' && topology !== 'Layer3') {
        return false;
    }

    const cudnLabels = cudn.metadata?.labels || {};
    return (
        routeAdvertisement.spec?.networkSelectors?.some((selector) => {
            const selectorSpec = selector.clusterUserDefinedNetworkSelector?.networkSelector;
            if (!selectorSpec) return false;
            return matchesLabelSelector(cudnLabels, selectorSpec.matchLabels, selectorSpec.matchExpressions);
        }) || false
    );
};

export const getRouteAdvertisementsMatchingCudn = (
    routeAdvertisements: RouteAdvertisements[] | undefined,
    cudn: ClusterUserDefinedNetwork
): RouteAdvertisements[] => {
    if (!routeAdvertisements || routeAdvertisements.length === 0) {
        return [];
    }
    return routeAdvertisements.filter((ra) => routeAdvertisementSelectsCudn(ra, cudn));
};

export const findRouteAdvertisementForVrf = (
    routeAdvertisements: RouteAdvertisements[] | undefined,
    vrfName: string
): RouteAdvertisements | undefined => {
    if (!routeAdvertisements) {
        return undefined;
    }

    return routeAdvertisements.find((routeAdvertisement) => {
        const raName = routeAdvertisement.metadata?.name || '';
        const truncatedRaName = raName.substring(0, 15);
        return raName === vrfName || truncatedRaName === vrfName;
    });
};

export const getCudnsSelectedByRouteAdvertisement = (
    routeAdvertisement: RouteAdvertisements | undefined,
    cudns: ClusterUserDefinedNetwork[]
): ClusterUserDefinedNetwork[] => {
    if (!routeAdvertisement) {
        return [];
    }

    return cudns.filter((cudn) => routeAdvertisementSelectsCudn(routeAdvertisement, cudn));
};

/**
 * IPv4 addresses as display strings. nmstate emits `prefix-length`, but some
 * captures carry `prefix_length`; reading only one spelling renders "10.0.0.1/undefined".
 */
export const getIpv4Addresses = (iface: { ipv4?: { address?: Ipv4AddressEntry[] } } | undefined): string[] => {
    const addresses = iface?.ipv4?.address;
    if (!Array.isArray(addresses)) return [];
    return addresses
        .filter((entry) => entry && typeof entry.ip === 'string')
        .map((entry) => {
            const prefix = entry['prefix-length'] ?? entry.prefix_length;
            return prefix == null ? entry.ip : `${entry.ip}/${prefix}`;
        });
};

/**
 * The interface holding a given IPv4 address, when one does. Used to resolve a VXLAN
 * device's `vxlan.local` to the underlay interface that carries the tunnel. Returns the
 * first holder in NNS order; an address on two interfaces is a misconfiguration this
 * view does not try to adjudicate.
 */
export const findInterfaceHoldingAddress = (
    address: string | undefined,
    interfaces: Interface[]
): Interface | undefined => {
    if (!address) return undefined;
    return interfaces.find((iface) =>
        (iface.ipv4?.address ?? []).some((entry) => entry?.ip === address));
};

export const getVrfConnectionInfo = (
    vrfInterface: Interface,
    interfaces: Interface[]
): VrfConnectionInfo => {
    const vrfPorts = new Set<string>(
        Array.isArray(vrfInterface.vrf?.port)
            ? vrfInterface.vrf.port
            : typeof vrfInterface.vrf?.port === 'string'
                ? [vrfInterface.vrf.port]
                : []
    );

    const brIntCandidates = interfaces.filter((iface) => (iface.controller || iface.master) === 'br-int');
    const brIntPorts = brIntCandidates.filter((iface) => vrfPorts.has(iface.name));

    return { brIntPorts };
};

const toStringValue = (value: unknown): string | undefined => {
    if (value == null) return undefined;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return undefined;
};

const toStringArray = (value: unknown): string[] => {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((entry) => toStringValue(entry))
        .filter((entry): entry is string => Boolean(entry));
};

const normalizeLldpNeighbor = (
    localInterface: string,
    rawNeighbor: unknown,
    neighborIndex: number
): LldpNeighborNode | null => {
    if (!Array.isArray(rawNeighbor)) {
        return null;
    }

    const tlvs = rawNeighbor
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));

    if (tlvs.length === 0) {
        return null;
    }

    let systemName: string | undefined;
    let portId: string | undefined;
    let chassisId: string | undefined;
    let systemDescription: string | undefined;
    const capabilities: string[] = [];

    tlvs.forEach((tlv) => {
        if (!systemName) {
            systemName = toStringValue(tlv['system-name']);
        }
        if (!portId) {
            portId = toStringValue(tlv['port-id']);
        }
        if (!chassisId) {
            chassisId = toStringValue(tlv['chassis-id']);
        }
        if (!systemDescription) {
            systemDescription = toStringValue(tlv['system-description']);
        }
        capabilities.push(...toStringArray(tlv['system-capabilities']));
    });

    const label = systemName || chassisId || `LLDP Neighbor ${neighborIndex + 1}`;

    return {
        id: lldpNodeId(localInterface, neighborIndex),
        label,
        localInterface,
        neighborIndex,
        systemName,
        portId,
        chassisId,
        systemDescription,
        capabilities: Array.from(new Set(capabilities)),
        rawTlvs: tlvs
    };
};

export const extractLldpNeighbors = (interfaces: Interface[]): LldpNeighborNode[] => {
    const neighbors: LldpNeighborNode[] = [];

    interfaces.forEach((iface) => {
        const localInterface = iface?.name;
        if (!localInterface) {
            return;
        }

        const rawNeighbors = iface?.lldp?.neighbors;
        if (!Array.isArray(rawNeighbors)) {
            return;
        }

        rawNeighbors.forEach((rawNeighbor, neighborIndex) => {
            const normalized = normalizeLldpNeighbor(localInterface, rawNeighbor, neighborIndex);
            if (normalized) {
                neighbors.push(normalized);
            }
        });
    });

    return neighbors;
};

export const hasLldpNeighbors = (interfaces: Interface[]): boolean =>
    interfaces.some((iface) => iface?.lldp?.enabled === true) &&
    interfaces.some((iface) => Array.isArray(iface?.lldp?.neighbors) && iface.lldp.neighbors.length > 0);

const getRouteTableId = (route: Record<string, unknown>): string | undefined =>
    toStringValue(
        route['table-id'] ??
        route.tableId ??
        route.table ??
        route['route-table-id']
    );

const getRouteNextHopInterface = (route: Record<string, unknown>): string | undefined =>
    toStringValue(
        route['next-hop-interface'] ??
        route.nextHopInterface ??
        route['outgoing-interface'] ??
        route.oif ??
        route.dev
    );

const normalizeRoute = (route: unknown): VrfAssociatedRoute | null => {
    if (!route || typeof route !== 'object') {
        return null;
    }
    const raw = route as Record<string, unknown>;
    const destination = toStringValue(raw.destination ?? raw.dst);
    if (!destination) {
        return null;
    }

    return {
        destination,
        nextHopAddress: toStringValue(raw['next-hop-address'] ?? raw.nextHopAddress ?? raw.gateway ?? raw.via),
        nextHopInterface: getRouteNextHopInterface(raw),
        tableId: getRouteTableId(raw),
        metric: toStringValue(raw.metric),
        protocol: toStringValue(raw.protocol)
    };
};

/**
 * Normalised routes per NodeNetworkState, so the walk over the raw route list runs
 * once per resource rather than once per VRF. The graph asks for every VRF's egress
 * on each render; the drawer asks again for the selected one. Keyed weakly on the
 * resource object: a fresh watch result is a fresh object and a fresh walk.
 */
const routesByNns = new WeakMap<NodeNetworkState, VrfAssociatedRoute[]>();

const collectNnsRoutes = (nns: NodeNetworkState): VrfAssociatedRoute[] => {
    const cached = routesByNns.get(nns);
    if (cached) return cached;
    const routes = walkNnsRoutes(nns);
    routesByNns.set(nns, routes);
    return routes;
};

const walkNnsRoutes = (nns: NodeNetworkState): VrfAssociatedRoute[] => {
    const currentState = nns?.status?.currentState as Record<string, unknown> | undefined;
    if (!currentState) {
        return [];
    }

    const candidateLists: unknown[] = [];
    const routes = currentState.routes as Record<string, unknown> | unknown[] | undefined;
    if (Array.isArray(routes)) {
        candidateLists.push(routes);
    } else if (routes && typeof routes === 'object') {
        candidateLists.push(
            (routes as Record<string, unknown>).running,
            (routes as Record<string, unknown>).config
        );
    }
    candidateLists.push(
        (currentState as Record<string, unknown>)['routes.running'],
        (currentState as Record<string, unknown>)['routes.config']
    );

    const normalized = candidateLists
        .flatMap((list) => (Array.isArray(list) ? list : []))
        .map(normalizeRoute)
        .filter((route): route is VrfAssociatedRoute => route !== null);

    const dedupedByKey = new Map<string, VrfAssociatedRoute>();
    normalized.forEach((route) => {
        const key = `${route.destination}|${route.nextHopAddress || ''}|${route.nextHopInterface || ''}|${route.tableId || ''}`;
        if (!dedupedByKey.has(key)) {
            dedupedByKey.set(key, route);
        }
    });

    return Array.from(dedupedByKey.values());
};

const vrfPortNames = (vrfInterface: Interface): Set<string> => new Set<string>(
    Array.isArray(vrfInterface.vrf?.port)
        ? vrfInterface.vrf.port
        : typeof vrfInterface.vrf?.port === 'string'
            ? [vrfInterface.vrf.port]
            : []
);

export const getVrfRoutesForInterface = (
    vrfInterface: Interface,
    nns: NodeNetworkState
): VrfAssociatedRoute[] => {
    const vrfTableId = toStringValue(vrfInterface.vrf?.['route-table-id']);
    const vrfPorts = vrfPortNames(vrfInterface);

    return collectNnsRoutes(nns).filter((route) => {
        const byTable = vrfTableId ? route.tableId === vrfTableId : false;
        const byPort = route.nextHopInterface ? vrfPorts.has(route.nextHopInterface) : false;
        return byTable || byPort;
    });
};

const DEFAULT_ROUTES = new Set(['0.0.0.0/0', '::/0']);

/**
 * Where a VRF's traffic leaves the node, read from its own route table.
 *
 * The graph used to imply this by walking br-int: a VRF's management port is on
 * br-int, br-int patches to every provider bridge, so a VRF looked attached to all
 * of them. The kernel already records the answer. Every route in the VRF's table
 * names a next-hop interface, and the ones that are not the VRF's own ports are the
 * interfaces it egresses through -- br-ex on a stock cluster, but whatever the table
 * says on any other. Nothing here assumes a bridge name.
 *
 * One entry per egress interface, default route first within each so the rationale
 * leads with the route that matters. Routes without a table id are not the VRF's.
 */
export const getVrfEgressInterfaces = (
    vrfInterface: Interface,
    nns: NodeNetworkState
): VrfEgress[] => {
    const tableId = toStringValue(vrfInterface.vrf?.['route-table-id']);
    if (!tableId) return [];
    const ownPorts = vrfPortNames(vrfInterface);

    const byInterface = new Map<string, string[]>();
    collectNnsRoutes(nns).forEach((route) => {
        const via = route.nextHopInterface;
        if (route.tableId !== tableId || !via) return;
        if (via === vrfInterface.name || ownPorts.has(via)) return;
        const destinations = byInterface.get(via) ?? [];
        if (!destinations.includes(route.destination)) destinations.push(route.destination);
        byInterface.set(via, destinations);
    });

    const isDefault = (destination: string) => DEFAULT_ROUTES.has(destination);
    return Array.from(byInterface.entries()).map(([interfaceName, destinations]) => ({
        interfaceName,
        destinations: [
            ...destinations.filter(isDefault),
            ...destinations.filter((d) => !isDefault(d))
        ],
        tableId
    }));
};

export const getCudnAssociatedNamespaces = (cudn: ClusterUserDefinedNetwork): string[] => {
    const condition = cudn.status?.conditions?.find((c) => c.type === 'NetworkCreated' && c.status === 'True');
    if (!condition?.message) {
        return [];
    }

    const match = condition.message.match(/\[(.*?)\]/);
    if (!match || !match[1]) {
        return [];
    }

    return match[1]
        .split(',')
        .map((namespace: string) => namespace.trim())
        .filter(Boolean)
        .sort();
};

/** Parse NAD spec.config; accepts string (JSON) or already-parsed object from the API. */
export const parseNadConfig = (config: string | Record<string, unknown> | undefined): Record<string, unknown> | null => {
    if (config == null) return null;
    if (typeof config === 'object' && config !== null && !Array.isArray(config)) {
        return config as Record<string, unknown>;
    }
    if (typeof config !== 'string') return null;
    try {
        const parsed = JSON.parse(config);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

export const getNadNetworkName = (nad: NetworkAttachmentDefinition): string | undefined => {
    const config = parseNadConfig(nad.spec?.config);
    if (typeof config?.name === 'string') return config.name;
    return undefined;
};

export const findCudnNameForNad = (
    nad: NetworkAttachmentDefinition,
    cudns: ClusterUserDefinedNetwork[]
): string | undefined => {
    const nadConfigName = getNadNetworkName(nad);
    const directMatch = nad.metadata?.name && cudns.find((cudn) => cudn.metadata?.name === nad.metadata?.name)?.metadata?.name;
    if (directMatch) return directMatch;
    if (nadConfigName) {
        const configMatch = cudns.find((cudn) => cudn.metadata?.name === nadConfigName)?.metadata?.name;
        if (configMatch) return configMatch;
    }
    return undefined;
};

/** Upstream node ids for a NAD: bridge name (when type=bridge/cnv-bridge) and/or ovn-${physicalNetworkName}. */
export const getNadUpstreamNodeIds = (nad: NetworkAttachmentDefinition): string[] => {
    const rawConfig = nad.spec?.config;
    const config = parseNadConfig(rawConfig);
    const upstream: string[] = [];

    if (config) {
        const nadType = typeof config.type === 'string' ? config.type : '';
        if ((nadType === 'bridge' || nadType === 'cnv-bridge') && typeof config.bridge === 'string') {
            upstream.push(config.bridge);
        }
        if (typeof config.physicalNetworkName === 'string') {
            upstream.push(bridgeMappingNodeId(config.physicalNetworkName));
        }
    }

    if (upstream.length > 0) return upstream;

    // Fallback: extract bridge/type from raw config string when parse fails (e.g. multiline YAML, encoding)
    const configStr = typeof rawConfig === 'string' ? rawConfig : '';
    if (!configStr) return [];
    const typeMatch = configStr.match(/"type"\s*:\s*"([^"]+)"/);
    const bridgeMatch = configStr.match(/"bridge"\s*:\s*"([^"]+)"/);
    const nadType = typeMatch ? typeMatch[1] : '';
    const bridgeName = bridgeMatch ? bridgeMatch[1] : '';
    if ((nadType === 'bridge' || nadType === 'cnv-bridge') && bridgeName) {
        upstream.push(bridgeName);
    }
    const physMatch = configStr.match(/"physicalNetworkName"\s*:\s*"([^"]+)"/);
    if (physMatch && physMatch[1]) {
        upstream.push(bridgeMappingNodeId(physMatch[1]));
    }
    return upstream;
};

/** Upstream node ids used for drawing edges. When the NAD is CUDN-backed, we do not link to bridge-mapping (ovn-*). */
export const getNadUpstreamNodeIdsForEdges = (
    nad: NetworkAttachmentDefinition,
    cudns: ClusterUserDefinedNetwork[]
): string[] => {
    const upstream = getNadUpstreamNodeIds(nad);
    const cudnName = findCudnNameForNad(nad, cudns);
    if (cudnName) {
        return upstream.filter((id) => !id.startsWith('ovn:'));
    }
    return upstream;
};

// --- OVS patch port names (ovn-recon-s3t.29) ---------------------------------

/**
 * OVN-Kubernetes's fixed pieces of a patch port name. br-int is the only bridge it
 * patches from, so every provider-side port ends `-to-br-int` and every br-int-side
 * port starts `patch-br-int-to-`.
 */
const PATCH_PREFIX = 'patch-';
const PATCH_TO_INTEGRATION_SUFFIX = '-to-br-int';
const PATCH_FROM_INTEGRATION_PREFIX = 'patch-br-int-to-';
const LOCALNET_PORT_SUFFIX = '_ovn_localnet_port';

/** The OVN network name of a ClusterUserDefinedNetwork is this plus its own name. */
export const CUDN_NETWORK_PREFIX = 'cluster_udn_';

/**
 * A network name as OVN-Kubernetes embeds it in a port name: `-` and `/` both become
 * `.`, and a `.` already in the name is left alone. LOSSY -- `a-b` and `a.b` come out
 * the same -- which is why nothing here ever runs it backwards.
 */
export const patchPortNetworkName = (name: string): string => name.replace(/[-/]/g, '.');

export interface PatchPortName {
    /**
     * gateway  -- `patch-<bridge>_[<network>_]<node>-to-br-int`: the network's gateway
     *             router reaching a provider bridge. Layer2 and Layer3 networks, and
     *             the cluster default network when no network is named.
     * localnet -- `patch-<network>_ovn_localnet_port-to-br-int`: a Localnet network's
     *             logical switch reaching the bridge its physical network maps to.
     */
    form: 'gateway' | 'localnet';
    /** Which end of the pair carries this name. */
    side: 'provider' | 'integration';
    /**
     * The OVN network name as embedded, dashes already dots: `cluster_udn_example.p.cudn`.
     * Undefined on a gateway-form name that names no network -- the cluster default.
     */
    networkName?: string;
    /** The bridge a gateway-form name embeds. A localnet-form name carries none. */
    bridge?: string;
    /** The node a gateway-form name embeds. */
    node?: string;
}

/**
 * Read an OVS patch port name. Pure string work; returns undefined for anything that
 * is not one of the two forms OVN-Kubernetes generates.
 *
 * A gateway-form name is `<bridge>_<network>_<node>` with underscores inside the
 * network name too (`cluster_udn_...`), so only its ends can be split off: the node
 * is whatever follows the last underscore, since a Kubernetes node name cannot
 * contain one. The bridge is the port's controller when the caller knows it (an OVS
 * bridge name may itself contain an underscore), else whatever precedes the first.
 */
export const parsePatchPortName = (name: string, controller?: string): PatchPortName | undefined => {
    let side: PatchPortName['side'];
    let port: string;
    if (name.startsWith(PATCH_FROM_INTEGRATION_PREFIX)) {
        side = 'integration';
        port = name.slice(PATCH_FROM_INTEGRATION_PREFIX.length);
    } else if (name.startsWith(PATCH_PREFIX) && name.endsWith(PATCH_TO_INTEGRATION_SUFFIX)) {
        side = 'provider';
        port = name.slice(PATCH_PREFIX.length, -PATCH_TO_INTEGRATION_SUFFIX.length);
    } else {
        return undefined;
    }

    // Checked first: `cluster_udn_x_ovn_localnet_port` would otherwise read as a
    // gateway port on a bridge called `cluster`.
    if (port.endsWith(LOCALNET_PORT_SUFFIX)) {
        const networkName = port.slice(0, -LOCALNET_PORT_SUFFIX.length);
        return networkName ? { form: 'localnet', side, networkName } : undefined;
    }

    const bridgeEnd = side === 'provider' && controller && port.startsWith(`${controller}_`)
        ? controller.length
        : port.indexOf('_');
    const nodeStart = port.lastIndexOf('_');
    if (bridgeEnd <= 0 || nodeStart === port.length - 1) return undefined;
    const bridge = port.slice(0, bridgeEnd);
    const node = port.slice(nodeStart + 1);
    // One underscore: `<bridge>_<node>`, nothing between them.
    if (nodeStart === bridgeEnd) return { form: 'gateway', side, bridge, node };
    const networkName = port.slice(bridgeEnd + 1, nodeStart);
    return networkName ? { form: 'gateway', side, networkName, bridge, node } : undefined;
};

/** One network's patch pair, anchored on the port at the provider-bridge end. */
export interface NetworkPatchPort {
    form: PatchPortName['form'];
    /** As PatchPortName.networkName: dotted, and undefined for the cluster default network. */
    networkName?: string;
    /** True for the unqualified gateway pair, which is the cluster default network's. */
    isDefaultNetwork: boolean;
    /**
     * The bridge the pair terminates on: the provider-side port's controller, as
     * NodeNetworkState reports it -- not the bridge spelled in the name. Undefined
     * when the port is on no bridge, which a half-configured mapping leaves behind.
     */
    bridge?: string;
    node?: string;
    /** The provider-side port. */
    portName: string;
    /** Its `patch.peer` on br-int, when nmstate reports one. */
    peerName?: string;
}

const patchPortsByInterfaces = new WeakMap<Interface[], NetworkPatchPort[]>();

/**
 * Every network patch pair on the node, in NodeNetworkState order.
 *
 * Read from the provider end only -- each pair would otherwise be counted twice --
 * and the bridge is that port's `controller`, the same field the integration bridge's
 * `patch-peer` edge follows from the other end, so the two agree on which bridge a
 * pair reaches. Cached per interface list: the graph asks once per CUDN.
 */
export const getNetworkPatchPorts = (interfaces: Interface[]): NetworkPatchPort[] => {
    const cached = patchPortsByInterfaces.get(interfaces);
    if (cached) return cached;
    const ports = interfaces.flatMap((iface): NetworkPatchPort[] => {
        const bridge = iface.controller || iface.master || undefined;
        const parsed = parsePatchPortName(iface.name, bridge);
        if (!parsed || parsed.side !== 'provider') return [];
        return [{
            form: parsed.form,
            networkName: parsed.networkName,
            isDefaultNetwork: parsed.form === 'gateway' && parsed.networkName === undefined,
            bridge,
            node: parsed.node,
            portName: iface.name,
            peerName: iface.patch?.peer || undefined
        }];
    });
    patchPortsByInterfaces.set(interfaces, ports);
    return ports;
};

/**
 * Names of the CUDNs a patch pair's embedded network name could stand for.
 *
 * Compared FORWARDS: each CUDN name is put through the same transform and matched
 * against the embedded name, because the transform cannot be undone. Only a name
 * carrying the `cluster_udn_` prefix is a CUDN's -- a bare `tenant.b.db` is a network
 * some NetworkAttachmentDefinition named, and a CUDN that happens to be called
 * `tenant-b-db` has nothing to do with it.
 */
const cudnCandidatesForPatchPort = (
    port: NetworkPatchPort,
    cudns: ClusterUserDefinedNetwork[]
): string[] => {
    if (!port.networkName?.startsWith(CUDN_NETWORK_PREFIX)) return [];
    const dotted = port.networkName.slice(CUDN_NETWORK_PREFIX.length);
    return cudns
        .map((cudn) => cudn.metadata?.name || '')
        .filter((name) => name && patchPortNetworkName(name) === dotted);
};

/**
 * The CUDN a patch pair belongs to, or undefined.
 *
 * Fails to NO MATCH rather than a wrong one, twice over: when the port is on no
 * bridge there is nothing to link the network to, and when two CUDN names collide
 * after the transform (`a-b` and `a.b`) the name cannot say which one it means.
 */
export const resolvePatchPortCudn = (
    port: NetworkPatchPort,
    cudns: ClusterUserDefinedNetwork[]
): string | undefined => {
    if (!port.bridge) return undefined;
    const candidates = cudnCandidatesForPatchPort(port, cudns);
    return candidates.length === 1 ? candidates[0] : undefined;
};

export interface CudnPatchPorts {
    /** Pairs that resolve to this CUDN and to no other. */
    matched: NetworkPatchPort[];
    /** Pairs whose name fits this CUDN and at least one other; matched to neither. */
    ambiguous: { port: NetworkPatchPort; candidates: string[] }[];
}

/** The patch pairs naming one CUDN, with the ones that could not be told apart. */
export const findPatchPortsForCudn = (
    cudnName: string | undefined,
    cudns: ClusterUserDefinedNetwork[],
    interfaces: Interface[]
): CudnPatchPorts => {
    const result: CudnPatchPorts = { matched: [], ambiguous: [] };
    if (!cudnName) return result;
    getNetworkPatchPorts(interfaces).forEach((port) => {
        if (!port.bridge) return;
        const candidates = cudnCandidatesForPatchPort(port, cudns);
        if (!candidates.includes(cudnName)) return;
        if (candidates.length === 1) result.matched.push(port);
        else result.ambiguous.push({ port, candidates });
    });
    return result;
};

// --- EVPN device names (ovn-recon-s3t.53) ------------------------------------

/**
 * OVN-Kubernetes names every kernel device it creates for EVPN from a 4-character
 * prefix, a separator and an identifier, capped at the kernel's 15-character
 * interface-name limit (go-controller/pkg/node/controllers/evpn/utils.go):
 *
 *   per VTEP      evbr (bridge)   evx4 / evx6 (VXLAN, by address family)
 *   per network   svl2 (L2 SVI)   svl3 (L3 SVI)   ovl2 (OVS port)
 *
 *   `-` then the readable name: the VTEP name, or the CUDN name
 *   `.` then a computed fallback when the readable form is too long: the first 8 hex
 *       digits of sha256(VTEP name), or the network ID
 *
 * A `.` is not valid in a Kubernetes name and a name cannot start with `-`, so the two
 * forms cannot collide. Nothing in NodeNetworkState or the API declares any of this,
 * which is why everything resting on it is inferred -- and the hash cannot be undone,
 * so a device is matched by deriving the name each known VTEP WOULD produce.
 */
const INTERFACE_NAME_LIMIT = 15;

export type EvpnVtepDevicePrefix = 'evbr' | 'evx4' | 'evx6';
export type EvpnNetworkDevicePrefix = 'svl2' | 'svl3' | 'ovl2';

/** What each per-VTEP device is, for the drawer. */
export const EVPN_VTEP_DEVICES: Record<EvpnVtepDevicePrefix, string> = {
    evbr: 'EVPN bridge',
    evx4: 'VXLAN device (IPv4)',
    evx6: 'VXLAN device (IPv6)'
};

/** What each per-network device is, for the drawer. */
export const EVPN_NETWORK_DEVICES: Record<EvpnNetworkDevicePrefix, string> = {
    svl2: 'Layer 2 SVI (MAC-VRF)',
    svl3: 'Layer 3 SVI (IP-VRF)',
    ovl2: 'OVS Layer 2 port'
};

/** Node annotation: `{"<vtep>":{"ips":["<address>"]}}`, the address discovered per VTEP. */
export const NODE_VTEPS_ANNOTATION = 'k8s.ovn.org/vteps';
/** NetworkAttachmentDefinition annotation carrying the network's numeric ID. */
export const NETWORK_ID_ANNOTATION = 'k8s.ovn.org/network-id';

const vtepNameHashes = new Map<string, string>();
const vtepNameHash = (vtepName: string): string => {
    let hash = vtepNameHashes.get(vtepName);
    if (hash === undefined) {
        hash = sha256Hex(vtepName).slice(0, 8);
        vtepNameHashes.set(vtepName, hash);
    }
    return hash;
};

/** The name OVN-Kubernetes gives one of a VTEP's devices. */
export const evpnVtepDeviceName = (prefix: EvpnVtepDevicePrefix, vtepName: string): string => {
    const readable = `${prefix}-${vtepName}`;
    return readable.length <= INTERFACE_NAME_LIMIT ? readable : `${prefix}.${vtepNameHash(vtepName)}`;
};

/**
 * The address OVN-Kubernetes recorded for each VTEP on a node, from the Node's
 * `k8s.ovn.org/vteps` annotation. Empty for anything unparseable: an annotation this
 * cannot read is the same as one that is not there.
 */
export const parseNodeVteps = (annotation: string | undefined): Record<string, string[]> => {
    if (!annotation) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(annotation);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, string[]> = {};
    Object.entries(parsed as Record<string, unknown>).forEach(([vtepName, value]) => {
        const ips = (value as { ips?: unknown } | null)?.ips;
        if (Array.isArray(ips)) {
            result[vtepName] = ips.filter((ip): ip is string => typeof ip === 'string');
        }
    });
    return result;
};

/**
 * Every VTEP name the cluster has told us about, from any source.
 *
 * A device can only be matched to a VTEP whose name is known, and the VTEP resource
 * is not the only place the name appears: a CUDN declares the VTEP it rides on, and
 * the Node annotation is keyed by VTEP name. Taking the union means a reader without
 * permission to list VTEPs -- or looking at an NNS beside CUDNs only -- still gets
 * the link.
 */
export const getKnownVtepNames = (
    vteps: Vtep[],
    cudns: ClusterUserDefinedNetwork[],
    nodeVteps: Record<string, string[]>
): string[] => Array.from(new Set([
    ...vteps.map((vtep) => vtep.metadata?.name),
    ...cudns.map((cudn) => cudn.spec?.network?.evpn?.vtep),
    ...Object.keys(nodeVteps)
].filter((name): name is string => Boolean(name)))).sort();

export interface EvpnVtepDevice {
    prefix: EvpnVtepDevicePrefix;
    vtepName: string;
    /** `name`: the device name spells the VTEP out. `hash`: it carries the sha256 prefix. */
    how: 'name' | 'hash';
}

/**
 * The VTEP a device was created for, or undefined.
 *
 * Fails to NO MATCH when two known VTEP names would produce the same device name --
 * possible only through an 8-hex-digit hash collision, but a wrong VTEP is worse than
 * none.
 */
export const findVtepForDevice = (
    deviceName: string | undefined,
    vtepNames: string[]
): EvpnVtepDevice | undefined => {
    if (!deviceName) return undefined;
    const prefix = deviceName.slice(0, 4) as EvpnVtepDevicePrefix;
    const separator = deviceName.charAt(4);
    if (!(prefix in EVPN_VTEP_DEVICES) || (separator !== '-' && separator !== '.')) return undefined;
    const candidates = vtepNames.filter((vtepName) => evpnVtepDeviceName(prefix, vtepName) === deviceName);
    if (candidates.length !== 1) return undefined;
    return { prefix, vtepName: candidates[0], how: separator === '-' ? 'name' : 'hash' };
};

/** CUDNs declaring `spec.network.evpn.vtep: <vtepName>`. */
export const getCudnsUsingVtep = (
    vtepName: string | undefined,
    cudns: ClusterUserDefinedNetwork[]
): ClusterUserDefinedNetwork[] =>
    (vtepName ? cudns.filter((cudn) => cudn.spec?.network?.evpn?.vtep === vtepName) : []);

export interface EvpnNetworkDeviceName {
    prefix: EvpnNetworkDevicePrefix;
    /** `name`: the suffix is a CUDN name. `network-id`: it is the network's numeric ID. */
    how: 'name' | 'network-id';
    /** The CUDN name or the network ID, as written in the device name. */
    key: string;
}

/** Read a per-network EVPN device name. Pure string work. */
export const parseEvpnNetworkDeviceName = (deviceName: string | undefined): EvpnNetworkDeviceName | undefined => {
    if (!deviceName) return undefined;
    const prefix = deviceName.slice(0, 4) as EvpnNetworkDevicePrefix;
    if (!(prefix in EVPN_NETWORK_DEVICES)) return undefined;
    const separator = deviceName.charAt(4);
    const key = deviceName.slice(5);
    if (!key) return undefined;
    if (separator === '-') return { prefix, how: 'name', key };
    if (separator === '.' && /^\d+$/.test(key)) return { prefix, how: 'network-id', key };
    return undefined;
};

export type EvpnNetworkRef =
    | { kind: 'cudn'; name: string }
    | { kind: 'udn'; namespace: string; name: string };

const networkRefLabel = (ref: EvpnNetworkRef): string =>
    (ref.kind === 'cudn' ? `CUDN ${ref.name}` : `UDN ${ref.namespace}/${ref.name}`);

/**
 * The network a NetworkAttachmentDefinition belongs to.
 *
 * The network name in spec.config is preferred to the NAD's own name: a CUDN and a
 * namespaced UDN may share a name, and only the config's `cluster_udn_` prefix says
 * which of them created this NAD.
 */
const networkForNad = (
    nad: NetworkAttachmentDefinition,
    cudns: ClusterUserDefinedNetwork[],
    udns: UserDefinedNetwork[]
): EvpnNetworkRef | undefined => {
    const hasCudn = (name: string) => cudns.some((cudn) => cudn.metadata?.name === name);
    const configName = getNadNetworkName(nad);
    if (configName?.startsWith(CUDN_NETWORK_PREFIX)) {
        const name = configName.slice(CUDN_NETWORK_PREFIX.length);
        return hasCudn(name) ? { kind: 'cudn', name } : undefined;
    }
    const namespace = nad.metadata?.namespace;
    const name = nad.metadata?.name;
    if (namespace && name
        && udns.some((udn) => udn.metadata?.namespace === namespace && udn.metadata?.name === name)) {
        return { kind: 'udn', namespace, name };
    }
    const cudnName = findCudnNameForNad(nad, cudns);
    return cudnName ? { kind: 'cudn', name: cudnName } : undefined;
};

/** The VLAN id a NAD's config assigns one of its network's VRFs on the EVPN bridge. */
const evpnVidFromNad = (
    nad: NetworkAttachmentDefinition | undefined,
    prefix: EvpnNetworkDevicePrefix
): number | undefined => {
    const evpn = parseNadConfig(nad?.spec?.config)?.evpn as
        { macVRF?: { vid?: unknown }; ipVRF?: { vid?: unknown } } | undefined;
    const vid = prefix === 'svl3' ? evpn?.ipVRF?.vid : evpn?.macVRF?.vid;
    return typeof vid === 'number' ? vid : undefined;
};

export interface NetworkIdMatch {
    /** The one network claiming the ID. Absent when none does, or more than one. */
    network?: EvpnNetworkRef;
    /** A NetworkAttachmentDefinition carrying the ID: the matched network's, else the first found. */
    nad?: NetworkAttachmentDefinition;
    /** Networks claiming the same ID, when more than one does. Matched to none of them. */
    ambiguous?: string[];
}

/**
 * The network a numeric network ID belongs to.
 *
 * The ID lives only on the network's NetworkAttachmentDefinitions, as the
 * k8s.ovn.org/network-id annotation, so it is resolved through them. A CUDN creates
 * one NAD per attached namespace, all carrying the same ID; that is one network, not
 * an ambiguity. Two different networks claiming one ID match neither.
 */
export const findNetworkByNetworkId = (
    networkId: string,
    cudns: ClusterUserDefinedNetwork[],
    udns: UserDefinedNetwork[],
    nads: NetworkAttachmentDefinition[]
): NetworkIdMatch => {
    const carriers = nads.filter((nad) => nad.metadata?.annotations?.[NETWORK_ID_ANNOTATION] === networkId);
    const networks = new Map<string, { network: EvpnNetworkRef; nad: NetworkAttachmentDefinition }>();
    carriers.forEach((nad) => {
        const network = networkForNad(nad, cudns, udns);
        if (!network) return;
        const label = networkRefLabel(network);
        if (!networks.has(label)) networks.set(label, { network, nad });
    });
    if (networks.size > 1) return { ambiguous: Array.from(networks.keys()).sort() };
    const [match] = Array.from(networks.values());
    return { network: match?.network, nad: match?.nad ?? carriers[0] };
};

export interface EvpnNetworkDevice extends EvpnNetworkDeviceName {
    /** The network the device belongs to. Absent when the name resolves to nothing, or to more than one. */
    network?: EvpnNetworkRef;
    /** A NetworkAttachmentDefinition of that network: the one carrying the ID, when matched by ID. */
    nad?: { namespace: string; name: string };
    /** The VLAN id that NAD's config assigns this device's VRF on the EVPN bridge. */
    vid?: number;
    /** Networks claiming the same ID, when more than one does. Matched to none of them. */
    ambiguous?: string[];
}

/**
 * The network a per-network EVPN device belongs to.
 *
 * Returns undefined for a name that is not an EVPN device's at all, and a result with
 * no `network` for one that is but resolves to nothing -- the caller can then say
 * what the device is while admitting it does not know whose.
 *
 * The ID form is resolved through the NetworkAttachmentDefinitions carrying it; see
 * findNetworkByNetworkId.
 */
export const findEvpnNetworkForDevice = (
    deviceName: string | undefined,
    cudns: ClusterUserDefinedNetwork[],
    udns: UserDefinedNetwork[],
    nads: NetworkAttachmentDefinition[]
): EvpnNetworkDevice | undefined => {
    const parsed = parseEvpnNetworkDeviceName(deviceName);
    if (!parsed) return undefined;
    const nadRefOf = (nad: NetworkAttachmentDefinition | undefined) => (nad?.metadata?.name
        ? { namespace: nad.metadata.namespace || 'default', name: nad.metadata.name }
        : undefined);

    if (parsed.how === 'name') {
        // Only a CUDN's name is ever spelled out; a namespaced UDN always gets the ID form.
        if (!cudns.some((cudn) => cudn.metadata?.name === parsed.key)) return parsed;
        const nad = nads.find((candidate) => {
            const network = networkForNad(candidate, cudns, udns);
            return network?.kind === 'cudn' && network.name === parsed.key;
        });
        return {
            ...parsed,
            network: { kind: 'cudn', name: parsed.key },
            nad: nadRefOf(nad),
            vid: evpnVidFromNad(nad, parsed.prefix)
        };
    }

    const byId = findNetworkByNetworkId(parsed.key, cudns, udns, nads);
    if (byId.ambiguous) return { ...parsed, ambiguous: byId.ambiguous };
    return {
        ...parsed,
        network: byId.network,
        nad: nadRefOf(byId.nad),
        vid: evpnVidFromNad(byId.nad, parsed.prefix)
    };
};
