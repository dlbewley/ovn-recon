import {
    ClusterUserDefinedNetwork,
    Interface,
    NodeNetworkState,
    NetworkAttachmentDefinition,
    RouteAdvertisements
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
        id: `lldp-${localInterface}-${neighborIndex}`,
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
            upstream.push(`ovn-${config.physicalNetworkName}`);
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
        upstream.push(`ovn-${physMatch[1]}`);
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
        return upstream.filter((id) => !id.startsWith('ovn-'));
    }
    return upstream;
};
