import { K8sResourceCommon, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';

import {
    ClusterUserDefinedNetwork,
    NetworkAttachmentDefinition,
    NodeNetworkConfigurationEnactment,
    NodeNetworkState,
    RouteAdvertisements,
    UserDefinedNetwork,
} from '../types';
import { CollectorState, useCollectorState } from './CollectorStatus';

/**
 * The explorer's cluster-wide watches (ovn-recon-gbr.10; formerly the overview page's
 * `useOverviewData`): every NodeNetworkState, Node, CUDN, UDN, NAD,
 * RouteAdvertisements and NodeNetworkConfigurationEnactment, and the collector's
 * state. `useExplorerData` builds the tree, the tables and the findings from them,
 * once, for the whole shell.
 */

/** Stable empties: a fresh `[]` per render would re-evaluate every finding. */
const NO_NODES: K8sResourceCommon[] = [];
const NO_CUDNS: ClusterUserDefinedNetwork[] = [];
const NO_UDNS: UserDefinedNetwork[] = [];
const NO_NADS: NetworkAttachmentDefinition[] = [];
const NO_ROUTE_ADVERTISEMENTS: RouteAdvertisements[] = [];
const NO_ENACTMENTS: NodeNetworkConfigurationEnactment[] = [];

const listOr = <T,>(list: T[] | undefined | null, empty: T[]): T[] => (Array.isArray(list) ? list : empty);

export interface ClusterWatches {
    /** Every node's NodeNetworkState; undefined or null while loading, refused or absent. */
    nodeNetworkStates: NodeNetworkState[] | undefined | null;
    nodeNetworkStatesLoaded: boolean;
    /** Why NodeNetworkState could not be read, when it could not. */
    nodeNetworkStatesError?: string;
    nodes: K8sResourceCommon[];
    cudns: ClusterUserDefinedNetwork[];
    udns: UserDefinedNetwork[];
    nads: NetworkAttachmentDefinition[];
    routeAdvertisements: RouteAdvertisements[];
    enactments: NodeNetworkConfigurationEnactment[];
    /** The CUDN, UDN and NAD watches have each settled: loaded, or failed. */
    networksLoaded: boolean;
    collector: CollectorState;
}

const errorText = (error: unknown): string | undefined => {
    if (!error) return undefined;
    return (error instanceof Error ? error.message : (error as { message?: string }).message) || String(error);
};

/** Everything the shell reads: the watches the plugin already makes, and the collector. */
export const useClusterWatches = (): ClusterWatches => {
    const [nodeNetworkStates, nnsLoaded, nnsError] = useK8sWatchResource<NodeNetworkState[]>({
        groupVersionKind: { group: 'nmstate.io', version: 'v1beta1', kind: 'NodeNetworkState' },
        isList: true,
    });
    const [nodes] = useK8sWatchResource<K8sResourceCommon[]>({
        groupVersionKind: { version: 'v1', kind: 'Node' },
        isList: true,
    });
    const [cudns, cudnsLoaded, cudnsError] = useK8sWatchResource<ClusterUserDefinedNetwork[]>({
        groupVersionKind: { group: 'k8s.ovn.org', version: 'v1', kind: 'ClusterUserDefinedNetwork' },
        isList: true,
    });
    const [udns, udnsLoaded, udnsError] = useK8sWatchResource<UserDefinedNetwork[]>({
        groupVersionKind: { group: 'k8s.ovn.org', version: 'v1', kind: 'UserDefinedNetwork' },
        isList: true,
    });
    const [nads, nadsLoaded, nadsError] = useK8sWatchResource<NetworkAttachmentDefinition[]>({
        groupVersionKind: { group: 'k8s.cni.cncf.io', version: 'v1', kind: 'NetworkAttachmentDefinition' },
        isList: true,
    });
    const [routeAdvertisements] = useK8sWatchResource<RouteAdvertisements[]>({
        groupVersionKind: { group: 'k8s.ovn.org', version: 'v1', kind: 'RouteAdvertisements' },
        isList: true,
    });
    // The per-node record of which NNCP configured what, for the findings that read it
    // (bond-degraded, nnce-failing), as the node page watches it. Without nmstate, or
    // without permission, the watch yields nothing and those rules stay quiet.
    const [enactments] = useK8sWatchResource<NodeNetworkConfigurationEnactment[]>({
        groupVersionKind: { group: 'nmstate.io', version: 'v1beta1', kind: 'NodeNetworkConfigurationEnactment' },
        isList: true,
    });
    const collector = useCollectorState();

    return {
        nodeNetworkStates,
        nodeNetworkStatesLoaded: nnsLoaded,
        nodeNetworkStatesError: errorText(nnsError),
        nodes: listOr(nodes, NO_NODES),
        cudns: listOr(cudns, NO_CUDNS),
        udns: listOr(udns, NO_UDNS),
        nads: listOr(nads, NO_NADS),
        routeAdvertisements: listOr(routeAdvertisements, NO_ROUTE_ADVERTISEMENTS),
        enactments: listOr(enactments, NO_ENACTMENTS),
        // A kind the cluster does not serve, or one the user may not list, has settled
        // too: the table then lists what the other kinds hold.
        networksLoaded: (cudnsLoaded || Boolean(cudnsError))
            && (udnsLoaded || Boolean(udnsError))
            && (nadsLoaded || Boolean(nadsError)),
        collector,
    };
};
