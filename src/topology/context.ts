import {
    ClusterUserDefinedNetwork,
    Interface,
    NetworkAttachmentDefinition,
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
     * Names of interfaces that are declared bridges. Needed to resolve the case where
     * an ovs-interface shares its name with the bridge it belongs to; without it the
     * two collide on a single id.
     */
    explicitBridgeNames: Set<string>;
    /** Names appearing as some interface's controller or master. */
    controllerNames: Set<string>;
}

export interface GraphContextInput {
    nns: NodeNetworkState;
    cudns?: ClusterUserDefinedNetwork[];
    udns?: UserDefinedNetwork[];
    nads?: NetworkAttachmentDefinition[];
    routeAdvertisements?: RouteAdvertisements[];
}

const BRIDGE_TYPES = ['linux-bridge', 'ovs-bridge', 'openvswitch'];

export const buildGraphContext = ({
    nns,
    cudns = [],
    udns = [],
    nads = [],
    routeAdvertisements = []
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
        explicitBridgeNames: new Set(
            interfaces.filter((i) => BRIDGE_TYPES.includes(i.type)).map((i) => i.name)
        ),
        controllerNames: new Set(
            interfaces
                .map((i) => i.controller || i.master)
                .filter((name): name is string => Boolean(name))
        )
    };
};
