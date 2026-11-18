import type { Pod } from '../types';
import {
    attachmentWatchScope,
    buildAttachmentIndex,
    CLUSTER_DEFAULT_ATTACHMENT,
    MAX_NAMESPACED_WATCHES,
    NETWORK_STATUS_ANNOTATION,
    parsePodAttachments,
    POD_NETWORKS_ANNOTATION,
    VirtualMachineInstance,
} from './workloadAttachments';

// Shapes follow the OVN-Kubernetes user-defined network documentation; written by hand,
// not captured from a cluster.
const defaultEntry = { name: 'ovn-kubernetes', interface: 'eth0', ips: ['10.128.0.5'], mac: '0a:58:0a:80:00:05', default: true };
const entry = (name: string, iface = 'net1') => ({ name, interface: iface, ips: ['192.168.10.5'], mac: '02:00:00:00:00:01' });

const pod = (name: string, node: string | undefined, status: unknown, extra: Partial<Pod['metadata']> = {}, phase = 'Running'): Pod => ({
    metadata: {
        name,
        namespace: 'blue',
        ...extra,
        annotations: {
            [NETWORK_STATUS_ANNOTATION]: typeof status === 'string' ? status : JSON.stringify(status),
            ...extra.annotations,
        },
    },
    spec: { nodeName: node },
    status: { phase },
});

