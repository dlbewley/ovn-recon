import {
    LogicalDatabase,
    LogicalRouterRow,
    LogicalSwitchPortRow,
    LogicalSwitchRow,
} from '../types';

// Semantic classification of raw NB rows into {network, role, node, tier}.
//
// Association comes from OVN-Kubernetes naming conventions corroborated by
// external_ids (k8s.ovn.org/network, k8s.ovn.org/topology, k8s.ovn.org/role).
// Never associate by subnet containment: UDN subnets may overlap, and NAT is
// what disambiguates them at runtime. Unrecognized rows classify as an
// explicit 'other-*' role rather than a guess.

export const DEFAULT_NETWORK = 'default';

const NETWORK_EXTERNAL_ID = 'k8s.ovn.org/network';
const TOPOLOGY_EXTERNAL_ID = 'k8s.ovn.org/topology';

export type ConstructRole =
    | 'bridge-mapping'
    | 'cluster-router'
    | 'gateway-router'
    | 'transit-router'
    | 'join-switch'
    | 'transit-switch'
    | 'node-switch'
    | 'layer2-switch'
    | 'localnet-switch'
    | 'external-switch'
    | 'other-router'
    | 'other-switch';

export type PortRole =
    | 'pod-port'
    | 'management-port'
    | 'router-link-port'
    | 'localnet-port'
    | 'remote-port'
    | 'other-port';

// North-to-south tiers of the ladder layout. The waist is the east-west
// join/transit layer between gateway routers and cluster routing.
export type LogicalTier =
    | 'physical'
    | 'external'
    | 'gateway'
    | 'waist'
    | 'cluster-routing'
    | 'workload-switch'
    | 'workload-port';

const TIER_BY_ROLE: Record<ConstructRole, LogicalTier> = {
    'bridge-mapping': 'physical',
    'external-switch': 'external',
    'gateway-router': 'gateway',
    'join-switch': 'waist',
    'transit-switch': 'waist',
    'cluster-router': 'cluster-routing',
    'transit-router': 'cluster-routing',
    'node-switch': 'workload-switch',
    'layer2-switch': 'workload-switch',
    'localnet-switch': 'workload-switch',
    'other-router': 'cluster-routing',
    'other-switch': 'workload-switch',
};

export interface ClassifiedConstruct {
    uuid: string;
    name: string;
    kind: 'router' | 'switch' | 'physnet';
    role: ConstructRole;
    tier: LogicalTier;
    /** DEFAULT_NETWORK, or the k8s.ovn.org/network identity of a UDN/CUDN. */
    network: string;
    /** k8s.ovn.org/topology when the row announces it. */
    topology?: string;
    /** Node the construct is bound to; absent for distributed constructs. */
    node?: string;
}

export interface ClassifiedPort {
    uuid: string;
    name: string;
    role: PortRole;
    /** For pod-port rows named `<namespace>_<pod>`. */
    namespace?: string;
    pod?: string;
    /** For remote-port/management-port rows that encode a node name. */
    node?: string;
}

export interface ClassifiedDatabase {
    constructs: ClassifiedConstruct[];
    constructByUuid: Map<string, ClassifiedConstruct>;
    ports: ClassifiedPort[];
    portByUuid: Map<string, ClassifiedPort>;
    /** All network identities present, DEFAULT_NETWORK first. */
    networks: string[];
}

// OVN-Kubernetes mangles network names into OVN object names by replacing
// dashes with dots: network 'example-p-cudn' appears in names as
// 'example.p.cudn'.
export const mangleNetworkName = (network: string): string => network.replace(/-/g, '.');

const networkOf = (externalIds?: Record<string, string>): string => {
    const network = externalIds?.[NETWORK_EXTERNAL_ID];
    if (!network || network === DEFAULT_NETWORK) {
        return DEFAULT_NETWORK;
    }
    return network;
};

const stripPrefix = (value: string, prefix: string): string | undefined =>
    value.startsWith(prefix) ? value.slice(prefix.length) : undefined;

export const classifyRouter = (row: LogicalRouterRow): ClassifiedConstruct => {
    const network = networkOf(row.externalIds);
    const topology = row.externalIds?.[TOPOLOGY_EXTERNAL_ID];

    let role: ConstructRole = 'other-router';
    let node: string | undefined;

    if (network === DEFAULT_NETWORK) {
        if (row.name === 'ovn_cluster_router') {
            role = 'cluster-router';
        } else {
            const gatewayNode = stripPrefix(row.name, 'GR_');
            if (gatewayNode) {
                role = 'gateway-router';
                node = gatewayNode;
            }
        }
    } else {
        const mangled = mangleNetworkName(network);
        if (row.name === `${mangled}_ovn_cluster_router`) {
            role = 'cluster-router';
        } else if (row.name === `${mangled}_transit_router`) {
            role = 'transit-router';
        } else {
            const gatewayNode = stripPrefix(row.name, `GR_${mangled}_`);
            if (gatewayNode) {
                role = 'gateway-router';
                node = gatewayNode;
            } else if (row.name.startsWith('GR_')) {
                role = 'gateway-router';
            }
        }
    }

    return {
        uuid: row.uuid,
        name: row.name,
        kind: 'router',
        role,
        tier: TIER_BY_ROLE[role],
        network,
        topology,
        node,
    };
};

