import type { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import type { Pod } from '../types';

/*
 * Which pods and VMs are attached to which network, on which node (ovn-recon-nfs.4).
 * Pure: no React, no hooks. The network page's placement matrix counts these where the
 * collector cannot (a NAD outside OVN, or no collector answer); the absent-VF links
 * (ovn-recon-s3t.65) are meant to read the same index.
 *
 * Attachments are matched by network name, never by address: UDN and CUDN subnets may
 * overlap, so an IP says nothing about the network it came from.
 */

export const NETWORK_STATUS_ANNOTATION = 'k8s.v1.cni.cncf.io/network-status';
export const POD_NETWORKS_ANNOTATION = 'k8s.ovn.org/pod-networks';

/** What network-status calls the cluster default network. */
export const CLUSTER_DEFAULT_ATTACHMENT = 'ovn-kubernetes';

/** The interface OVN-Kubernetes gives a pod on a primary UDN: ovn-udn1. */
const PRIMARY_UDN_INTERFACE_PREFIX = 'ovn-udn';

/**
 * Namespaces whose NADs a pod in any namespace may use. OpenShift runs Multus with
 * namespaceIsolation on and these as globalNamespaces (the cluster-network-operator's
 * multus daemon config); a NAD anywhere else serves only its own namespace.
 */
export const MULTUS_GLOBAL_NAMESPACES = ['default', 'openshift-multus', 'openshift-sriov-network-operator', 'openshift-cnv'];

/** Past this many namespaces, one cluster-wide watch replaces a socket for each. */
export const MAX_NAMESPACED_WATCHES = 10;

/** Finished pods keep their annotation but hold no attachment; the API need not send them. */
export const ACTIVE_POD_FIELD_SELECTOR = 'status.phase!=Succeeded,status.phase!=Failed';

const FINISHED_PHASES = ['Succeeded', 'Failed'];

/** The fields of a VirtualMachineInstance read here. */
export interface VirtualMachineInstance extends K8sResourceCommon {
    status?: { nodeName?: string };
}

export interface AttachmentInterface {
    name?: string;
    mac?: string;
    ips: string[];
    /** For a device-plugin attachment such as an SR-IOV VF. */
    pciAddress?: string;
}

export interface PodNetworkAttachment {
    /** `namespace/nad`, or CLUSTER_DEFAULT_ATTACHMENT. */
    network: string;
    interfaces: AttachmentInterface[];
}

export interface AttachedWorkload {
    kind: 'pod' | 'vm';
    namespace: string;
    /** The pod's name, or the VirtualMachineInstance's. */
    name: string;
    /** The pod the attachment was read from: for a VM, its virt-launcher pod. */
    pod: string;
}

export interface WorkloadAttachment extends PodNetworkAttachment {
    node: string;
    workload: AttachedWorkload;
}

/** Network name, then node name, to what is attached there. */
export type NetworkAttachmentIndex = Map<string, Map<string, WorkloadAttachment[]>>;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined);

const asString = (value: unknown): string | undefined =>
    (typeof value === 'string' && value !== '' ? value : undefined);