const launcher = (name: string, vmi: string, node: string, status: unknown): Pod => pod(name, node, status, {
    ownerReferences: [{ apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachineInstance', name: vmi, uid: 'u1', controller: true }],
});

const vmiOn = (name: string, nodeName?: string): VirtualMachineInstance => ({
    metadata: { name, namespace: 'blue' },
    status: { nodeName },
});

describe('parsePodAttachments', () => {
    it('reads the default network and a secondary NAD, with their interfaces', () => {
        const sriov = {
            ...entry('blue/sriov-net'),
            'device-info': { type: 'pci', version: '1.1.0', pci: { 'pci-address': '0000:41:02.0' } },
        };
        expect(parsePodAttachments(pod('a', 'worker-1', [defaultEntry, sriov]))).toEqual([
            {
                network: CLUSTER_DEFAULT_ATTACHMENT,
                interfaces: [{ name: 'eth0', mac: '0a:58:0a:80:00:05', ips: ['10.128.0.5'] }],
            },
            {
                network: 'blue/sriov-net',
                interfaces: [{ name: 'net1', mac: '02:00:00:00:00:01', ips: ['192.168.10.5'], pciAddress: '0000:41:02.0' }],
            },
        ]);
    });

    it('lists a network attached twice once, with both interfaces', () => {
        const [attachment] = parsePodAttachments(pod('a', 'worker-1', [entry('blue/net', 'net1'), entry('blue/net', 'net2')]));
        expect(attachment.interfaces.map((iface) => iface.name)).toEqual(['net1', 'net2']);
    });

    it('names a primary UDN from pod-networks, because network-status calls it ovn-kubernetes', () => {
        const primary = pod('a', 'worker-1', [
            { ...defaultEntry, default: undefined },
            { name: 'ovn-kubernetes', interface: 'ovn-udn1', ips: ['10.20.0.5'], mac: '0a:58:0a:14:00:05', default: true },
        ], {
            annotations: {
                [POD_NETWORKS_ANNOTATION]: JSON.stringify({
                    default: { role: 'infrastructure-locked' },
                    'blue/tenant': { role: 'primary' },
                }),
            },
        });
        expect(parsePodAttachments(primary).map((attachment) => attachment.network))
            .toEqual([CLUSTER_DEFAULT_ATTACHMENT, 'blue/tenant']);
    });

    it('does not take the default network for a primary UDN', () => {
        const plain = pod('a', 'worker-1', [defaultEntry], {
            annotations: { [POD_NETWORKS_ANNOTATION]: JSON.stringify({ default: { role: 'primary' } }) },
        });
        expect(parsePodAttachments(plain).map((attachment) => attachment.network)).toEqual([CLUSTER_DEFAULT_ATTACHMENT]);
    });

    it('reads a bare NAD name as being in the pod\'s namespace', () => {
        expect(parsePodAttachments(pod('a', 'worker-1', [entry('net')]))[0].network).toBe('blue/net');
    });

    it('reads nothing from a missing or malformed annotation', () => {
        expect(parsePodAttachments({ metadata: { name: 'a' } })).toEqual([]);
        expect(parsePodAttachments(pod('a', 'worker-1', 'not json'))).toEqual([]);
        expect(parsePodAttachments(pod('a', 'worker-1', { name: 'not-a-list' }))).toEqual([]);
    });
});

describe('buildAttachmentIndex', () => {
    const on = (index: ReturnType<typeof buildAttachmentIndex>, network: string, node: string) =>
        (index.get(network)?.get(node) ?? []).map((attachment) => `${attachment.workload.kind}:${attachment.workload.name}`);

    it('groups attachments by network, then node', () => {
        const index = buildAttachmentIndex([
            pod('a', 'worker-1', [entry('blue/net')]),
            pod('b', 'worker-1', [entry('blue/net')]),
            pod('c', 'worker-2', [entry('blue/net'), entry('blue/other', 'net2')]),
        ]);
        expect(on(index, 'blue/net', 'worker-1')).toEqual(['pod:a', 'pod:b']);
        expect(on(index, 'blue/net', 'worker-2')).toEqual(['pod:c']);
        expect(on(index, 'blue/other', 'worker-2')).toEqual(['pod:c']);
        expect(on(index, 'blue/net', 'worker-3')).toEqual([]);
    });

    it('keeps two networks apart when their addresses are the same', () => {
        const index = buildAttachmentIndex([
            pod('a', 'worker-1', [entry('blue/net')]),
            pod('b', 'worker-1', [entry('green/net')], { namespace: 'green' }),
        ]);
        expect(on(index, 'blue/net', 'worker-1')).toEqual(['pod:a']);
        expect(on(index, 'green/net', 'worker-1')).toEqual(['pod:b']);
    });

    it('leaves out finished and unscheduled pods', () => {
        const index = buildAttachmentIndex([
            pod('done', 'worker-1', [entry('blue/net')], {}, 'Succeeded'),
            pod('failed', 'worker-1', [entry('blue/net')], {}, 'Failed'),
            pod('waiting', undefined, [entry('blue/net')], {}, 'Pending'),
        ]);
        expect(index.size).toBe(0);
    });

    it('counts a virt-launcher pod as its VM', () => {
        const index = buildAttachmentIndex([launcher('virt-launcher-db-x7k2p', 'db', 'worker-1', [entry('blue/net')])], [vmiOn('db', 'worker-1')]);
        expect(index.get('blue/net')?.get('worker-1')?.[0].workload)
            .toEqual({ kind: 'vm', namespace: 'blue', name: 'db', pod: 'virt-launcher-db-x7k2p' });
    });

    it('counts a migrating VM once, on the node its VMI reports', () => {
        const index = buildAttachmentIndex([
            launcher('virt-launcher-db-aaaaa', 'db', 'worker-1', [entry('blue/net')]),
            launcher('virt-launcher-db-bbbbb', 'db', 'worker-2', [entry('blue/net')]),
        ], [vmiOn('db', 'worker-1')]);
        expect(on(index, 'blue/net', 'worker-1')).toEqual(['vm:db']);
        expect(on(index, 'blue/net', 'worker-2')).toEqual([]);
    });

    it('falls back to the launcher pod\'s node when the VMI names none', () => {
        const index = buildAttachmentIndex([launcher('virt-launcher-db-aaaaa', 'db', 'worker-1', [entry('blue/net')])], [vmiOn('db')]);
        expect(on(index, 'blue/net', 'worker-1')).toEqual(['vm:db']);
    });

    it('does not mistake a pod owned by something else for a VM', () => {
        const owned = pod('a', 'worker-1', [entry('blue/net')], {
            ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'a', uid: 'u2' }],
        });
        expect(on(buildAttachmentIndex([owned]), 'blue/net', 'worker-1')).toEqual(['pod:a']);
    });
});

describe('attachmentWatchScope', () => {
    it('stays in the namespaces of the network\'s NADs', () => {
        expect(attachmentWatchScope(['green/net', 'blue/net', 'blue/other'])).toEqual({ namespaces: ['blue', 'green'] });
    });

    it('goes cluster-wide for the cluster default network', () => {
        expect(attachmentWatchScope([CLUSTER_DEFAULT_ATTACHMENT])).toEqual({});
    });

    it('goes cluster-wide for a NAD in a Multus global namespace, usable from anywhere', () => {
        expect(attachmentWatchScope(['default/vm-igb'])).toEqual({});
        expect(attachmentWatchScope(['blue/net', 'openshift-cnv/net'])).toEqual({});
    });

    it('goes cluster-wide past the namespace limit', () => {
        const names = (count: number) => Array.from({ length: count }, (_, i) => `ns-${i}/net`);
        expect(attachmentWatchScope(names(MAX_NAMESPACED_WATCHES)).namespaces).toHaveLength(MAX_NAMESPACED_WATCHES);
        expect(attachmentWatchScope(names(MAX_NAMESPACED_WATCHES + 1))).toEqual({});
    });
});