export const classifySwitch = (row: LogicalSwitchRow): ClassifiedConstruct => {
    const network = networkOf(row.externalIds);
    const topology = row.externalIds?.[TOPOLOGY_EXTERNAL_ID];

    let role: ConstructRole = 'other-switch';
    let node: string | undefined;

    if (network === DEFAULT_NETWORK) {
        if (row.name === 'join') {
            role = 'join-switch';
        } else if (row.name === 'transit_switch') {
            role = 'transit-switch';
        } else {
            const externalNode = stripPrefix(row.name, 'ext_');
            if (externalNode) {
                role = 'external-switch';
                node = externalNode;
            } else if (row.otherConfig?.subnet) {
                // The default network's per-node workload switch is named
                // after the node and carries the node's host subnet.
                role = 'node-switch';
                node = row.name;
            }
        }
    } else {
        const mangled = mangleNetworkName(network);
        if (row.name === `${mangled}_ovn_layer2_switch`) {
            role = 'layer2-switch';
        } else if (row.name === `${mangled}_ovn_localnet_switch`) {
            role = 'localnet-switch';
        } else if (row.name === `${mangled}_join`) {
            role = 'join-switch';
        } else if (row.name === `${mangled}_transit_switch`) {
            role = 'transit-switch';
        } else {
            const externalNode = stripPrefix(row.name, `ext_${mangled}_`);
            if (externalNode) {
                role = 'external-switch';
                node = externalNode;
            } else {
                const layer3Node = stripPrefix(row.name, `${mangled}_`);
                if (layer3Node) {
                    role = 'node-switch';
                    node = layer3Node;
                }
            }
        }
    }

    return {
        uuid: row.uuid,
        name: row.name,
        kind: 'switch',
        role,
        tier: TIER_BY_ROLE[role],
        network,
        topology,
        node,
    };
};

export const classifySwitchPort = (row: LogicalSwitchPortRow): ClassifiedPort => {
    if (row.type === 'router') {
        return { uuid: row.uuid, name: row.name, role: 'router-link-port' };
    }
    if (row.type === 'localnet') {
        return { uuid: row.uuid, name: row.name, role: 'localnet-port' };
    }
    if (row.type === 'remote') {
        // Transit switch ports for other zones are named tstor-<node>.
        const node = stripPrefix(row.name, 'tstor-');
        return { uuid: row.uuid, name: row.name, role: 'remote-port', node };
    }
    if (row.type === '' || row.type === undefined) {
        const managementTarget = stripPrefix(row.name, 'k8s-');
        if (managementTarget !== undefined) {
            return { uuid: row.uuid, name: row.name, role: 'management-port', node: managementTarget };
        }
        const separator = row.name.indexOf('_');
        if (separator > 0) {
            return {
                uuid: row.uuid,
                name: row.name,
                role: 'pod-port',
                namespace: row.name.slice(0, separator),
                pod: row.name.slice(separator + 1),
            };
        }
    }
    return { uuid: row.uuid, name: row.name, role: 'other-port' };
};

export interface NetworkResourceRef {
    apiVersion: 'k8s.ovn.org/v1';
    kind: 'ClusterUserDefinedNetwork' | 'UserDefinedNetwork';
    name: string;
    namespace?: string;
}

/**
 * Resolve a network identity to the CR that created it. CUDN identities are
 * prefixed 'cluster_udn_<name>'; namespaced UDN identities are
 * '<namespace>_<name>' (underscore separator — safe because Kubernetes names
 * cannot contain underscores; dashes stay intact in the identity and only
 * become dots in OVN object names). The default network has no owning CR.
 */
export const networkResourceRef = (network: string): NetworkResourceRef | undefined => {
    if (network === DEFAULT_NETWORK) return undefined;
    if (network.startsWith('cluster_udn_')) {
        return {
            apiVersion: 'k8s.ovn.org/v1',
            kind: 'ClusterUserDefinedNetwork',
            name: network.slice('cluster_udn_'.length),
        };
    }
    const separator = network.indexOf('_');
    if (separator > 0) {
        return {
            apiVersion: 'k8s.ovn.org/v1',
            kind: 'UserDefinedNetwork',
            namespace: network.slice(0, separator),
            name: network.slice(separator + 1),
        };
    }
    return undefined;
};

export const classifyDatabase = (database: LogicalDatabase): ClassifiedDatabase => {
    const constructs: ClassifiedConstruct[] = [
        ...database.logicalRouters.map(classifyRouter),
        ...database.logicalSwitches.map(classifySwitch),
    ];
    const ports = database.logicalSwitchPorts.map(classifySwitchPort);

    const constructByUuid = new Map(constructs.map((construct) => [construct.uuid, construct]));
    const portByUuid = new Map(ports.map((port) => [port.uuid, port]));

    const networks = [DEFAULT_NETWORK];
    for (const construct of constructs) {
        if (!networks.includes(construct.network)) {
            networks.push(construct.network);
        }
    }

    return { constructs, constructByUuid, ports, portByUuid, networks };
};
