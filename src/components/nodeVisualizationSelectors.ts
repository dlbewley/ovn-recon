import { bridgeMappingNodeId, lldpNodeId } from '../topology/ids';
import {
    ClusterUserDefinedNetwork,
    Interface,
    Ipv4AddressEntry,
    LabelSelector,
    NodeNetworkConfigurationEnactment,
    NodeNetworkState,
    NetworkAttachmentDefinition,
    RouteAdvertisements,
    UserDefinedNetwork
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
    /** Which signals matched, for the edge rule and the fact hint. */
    signals: ('subnet' | 'name')[];
}

/**
 * The Primary Layer2/Layer3 network this VRF exists to serve (ovn-recon-s3t.28).
 *
 * A Primary UDN or CUDN creates a per-node VRF as a side effect; Localnet
 * networks can never be Primary and are excluded outright.
 *
 * NAME IS REQUIRED, SUBNET ONLY CORROBORATES. OVN-Kubernetes names the VRF
 * after the network (truncated to the kernel's 15-character interface-name
 * limit), so the name is the mechanism. Subnets are NOT unique across
 * UDNs/CUDNs -- networks map to OVS logical switches uplinked to OVN routers
 * that NAT overlapping ranges apart -- so a subnet-containment match on its own
 * could pick the wrong network. It serves only to break ties when several long
 * network names share a truncated prefix.
 */
export const findPrimaryNetworkForVrf = (
    vrf: Interface,
    cudns: ClusterUserDefinedNetwork[],
    udns: UserDefinedNetwork[],
    interfaces: Interface[]
): PrimaryNetworkMatch | undefined => {
    const portAddresses = getVrfConnectionInfo(vrf, interfaces)
        .brIntPorts.flatMap((port) => getIpv4Addresses(port));

    const nameMatches = (name: string): boolean =>
        name === vrf.name || name.substring(0, VRF_NAME_LIMIT) === vrf.name;

    interface Candidate {
        kind: 'cudn' | 'udn';
        name: string;
        namespace?: string;
        subnets: string[];
    }
    const candidates: Candidate[] = [
        ...cudns.flatMap((cudn): Candidate[] => {
            const network = cudn.spec?.network;
            const layer = network?.topology === 'Layer2' ? network.layer2
                : network?.topology === 'Layer3' ? network.layer3
                    : undefined;
            if (layer?.role !== 'Primary') return [];
            return [{ kind: 'cudn', name: cudn.metadata?.name || '', subnets: layer.subnets || [] }];
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
                subnets: layer.subnets || []
            }];
        })
    ];

    const matches = candidates
        .map((candidate): PrimaryNetworkMatch => ({
            kind: candidate.kind,
            name: candidate.name,
            namespace: candidate.namespace,
            signals: [
                ...(candidate.subnets.some((subnet) =>
                    portAddresses.some((address) => ipv4InCidr(address, subnet)))
                    ? ['subnet' as const] : []),
                ...(nameMatches(candidate.name) ? ['name' as const] : [])
            ]
        }))
        // The name must match; a subnet hit alone is not an association.
        .filter((match) => match.signals.includes('name'));

    return matches.find((match) => match.signals.includes('subnet')) ?? matches[0];
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

const collectNnsRoutes = (nns: NodeNetworkState): VrfAssociatedRoute[] => {
    const currentState = nns.status?.currentState as Record<string, unknown> | undefined;
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

export const getVrfRoutesForInterface = (
    vrfInterface: Interface,
    nns: NodeNetworkState
): VrfAssociatedRoute[] => {
    const vrfTableId = toStringValue(vrfInterface.vrf?.['route-table-id']);
    const vrfPorts = new Set<string>(
        Array.isArray(vrfInterface.vrf?.port)
            ? vrfInterface.vrf.port
            : typeof vrfInterface.vrf?.port === 'string'
                ? [vrfInterface.vrf.port]
                : []
    );

    return collectNnsRoutes(nns).filter((route) => {
        const byTable = vrfTableId ? route.tableId === vrfTableId : false;
        const byPort = route.nextHopInterface ? vrfPorts.has(route.nextHopInterface) : false;
        return byTable || byPort;
    });
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
