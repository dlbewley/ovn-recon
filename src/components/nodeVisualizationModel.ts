import {
    ClusterUserDefinedNetwork,
    Interface,
    NetworkAttachmentDefinition,
    OvnBridgeMapping,
    RouteAdvertisements,
    UserDefinedNetwork
} from '../types';
import {
    findCudnNameForNad,
    LldpNeighborNode,
    findRouteAdvertisementForVrf,
    getCudnsSelectedByRouteAdvertisement,
    getNadUpstreamNodeIdsForEdges
} from './nodeVisualizationSelectors';

export interface AttachmentNodeModel {
    name: string;
    type: string;
    namespaces: string[];
    cudn?: string;
    udnId?: string;
}

export interface TopologyEdge {
    source: string;
    target: string;
}

interface BuildTopologyEdgesParams {
    interfaces: Interface[];
    vrfInterfaces: Interface[];
    bridgeMappings: OvnBridgeMapping[];
    lldpNeighbors: LldpNeighborNode[];
    cudns: ClusterUserDefinedNetwork[];
    udns: UserDefinedNetwork[];
    attachmentNodes: AttachmentNodeModel[];
    nads: NetworkAttachmentDefinition[];
    routeAdvertisements: RouteAdvertisements[] | undefined;
    showNads: boolean;
    showLldpNeighbors: boolean;
    resolveNodeId: (item: Interface, type: string) => string;
    getAttachmentNodeId: (attachment: AttachmentNodeModel) => string;
    getUdnNodeId: (udn: UserDefinedNetwork) => string;
    getNadNodeId: (nad: NetworkAttachmentDefinition) => string;
}

const pushEdge = (
    edges: TopologyEdge[],
    edgeKeys: Set<string>,
    source: string | undefined,
    target: string | undefined
) => {
    if (!source || !target) return;
    const key = `${source}=>${target}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ source, target });
};

export const buildTopologyEdges = ({
    interfaces,
    vrfInterfaces,
    bridgeMappings,
    lldpNeighbors,
    cudns,
    udns,
    attachmentNodes,
    nads,
    routeAdvertisements,
    showNads,
    showLldpNeighbors,
    resolveNodeId,
    getAttachmentNodeId,
    getUdnNodeId,
    getNadNodeId
}: BuildTopologyEdgesParams): TopologyEdge[] => {
    const edges: TopologyEdge[] = [];
    const edgeKeys = new Set<string>();

    interfaces.forEach((iface) => {
        const ifaceId = resolveNodeId(iface, iface.type);
        const master = iface.controller || iface.master;
        if (master) {
            pushEdge(edges, edgeKeys, ifaceId, master);
        }
        const baseIface = iface.vlan?.['base-iface'] || iface['mac-vlan']?.['base-iface'];
        if (baseIface) {
            pushEdge(edges, edgeKeys, baseIface, ifaceId);
        }
    });

    bridgeMappings.forEach((mapping) => {
        pushEdge(edges, edgeKeys, mapping.bridge, `ovn-${mapping.localnet}`);
    });

    if (showLldpNeighbors) {
        lldpNeighbors.forEach((neighbor) => {
            pushEdge(edges, edgeKeys, neighbor.id, neighbor.localInterface);
        });
    }

    cudns.forEach((cudn) => {
        const physicalNetworkName = cudn.spec?.network?.localNet?.physicalNetworkName || cudn.spec?.network?.localnet?.physicalNetworkName;
        if (physicalNetworkName) {
            pushEdge(edges, edgeKeys, `ovn-${physicalNetworkName}`, `cudn-${cudn.metadata?.name}`);
        }
    });

    attachmentNodes.forEach((attachmentNode) => {
        const sourceId = attachmentNode.cudn != null ? `cudn-${attachmentNode.cudn}` : `udn-${attachmentNode.udnId}`;
        pushEdge(edges, edgeKeys, sourceId, getAttachmentNodeId(attachmentNode));
    });

    if (showNads) {
        nads.forEach((nad) => {
            const nadNodeId = getNadNodeId(nad);
            const cudnName = findCudnNameForNad(nad, cudns);
            if (cudnName) {
                pushEdge(edges, edgeKeys, `cudn-${cudnName}`, nadNodeId);
            }
            const udnForNad = udns.find((u) => u.metadata?.namespace === nad.metadata?.namespace && u.metadata?.name === nad.metadata?.name);
            if (udnForNad) {
                pushEdge(edges, edgeKeys, getUdnNodeId(udnForNad), nadNodeId);
            }
            getNadUpstreamNodeIdsForEdges(nad, cudns).forEach((upstreamId) => {
                pushEdge(edges, edgeKeys, upstreamId, nadNodeId);
            });
        });
    }

    if (routeAdvertisements) {
        vrfInterfaces.forEach((vrf) => {
            const ra = findRouteAdvertisementForVrf(routeAdvertisements, vrf.name);
            getCudnsSelectedByRouteAdvertisement(ra, cudns).forEach((cudn) => {
                pushEdge(edges, edgeKeys, resolveNodeId(vrf, vrf.type), `cudn-${cudn.metadata?.name}`);
            });
        });
    }

    return edges;
};
