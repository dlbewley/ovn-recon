import {
    ClusterUserDefinedNetwork,
    NetworkAttachmentDefinition,
    RouteAdvertisements
} from '../types';

interface MatchExpression {
    key: string;
    operator: string;
    values?: string[];
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
