import { extractLldpNeighbors, getCudnAssociatedNamespaces, LldpNeighborNode } from '../components/nodeVisualizationSelectors';
import { AttachmentNode } from './types';
import {
    ClusterUserDefinedNetwork,
    Interface,
    NetworkAttachmentDefinition,
    NodeNetworkConfigurationEnactment,
    NodeNetworkState,
    OvnBridgeMapping,
    RouteAdvertisements,
    UserDefinedNetwork
} from '../types';

/**
 * Everything the topology model needs to resolve a node or an edge.
 *
 * This exists to break the reason the model used to live inside the component: the
 * per-kind renderers closed over `cudns`, `nads`, `routeAdvertisements`, `interfaces`
 * and `nns` as component props, so nothing could be lifted out or tested. Passing the
 * dependency explicitly is what makes the rest of the epic possible.
 */
export interface GraphContext {
    nns: NodeNetworkState;
    interfaces: Interface[];
    bridgeMappings: OvnBridgeMapping[];
    cudns: ClusterUserDefinedNetwork[];
    udns: UserDefinedNetwork[];
    nads: NetworkAttachmentDefinition[];
    routeAdvertisements: RouteAdvertisements[];
    /**
     * This node's NodeNetworkConfigurationEnactments -- the record of which
     * NNCP configured what. Empty when the nmstate operator is absent or the
     * NNS was imported from elsewhere, in which case no origin can be claimed.
     */
    enactments: NodeNetworkConfigurationEnactment[];
    /**
     * Names of interfaces that are declared bridges. Needed to resolve the case where
     * an ovs-interface shares its name with the bridge it belongs to; without it the
     * two collide on a single id.
     */
    explicitBridgeNames: Set<string>;
    /** Names appearing as some interface's controller or master. */
    controllerNames: Set<string>;
    /** LLDP neighbours parsed out of the interfaces. */
    lldpNeighbors: LldpNeighborNode[];
    /**
     * Synthetic nodes for the namespaces attached to each network. Derived rather than
     * reported: CUDN namespaces are scraped from a status condition message, and each
     * UDN implies one attachment for the NAD its controller creates.
     */
    attachmentNodes: AttachmentNode[];
}

/** Namespaces attached to each CUDN, plus one node per UDN. */
const buildAttachmentNodes = (
    cudns: ClusterUserDefinedNetwork[],
    udns: UserDefinedNetwork[]
): AttachmentNode[] => {
    const nodes: AttachmentNode[] = [];
    cudns.forEach((cudn) => {
        const namespaces = getCudnAssociatedNamespaces(cudn);
        if (namespaces.length > 0) {
            nodes.push({
                name: cudn.metadata?.name || '',
                type: 'attachment',
                namespaces,
                cudn: cudn.metadata?.name || ''
            });
        }
    });
    udns.forEach((udn) => {
        const name = udn.metadata?.name || '';
        if (!name) return;
        const namespace = udn.metadata?.namespace || 'default';
        nodes.push({
            name, type: 'attachment', namespaces: [namespace], udn: { namespace, name }
        });
    });
    return nodes;
};

export interface GraphContextInput {
    nns: NodeNetworkState;
    cudns?: ClusterUserDefinedNetwork[];
    udns?: UserDefinedNetwork[];
    nads?: NetworkAttachmentDefinition[];
    routeAdvertisements?: RouteAdvertisements[];
    enactments?: NodeNetworkConfigurationEnactment[];
}

const BRIDGE_TYPES = ['linux-bridge', 'ovs-bridge', 'openvswitch'];

export const buildGraphContext = ({
    nns,
    cudns = [],
    udns = [],
    nads = [],
    routeAdvertisements = [],
    enactments = []
}: GraphContextInput): GraphContext => {
    const interfaces: Interface[] = nns?.status?.currentState?.interfaces ?? [];

    return {
        nns,
        interfaces,
        bridgeMappings: nns?.status?.currentState?.ovn?.['bridge-mappings'] ?? [],
        cudns,
        udns,
        nads,
        routeAdvertisements,
        enactments,
        explicitBridgeNames: new Set(
            interfaces.filter((i) => BRIDGE_TYPES.includes(i.type)).map((i) => i.name)
        ),
        controllerNames: new Set(
            interfaces
                .map((i) => i.controller || i.master)
                .filter((name): name is string => Boolean(name))
        ),
        lldpNeighbors: extractLldpNeighbors(interfaces),
        attachmentNodes: buildAttachmentNodes(cudns, udns)
    };
};
