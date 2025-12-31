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
