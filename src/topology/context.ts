import {
    extractLldpNeighbors, getCudnAssociatedNamespaces, getKnownVtepNames, parseNodeVteps, LldpNeighborNode
} from '../components/nodeVisualizationSelectors';
import { AttachmentNode, IntegrationBridgeNode } from './types';
import {
    ClusterUserDefinedNetwork,
    Interface,
    NetworkAttachmentDefinition,
    NodeNetworkConfigurationEnactment,
    NodeNetworkState,
    OvnBridgeMapping,
    RouteAdvertisements,
    UserDefinedNetwork,
    Vtep
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
     * The cluster's VTEP resources (ovn-recon-s3t.53). Empty before EVPN, when the
     * reader may not list them, and for an imported NNS.
     */
    vteps: Vtep[];
    /**
     * The address OVN-Kubernetes discovered for each VTEP on THIS node, from the
     * Node's k8s.ovn.org/vteps annotation, keyed by VTEP name. Empty when the Node
     * was not read or carries no annotation.
     */
    nodeVteps: Record<string, string[]>;
    /**
     * Every VTEP name known from any source -- VTEP resources, CUDN specs, the Node
     * annotation. A device is matched to a VTEP by deriving the device name each of
     * these would produce.
     */
    vtepNames: string[];
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
     * The OVS integration bridge, when its ports reveal it. nmstate reports no
     * br-int interface -- the bridge exists only as its ports' controller value.
     */
    integrationBridge?: IntegrationBridgeNode;
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
    vteps?: Vtep[];
    /** The raw k8s.ovn.org/vteps annotation off this node's Node object. */
    nodeVtepsAnnotation?: string;
}

const BRIDGE_TYPES = ['linux-bridge', 'ovs-bridge', 'openvswitch'];

/** OVN-Kubernetes's integration bridge has one fixed name. */
const INTEGRATION_BRIDGE_NAME = 'br-int';

const buildIntegrationBridge = (interfaces: Interface[]): IntegrationBridgeNode | undefined => {
    const ports = interfaces.filter(
        (iface) => (iface.controller || iface.master) === INTEGRATION_BRIDGE_NAME);
    return ports.length > 0 ? { name: INTEGRATION_BRIDGE_NAME, ports } : undefined;
};

export const buildGraphContext = ({
    nns,
    cudns = [],
    udns = [],
    nads = [],
    routeAdvertisements = [],
    enactments = [],
    vteps = [],
    nodeVtepsAnnotation
}: GraphContextInput): GraphContext => {
    const interfaces: Interface[] = nns?.status?.currentState?.interfaces ?? [];
    const nodeVteps = parseNodeVteps(nodeVtepsAnnotation);

    return {
        nns,
        interfaces,
        bridgeMappings: nns?.status?.currentState?.ovn?.['bridge-mappings'] ?? [],
        cudns,
        udns,
        nads,
        routeAdvertisements,
        enactments,
        vteps,
        nodeVteps,
        vtepNames: getKnownVtepNames(vteps, cudns, nodeVteps),
        explicitBridgeNames: new Set(
            interfaces.filter((i) => BRIDGE_TYPES.includes(i.type)).map((i) => i.name)
        ),
        controllerNames: new Set(
            interfaces
                .map((i) => i.controller || i.master)
                .filter((name): name is string => Boolean(name))
        ),
        lldpNeighbors: extractLldpNeighbors(interfaces),
        integrationBridge: buildIntegrationBridge(interfaces),
        attachmentNodes: buildAttachmentNodes(cudns, udns)
    };
};
