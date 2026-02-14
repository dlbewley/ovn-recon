import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

export interface Interface {
    name: string;
    type: string;
    state: string;
    controller?: string;
    master?: string;
    vlan?: { 'base-iface': string };
    'mac-vlan'?: { 'base-iface': string };
    patch?: boolean;
    bridge?: string;
    localnet?: string;
    mtu?: number;
    mac_address?: string;
    ipv4?: { address: { ip: string; prefix_length: number }[] };
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
        network?: {
            topology: string;
            localNet?: {
                physicalNetworkName: string;
            };
            localnet?: {
                physicalNetworkName: string;
                vlan?: { access: { id: number } };
            };
            layer2?: {
                subnets?: string[];
                joinSubnets?: string[];
            };
            layer3?: {
                subnets?: string[];
                joinSubnets?: string[];
            };
        };
    };
    status?: {
        conditions?: { type: string; status: string; message?: string }[];
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

export interface LogicalTopologyNode {
    id: string;
    kind: string;
    label: string;
    data?: Record<string, unknown>;
}

export interface LogicalTopologyEdge {
    id: string;
    source: string;
    target: string;
    kind: string;
    data?: Record<string, unknown>;
}

export interface LogicalTopologyGroup {
    id: string;
    label: string;
    nodeIds: string[];
}

export interface LogicalTopologySnapshot {
    metadata: LogicalTopologyMetadata;
    nodes: LogicalTopologyNode[];
    edges: LogicalTopologyEdge[];
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
