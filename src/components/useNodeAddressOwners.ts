import * as React from 'react';

import type {
    ClusterUserDefinedNetwork,
    LogicalDatabase,
    NetworkAttachmentDefinition,
    NodeNetworkState,
    UserDefinedNetwork,
} from '../types';
import { AddressBook, AddressOwner, buildAddressBook, resolveAddress } from './addressBook';
import type { GatewayOwners } from './KernelRouteTable';
import {
    classifyMasqueradeAddress,
    isUdnMasqueradeRole,
    MASQUERADE_ROLE_LABELS,
    MasqueradeNetworkInputs,
    masqueradeSubnets,
    MasqueradeSubnet,
    NODE_MASQUERADE_SUBNET_ANNOTATION,
    resolveMasqueradeNetwork,
} from './masqueradeIps';

export interface NodeAddressOwnersInputs {
    nodeName: string;
    /** The NodeNetworkStates the view already watches; this node's alone will do. */
    nodeNetworkStates: readonly NodeNetworkState[];
    /** The node's zone database, when the view already holds one. Never fetched here. */
    zoneDatabase?: LogicalDatabase;
    cudns?: readonly ClusterUserDefinedNetwork[];
    udns?: readonly UserDefinedNetwork[];
    nads?: readonly NetworkAttachmentDefinition[];
    /** The raw k8s.ovn.org/node-masquerade-subnet annotation off this node's Node. */
    nodeMasqueradeSubnetAnnotation?: string;
}

const NO_NETWORKS: readonly never[] = [];

/**
 * A masquerade address the book does not know, read off the node's routes:
 * the book derives a network's pair only for a primary network its NADs name,
 * and a route to `169.254.0.16/32 dev ovn-k8s-mp3` is the host's own evidence
 * that the pair is in use. Named by its offset, and by the network that
 * carries the ID when exactly one does.
 */
export const routeMasqueradeOwner = (
    address: string,
    nodeName: string,
    subnets: readonly MasqueradeSubnet[],
    networks: MasqueradeNetworkInputs,
): AddressOwner | undefined => {
    const classification = classifyMasqueradeAddress(address, subnets);
    if (!classification) return undefined;
    const { role, networkId, subnet } = classification;
    const resolved = isUdnMasqueradeRole(role) && networkId !== undefined
        ? resolveMasqueradeNetwork(networkId, networks)
        : undefined;
    const network = resolved?.network;
    const label = MASQUERADE_ROLE_LABELS[role] + (networkId === undefined ? ''
        : network ? ` of ${network.kind === 'cudn' ? `CUDN ${network.name}` : `UDN ${network.namespace}/${network.name}`}`
            : ` of network ID ${networkId}`);
    return {
        kind: 'masquerade',
        ref: {
            type: 'masquerade',
            role,
            ...(networkId !== undefined ? { networkId } : {}),
            ...(network ? { network } : {}),
        },
        label,
        ...(resolved?.ovnNetwork ? { network: resolved.ovnNetwork } : {}),
        provenance: [{ source: 'NodeNetworkState', record: nodeName, field: 'routes.running', value: address }],
        masquerade: {
            role,
            ...(networkId !== undefined ? { networkId } : {}),
            subnet,
            basis: 'observed',
            ...(resolved?.ambiguous ? { ambiguous: resolved.ambiguous } : {}),
        },
    };
};

/**
 * Who holds an address read on a node's routes (ovn-recon-dp7.4, ovn-recon-2n6.4),
 * from what the view already watches: NodeNetworkStates, the networks (to name
 * the network a management-port masquerade address belongs to) and the Node's
 * masquerade subnet annotation. No watch or request of its own. The book is
 * built when a table first asks.
 */
export const useNodeAddressOwners = ({
    nodeName,
    nodeNetworkStates,
    zoneDatabase,
    cudns = NO_NETWORKS,
    udns = NO_NETWORKS,
    nads = NO_NETWORKS,
    nodeMasqueradeSubnetAnnotation,
}: NodeAddressOwnersInputs): GatewayOwners =>
    React.useMemo<GatewayOwners>(() => {
        let book: AddressBook | undefined;
        let subnets: MasqueradeSubnet[] | undefined;
        const networks = { cudns, udns, nads };
        const nodes = nodeMasqueradeSubnetAnnotation
            ? [{ metadata: { name: nodeName, annotations: { [NODE_MASQUERADE_SUBNET_ANNOTATION]: nodeMasqueradeSubnetAnnotation } } }]
            : [];
        return (address) => {
            book ??= buildAddressBook({
                zones: zoneDatabase ? [{ node: nodeName, database: zoneDatabase }] : [],
                nodeNetworkStates,
                // Only the annotation: the Node's addresses are already on its interfaces.
                nodes,
                networks,
            });
            const owners = resolveAddress(book, address, { preferNode: nodeName });
            if (owners.length > 0) return owners;
            subnets ??= masqueradeSubnets({ nodes, databases: zoneDatabase ? [zoneDatabase] : [] });
            const fallback = routeMasqueradeOwner(address, nodeName, subnets, networks);
            return fallback ? [fallback] : owners;
        };
    }, [nodeName, nodeNetworkStates, zoneDatabase, cudns, udns, nads, nodeMasqueradeSubnetAnnotation]);
