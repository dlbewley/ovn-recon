import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

/** A port on a bridge interface. OVS records an access VLAN tag here. */
export interface BridgePort {
    name: string;
    vlan?: { mode?: string; tag?: number };
}

/**
 * nmstate emits `prefix-length`; some captures and older shapes use
 * `prefix_length`. Both are declared so call sites are forced to consider it --
 * see getIpv4Addresses in nodeVisualizationSelectors.
 */
export interface Ipv4AddressEntry {
    ip: string;
    'prefix-length'?: number;
    prefix_length?: number;
}

export interface Interface {
    name: string;
    type: string;
    state: string;
    controller?: string;
    master?: string;
    vlan?: { 'base-iface': string; id?: number; protocol?: string };
    'mac-vlan'?: { 'base-iface': string };
    /** OVS patch port: nmstate reports the reciprocal peer port. */
    patch?: { peer?: string };
    /** Present on bridge interfaces. Not to be confused with OvnBridgeMapping.bridge, which is a name. */
    bridge?: { port?: BridgePort[]; ports?: BridgePort[] };
    localnet?: string;
    mtu?: number;
    mac_address?: string;
    'mac-address'?: string;
    vrf?: { port?: string[] | string; 'route-table-id'?: number };
    ipv4?: { enabled?: boolean; address?: Ipv4AddressEntry[] };
    [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface OvnBridgeMapping {
    localnet: string;
    bridge: string;
    state?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
}

export interface NodeNetworkState extends K8sResourceCommon {
    status?: {
        currentState?: {
            interfaces: Interface[];
            ovn?: {
                'bridge-mappings': OvnBridgeMapping[];
            };
        };
    };
}

/** metav1.LabelSelector, as used by CUDN namespaceSelector and RA network selectors. */
export interface LabelSelector {
    matchLabels?: { [key: string]: string };
    matchExpressions?: { key: string; operator: string; values?: string[] }[];
}

export interface UserDefinedNetwork extends K8sResourceCommon {
    spec?: {
        topology?: string; // 'Layer2' | 'Layer3' (UserDefinedNetworkSpec has topology at spec level)
        layer2?: { role?: 'Primary' | 'Secondary'; subnets?: string[] };
        layer3?: { role?: 'Primary' | 'Secondary'; subnets?: string[] };
    };
    status?: {
        conditions?: { type: string; status: string; message?: string }[];
    };
}

export interface ClusterUserDefinedNetwork extends K8sResourceCommon {
    spec?: {
        /** The declared rule that scopes namespaces into this network. */
        namespaceSelector?: LabelSelector;
        network?: {
            topology: string;
            // Same shape as `localnet`; both capitalizations appear in the wild.
            localNet?: {
                physicalNetworkName: string;
                role?: 'Primary' | 'Secondary';
                vlan?: { access: { id: number } };
            };
            localnet?: {
                physicalNetworkName: string;
                role?: 'Primary' | 'Secondary';
                vlan?: { access: { id: number } };
            };
            layer2?: {
                role?: 'Primary' | 'Secondary';
                subnets?: string[];
                joinSubnets?: string[];
            };
            layer3?: {
                role?: 'Primary' | 'Secondary';
                subnets?: string[];
                joinSubnets?: string[];
            };
        };
    };
    status?: {
        conditions?: { type: string; status: string; message?: string }[];
    };
}

/**
 * The per-node record of an applied NodeNetworkConfigurationPolicy. Its
 * status.desiredState names exactly which interfaces and bridge mappings the
 * policy configured on this node -- an observation, not a name-matching guess.
 */
export interface NodeNetworkConfigurationEnactment extends K8sResourceCommon {
    status?: {
        desiredState?: {
            interfaces?: { name: string; type?: string }[];
            ovn?: { 'bridge-mappings'?: { bridge?: string; localnet?: string; state?: string }[] };
        };
        conditions?: { type: string; status: string; reason?: string; message?: string }[];
        policyGeneration?: number;
    };
}

export interface NetworkAttachmentDefinition extends K8sResourceCommon {
    spec?: {
        config: string;
    };
}

export interface RouteAdvertisements extends K8sResourceCommon {
    spec?: {
        networkSelectors?: {
            clusterUserDefinedNetworkSelector?: {
                networkSelector?: {
                    matchLabels?: { [key: string]: string };
                    matchExpressions?: { key: string; operator: string; values: string[] }[];
                };
            };
        }[];
    };
}

export interface LogicalTopologyMetadata {
    schemaVersion: string;
    generatedAt: string;
    sourceHealth: string;
    nodeName: string;
}

export interface LogicalTopologyWarning {
    code: string;
    message: string;
}

/** @deprecated v1 graph payload; v2 consumers read LogicalDatabase instead. */
export interface LogicalTopologyNode {
    id: string;
    kind: string;
    label: string;
    data?: Record<string, unknown>;
}

/** @deprecated v1 graph payload; v2 consumers read LogicalDatabase instead. */
export interface LogicalTopologyEdge {
    id: string;
    source: string;
    target: string;
    kind: string;
    data?: Record<string, unknown>;
}

/** @deprecated v1 graph payload; v2 consumers read LogicalDatabase instead. */
export interface LogicalTopologyGroup {
    id: string;
    label: string;
    nodeIds: string[];
}

// v2 snapshot contract (metadata.schemaVersion === LOGICAL_TOPOLOGY_SCHEMA_V2):
// a table-oriented transcription of the OVN NB tables. Mirrors
// collector/internal/snapshot/types.go and
// collector/api/logical-topology-snapshot.schema.json.
export const LOGICAL_TOPOLOGY_SCHEMA_V2 = '2';

export interface LogicalRouterRow {
    uuid: string;
    name: string;
    ports: string[];
    nat?: string[];
    staticRoutes?: string[];
    options?: Record<string, string>;
    externalIds?: Record<string, string>;
}

export interface LogicalRouterPortRow {
    uuid: string;
    name: string;
    mac?: string;
    networks?: string[];
    peer?: string;
    gatewayChassis?: string[];
    options?: Record<string, string>;
    externalIds?: Record<string, string>;
}

export interface LogicalSwitchRow {
    uuid: string;
    name: string;
    ports: string[];
    otherConfig?: Record<string, string>;
    externalIds?: Record<string, string>;
}

export interface LogicalSwitchPortRow {
    uuid: string;
    name: string;
    type?: string;
    addresses?: string[];
    options?: Record<string, string>;
    externalIds?: Record<string, string>;
}

export type NATType = 'snat' | 'dnat' | 'dnat_and_snat';

export interface NATRow {
    uuid: string;
    type: NATType;
    externalIp?: string;
    logicalIp?: string;
    logicalPort?: string;
    externalMac?: string;
    options?: Record<string, string>;
    externalIds?: Record<string, string>;
}

export interface StaticRouteRow {
    uuid: string;
    ipPrefix: string;
    nexthop?: string;
    policy?: string;
    outputPort?: string;
    options?: Record<string, string>;
    externalIds?: Record<string, string>;
}

export interface LogicalDatabase {
    logicalRouters: LogicalRouterRow[];
    logicalRouterPorts: LogicalRouterPortRow[];
    logicalSwitches: LogicalSwitchRow[];
    logicalSwitchPorts: LogicalSwitchPortRow[];
    nats: NATRow[];
    staticRoutes: StaticRouteRow[];
}

export interface LogicalTopologySnapshot {
    metadata: LogicalTopologyMetadata;
    /** v2 payload; absent on v1 snapshots from a not-yet-upgraded collector. */
    database?: LogicalDatabase;
    /** @deprecated v1 graph payload. */
    nodes: LogicalTopologyNode[];
    /** @deprecated v1 graph payload. */
    edges: LogicalTopologyEdge[];
    /** @deprecated v1 graph payload. */
    groups: LogicalTopologyGroup[];
    warnings: LogicalTopologyWarning[];
}

export interface OvnRecon extends K8sResourceCommon {
    spec?: {
        collector?: {
            enabled?: boolean;
        };
        featureGates?: {
            'ovn-collector'?: boolean;
            [key: string]: boolean | undefined;
        };
        features?: {
            'ovn-collector'?: boolean;
            [key: string]: boolean | undefined;
        };
    };
}