const parseJson = (text: string | undefined): unknown => {
    if (!text) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

/**
 * The NAD of the pod's primary UDN. network-status cannot say: it reports the primary
 * UDN's interface under the name `ovn-kubernetes`, the plugin that returned it. The
 * pod-networks annotation keys every OVN-Kubernetes network by NAD and gives its role.
 */
const primaryUdnOf = (pod: Pod): string | undefined => {
    const networks = asRecord(parseJson(pod.metadata?.annotations?.[POD_NETWORKS_ANNOTATION]));
    return Object.keys(networks ?? {})
        .find((name) => name !== 'default' && asRecord(networks?.[name])?.role === 'primary');
};

const networkOfEntry = (entry: Record<string, unknown>, pod: Pod): string | undefined => {
    const name = asString(entry.name);
    if (!name) return undefined;
    if (name === CLUSTER_DEFAULT_ATTACHMENT) {
        return asString(entry.interface)?.startsWith(PRIMARY_UDN_INTERFACE_PREFIX)
            ? primaryUdnOf(pod)
            : CLUSTER_DEFAULT_ATTACHMENT;
    }
    return name.includes('/') ? name : `${pod.metadata?.namespace || 'default'}/${name}`;
};

const interfaceOfEntry = (entry: Record<string, unknown>): AttachmentInterface => {
    const pciAddress = asString(asRecord(asRecord(entry['device-info'])?.pci)?.['pci-address']);
    return {
        name: asString(entry.interface),
        mac: asString(entry.mac),
        ips: Array.isArray(entry.ips) ? entry.ips.filter((ip): ip is string => typeof ip === 'string') : [],
        ...(pciAddress ? { pciAddress } : {}),
    };
};

/** The networks one pod's network-status reports, each once. Empty when absent or malformed. */
export const parsePodAttachments = (pod: Pod): PodNetworkAttachment[] => {
    const entries = parseJson(pod.metadata?.annotations?.[NETWORK_STATUS_ANNOTATION]);
    if (!Array.isArray(entries)) return [];
    const byNetwork = new Map<string, AttachmentInterface[]>();
    entries.forEach((value) => {
        const entry = asRecord(value);
        const network = entry && networkOfEntry(entry, pod);
        if (!entry || !network) return;
        byNetwork.set(network, [...(byNetwork.get(network) ?? []), interfaceOfEntry(entry)]);
    });
    return Array.from(byNetwork, ([network, interfaces]) => ({ network, interfaces }));
};

const launcherVmiName = (pod: Pod): string | undefined =>
    pod.metadata?.ownerReferences?.find((owner) =>
        owner.kind === 'VirtualMachineInstance' && owner.apiVersion?.startsWith('kubevirt.io/'))?.name;

/**
 * Every attachment of the running workloads, by network and node. A virt-launcher pod
 * stands for its VirtualMachineInstance. A VM has two launcher pods while it migrates,
 * so with `vmis` given only the one on the node the VMI reports is read, and the VM is
 * counted once. Pods not yet scheduled and pods that have finished attach nothing.
 */
export const buildAttachmentIndex = (pods: Pod[], vmis?: VirtualMachineInstance[]): NetworkAttachmentIndex => {
    const vmiNodes = new Map((vmis ?? []).map((vmi) =>
        [`${vmi.metadata?.namespace}/${vmi.metadata?.name}`, vmi.status?.nodeName]));
    const index: NetworkAttachmentIndex = new Map();
    pods.forEach((pod) => {
        const node = pod.spec?.nodeName;
        const namespace = pod.metadata?.namespace || 'default';
        const podName = pod.metadata?.name || '';
        if (!node || FINISHED_PHASES.includes(pod.status?.phase ?? '')) return;
        const vmi = launcherVmiName(pod);
        const vmiNode = vmi ? vmiNodes.get(`${namespace}/${vmi}`) : undefined;
        if (vmiNode && vmiNode !== node) return;
        const workload: AttachedWorkload = vmi
            ? { kind: 'vm', namespace, name: vmi, pod: podName }
            : { kind: 'pod', namespace, name: podName, pod: podName };
        parsePodAttachments(pod).forEach((attachment) => {
            const nodes = index.get(attachment.network) ?? new Map<string, WorkloadAttachment[]>();
            index.set(attachment.network, nodes);
            nodes.set(node, [...(nodes.get(node) ?? []), { ...attachment, node, workload }]);
        });
    });
    return index;
};

/** Where to watch pods for some networks. `namespaces` undefined means cluster-wide. */
export interface AttachmentWatchScope {
    namespaces?: string[];
}

/**
 * The narrowest pod watch that sees every attachment to the named networks: each NAD's
 * own namespace, unless the network is the cluster default or a NAD sits in a Multus
 * global namespace, whose users can be anywhere.
 */
export const attachmentWatchScope = (networks: string[]): AttachmentWatchScope => {
    const namespaces = Array.from(new Set(networks.map((network) => network.split('/')[0]))).sort();
    const clusterWide = networks.some((network) => !network.includes('/'))
        || namespaces.some((namespace) => MULTUS_GLOBAL_NAMESPACES.includes(namespace))
        || namespaces.length > MAX_NAMESPACED_WATCHES;
    return clusterWide ? {} : { namespaces };
};
