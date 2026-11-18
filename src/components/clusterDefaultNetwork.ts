import {
    generatedNads,
    listNetworks,
    networkCreationFailure,
    NetworkInputs,
    NetworkRecord,
} from './networkPageModel';
import { getCudnAssociatedNamespaces } from './nodeVisualizationSelectors';
import type { ClusterUserDefinedNetwork } from '../types';

/*
 * What OVN Recon says about the cluster default network (ovn-recon-nfs.8). Pure, and
 * apart from the page so the default network page of ovn-recon-nfs.3 can reuse it.
 */

/** What the network is, true of every cluster whatever else is installed. */
export const CLUSTER_DEFAULT_NETWORK_TEXT =
    'This is the cluster default network, defined by the Cluster Network Operator and present on every node. '
    + 'Pods in a namespace with a primary user-defined network (UDN) still attach to it for kubelet probes and '
    + 'metrics; for those pods it is the infrastructure-locked network.';

const namespacesOf = (record: NetworkRecord, inputs: NetworkInputs): string[] => {
    if (record.kind !== 'cudn') return record.namespace ? [record.namespace] : [];
    return [
        ...getCudnAssociatedNamespaces(record.resource as ClusterUserDefinedNetwork),
        ...generatedNads(record, inputs).map((nad) => nad.metadata?.namespace || 'default'),
    ];
};

/**
 * The namespaces served by a primary network, sorted: a primary UDN's own, those a
 * primary CUDN reports or generated a NAD in, and a primary NAD's with neither behind
 * it. A network OVN-Kubernetes refused to create serves nothing, so it does not count.
 * An empty list means none is visible, not that none exists: the watches may still be
 * loading, or be refused.
 */
export const primaryUdnNamespaces = (inputs: NetworkInputs): string[] => {
    const namespaces = listNetworks(inputs)
        .filter((record) => record.placement === 'primary' && !networkCreationFailure(record))
        .flatMap((record) => namespacesOf(record, inputs));
    return Array.from(new Set(namespaces)).sort((a, b) => a.localeCompare(b));
};

/** The description, naming the namespaces with a primary UDN when any are visible. */
export const clusterDefaultNetworkText = (inputs: NetworkInputs): string => {
    const namespaces = primaryUdnNamespaces(inputs);
    if (namespaces.length === 0) return CLUSTER_DEFAULT_NETWORK_TEXT;
    const label = namespaces.length === 1 ? 'Namespace' : 'Namespaces';
    return `${CLUSTER_DEFAULT_NETWORK_TEXT} ${label} with a primary UDN: ${namespaces.join(', ')}.`;
};

/**
 * What a cluster without NodeNetworkState costs a network's page. The default network
 * is on every node regardless, so it loses only the physical detail; any other network
 * loses the answer to where it is wired.
 */
export const nodeNetworkStateUnavailableText = (record: Pick<NetworkRecord, 'clusterDefault'>): string =>
    'This cluster does not serve NodeNetworkState (it comes with the Kubernetes NMState Operator), so '
    + `${record.clusterDefault
        ? 'the per-node physical detail (br-ex, uplinks) cannot be drawn'
        : 'where this network is wired cannot be shown'}.`;
