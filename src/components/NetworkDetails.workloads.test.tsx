import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { clone, loadItems } from '../insights/testing';
import { buildAttachmentIndex, NETWORK_STATUS_ANNOTATION } from '../topology/workloadAttachments';
import type {
    ClusterUserDefinedNetwork,
    NetworkAttachmentDefinition,
    NetworkAttachmentsResponse,
    NodeNetworkState,
    Pod,
    UserDefinedNetwork,
} from '../types';
import { NetworkExplorerBody } from './NetworkDetails';
import {
    buildPlacement,
    findNetwork,
    isOvnNetwork,
    NetworkInputs,
    networkAttachmentNames,
    NetworkWorkloads,
    placementWorkloadsNote,
    placementWorkloadsText,
    workloadCountsFromCollector,
    workloadCountsFromIndex,
} from './networkPageModel';
import { TestRouter } from './testRouter';

type WatchRequest = { groupVersionKind: { kind: string }; namespace?: string; fieldSelector?: string };

const mockWatches: Record<string, unknown[]> = {};
const mockModels: Record<string, { kind: string } | undefined> = {};
const mockDenied = new Set<string>();
const mockWatchErrors: Record<string, Error> = {};
const mockReviews: { resource: string; namespace?: string }[] = [];
const mockRequests: WatchRequest[] = [];
const mockLists: { model: { kind: string }; queryParams: Record<string, string> }[] = [];
const mockFetchAttachments = jest.fn();
const mockGate = { enabled: true, loaded: true, loadError: null as Error | null };

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    DocumentTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useK8sModel: (gvk: { kind: string }) => [mockModels[gvk.kind], false],
    useK8sWatchResource: (resource: { groupVersionKind: { kind: string } } | null) =>
        (resource ? [mockWatches[resource.groupVersionKind.kind] ?? [], true, undefined] : [undefined, true, undefined]),
    checkAccess: (attributes: { resource: string; namespace?: string }) => {
        mockReviews.push(attributes);
        return Promise.resolve({ status: { allowed: !mockDenied.has(attributes.resource) } });
    },
    k8sListItems: (options: { model: { kind: string }; queryParams: Record<string, string> }) => {
        mockLists.push(options);
        return Promise.resolve(mockWatches[options.model.kind] ?? []);
    },
    useK8sWatchResources: (resources: Record<string, WatchRequest>) => {
        const results: Record<string, unknown> = {};
        Object.entries(resources).forEach(([key, resource]) => {
            mockRequests.push(resource);
            const kind = resource.groupVersionKind.kind;
            const items = (mockWatches[kind] ?? []) as { metadata?: { namespace?: string } }[];
            results[key] = {
                data: items.filter((item) => !resource.namespace || item.metadata?.namespace === resource.namespace),
                loaded: !mockWatchErrors[kind],
                loadError: mockWatchErrors[kind],
            };
        });
        return results;
    },
}));

// jest.setup.js stubs the hook for every other suite; this one tests it.
jest.mock('./useNetworkWorkloads', () => jest.requireActual('./useNetworkWorkloads'));

jest.mock('./useOvnCollectorFeatureGate', () => ({
    useOvnCollectorFeatureGate: () => mockGate,
}));

jest.mock('./collectorApi', () => ({
    ...jest.requireActual('./collectorApi'),
    fetchNetworkAttachments: () => mockFetchAttachments(),
    rememberedNetworkAttachments: () => null,
}));

const KINDS = ['NodeNetworkState', 'ClusterUserDefinedNetwork', 'UserDefinedNetwork', 'NetworkAttachmentDefinition', 'RouteAdvertisements', 'Pod'];

const coverage = {
    cudns: loadItems<ClusterUserDefinedNetwork>('cudn', 'cluster-localnet-coverage.json'),
    nads: loadItems<NetworkAttachmentDefinition>('nad', 'cluster-localnet-coverage.json'),
    nns: loadItems<NodeNetworkState>('nns', 'cluster-localnet-coverage.json'),
};

/** Three nodes: the fixture's first three workers. */
const threeNodes = coverage.nns
    .filter((nns) => nns.metadata?.name?.startsWith('worker-'))
    .slice(0, 3);
const [nodeA, nodeB, nodeC] = threeNodes.map((nns) => nns.metadata?.name as string);

// Created in default and demo-mirror; default is a Multus global namespace, so counting
// this network from pods would mean reading every pod in the cluster.
const NETWORK = 'machinenet';
// Created in demo-mirror alone, so its pods can be watched in that namespace.
const NARROW_NETWORK = 'vlan-1924';

const attachedPod = (name: string, namespace: string, node: string, network = `${namespace}/${NETWORK}`): Pod => ({
    metadata: {
        name,
        namespace,
        annotations: { [NETWORK_STATUS_ANNOTATION]: JSON.stringify([{ name: network, interface: 'net1', ips: ['192.168.10.5'] }]) },
    },
    spec: { nodeName: node },
    status: { phase: 'Running' },
});

const launcherPod = (name: string, vmi: string, namespace: string, node: string, network?: string): Pod => {
    const pod = attachedPod(name, namespace, node, network);
    pod.metadata!.ownerReferences = [{ apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachineInstance', name: vmi, uid: vmi }];
    return pod;
};

/** Pods on two of the three nodes; the third has none. */
const twoOfThree = (): Pod[] => [
    attachedPod('a', 'demo-mirror', nodeA),
    attachedPod('b', 'default', nodeA),
    attachedPod('c', 'demo-mirror', nodeB),
    // The same subnet may be in use elsewhere: only the name decides.
    attachedPod('other', 'demo-mirror', nodeC, 'demo-mirror/vlan-1926'),
];

/** What the collector says of the same cluster. */
const collectorAnswer = (overrides: Partial<NetworkAttachmentsResponse> = {}): NetworkAttachmentsResponse => ({
    metadata: { schemaVersion: '1', generatedAt: '2026-11-18T09:00:00Z', sourceHealth: 'healthy' },
    zones: [nodeA, nodeB, nodeC],
    networks: [
        { nad: `default/${NETWORK}`, nodes: [{ nodeName: nodeA, pods: 1, virtLaunchers: 0 }] },
        {
            nad: `demo-mirror/${NETWORK}`,
            nodes: [{ nodeName: nodeA, pods: 1, virtLaunchers: 0 }, { nodeName: nodeB, pods: 1, virtLaunchers: 1 }],
        },
        { nad: 'demo-mirror/vlan-1926', nodes: [{ nodeName: nodeC, pods: 5, virtLaunchers: 0 }] },
    ],
    warnings: [],
    ...overrides,
});

const inputs: NetworkInputs = { cudns: coverage.cudns, udns: [], nads: coverage.nads, routeAdvertisements: [] };

describe('placement workloads in the model', () => {
    const record = findNetwork({ kind: 'cudn', name: NETWORK }, inputs)!;
    const names = networkAttachmentNames(record, inputs);
    const fromPods = (pods: Pod[], kubevirt = false): NetworkWorkloads => ({
        state: 'known',
        source: 'pods',
        counts: workloadCountsFromIndex(buildAttachmentIndex(pods), names),
        kubevirt,
    });
    const fromCollector = (response: NetworkAttachmentsResponse, kubevirt = false): NetworkWorkloads => ({
        state: 'known',
        source: 'collector',
        kubevirt,
        ...workloadCountsFromCollector(response, names, kubevirt),
    });
    const texts = (workloads: NetworkWorkloads) =>
        buildPlacement(record, threeNodes, inputs, workloads).rows
            .map((row) => [row.node, placementWorkloadsText(row.workloads!)]);

    it('names the network by its NADs', () => {
        expect(names).toEqual([`default/${NETWORK}`, `demo-mirror/${NETWORK}`]);
    });

    it('still names a CUDN\'s NADs from its condition when NADs cannot be listed', () => {
        const noNads = { ...inputs, nads: [] };
        expect(networkAttachmentNames(findNetwork({ kind: 'cudn', name: NETWORK }, noNads)!, noNads))
            .toEqual([`default/${NETWORK}`, `demo-mirror/${NETWORK}`]);
    });

    it('knows which networks OVN holds', () => {
        expect(isOvnNetwork(record)).toBe(true);
        const bridge: NetworkAttachmentDefinition = {
            metadata: { name: 'br', namespace: 'blue' },
            spec: { config: '{"type":"bridge","bridge":"br-x"}' },
        };
        const withBridge = { ...inputs, nads: [...inputs.nads, bridge] };
        expect(isOvnNetwork(findNetwork({ kind: 'nad', namespace: 'blue', name: 'br' }, withBridge)!)).toBe(false);
    });

    it('counts pods on two of three nodes, and zero on the third', () => {
        expect(texts(fromPods(twoOfThree()))).toEqual([[nodeA, '2 pods'], [nodeB, '1 pod'], [nodeC, '0 pods']]);
    });

    it('counts VMs apart from pods where KubeVirt is present', () => {
        const pods = [...twoOfThree(), launcherPod('virt-launcher-db-x7k2p', 'db', 'demo-mirror', nodeB)];
        expect(texts(fromPods(pods, true))).toEqual([
            [nodeA, '2 pods, 0 VMs'], [nodeB, '1 pod, 1 VM'], [nodeC, '0 pods, 0 VMs'],
        ]);
    });

    it('sums the collector\'s counts across the network\'s NADs, and only those', () => {
        expect(texts(fromCollector(collectorAnswer(), true))).toEqual([
            [nodeA, '2 pods, 0 VMs'], [nodeB, '1 pod, 1 VM'], [nodeC, '0 pods, 0 VMs'],
        ]);
    });

    it('counts a launcher-named pod as a pod without KubeVirt', () => {
        expect(texts(fromCollector(collectorAnswer()))[1]).toEqual([nodeB, '2 pods']);
    });

    it('reads unknown, not zero, on a node the collector could not count', () => {
        const workloads = fromCollector(collectorAnswer({ zones: [nodeA, nodeB] }));
        expect(texts(workloads)[2]).toEqual([nodeC, 'unknown']);
        expect(placementWorkloadsNote(workloads, [nodeA, nodeB, nodeC])).toContain('1 node without live OVN data.');
    });

    it('never turns unknown VMs into zero', () => {
        expect(texts({ ...fromPods(twoOfThree(), true), vmsUnknown: 'denied' } as NetworkWorkloads)[2])
            .toEqual([nodeC, '0 pods, VMs unknown']);
    });

    it('reads unknown on every node when pods cannot be read', () => {
        expect(texts({ state: 'unknown', reason: 'denied' }).map(([, text]) => text)).toEqual(['unknown', 'unknown', 'unknown']);
    });

    it('adds nothing for a caller that did not read workloads', () => {
        expect(buildPlacement(record, threeNodes, inputs).rows[0]).not.toHaveProperty('workloads');
    });
});

describe('the Attached column', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        KINDS.forEach((kind) => { mockModels[kind] = { kind }; });
        mockModels.VirtualMachineInstance = undefined;
        mockDenied.clear();
        mockReviews.length = 0;
        mockRequests.length = 0;
        mockLists.length = 0;
        mockGate.enabled = true;
        mockGate.loaded = true;
        mockGate.loadError = null;
        mockFetchAttachments.mockReset();
        mockFetchAttachments.mockResolvedValue(collectorAnswer());
        Object.keys(mockWatchErrors).forEach((kind) => { delete mockWatchErrors[kind]; });
        mockWatches.NodeNetworkState = threeNodes;
        mockWatches.ClusterUserDefinedNetwork = coverage.cudns;
        mockWatches.UserDefinedNetwork = [];
        mockWatches.NetworkAttachmentDefinition = coverage.nads;
        mockWatches.RouteAdvertisements = [];
        mockWatches.Pod = twoOfThree();
        mockWatches.VirtualMachineInstance = [];
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const flush = async () => {
        for (let turn = 0; turn < 5; turn += 1) {
            await act(async () => { await Promise.resolve(); });
        }
    };
    const render = async (address: Parameters<typeof NetworkExplorerBody>[0]['address'] = { kind: 'cudn', name: NETWORK }) => {
        await act(async () => {
            root.render(
                <TestRouter initialEntry="/ovn-recon">
                    <NetworkExplorerBody address={address} />
                </TestRouter>,
            );
        });
        await flush();
    };
    const cell = (node: string) => container.querySelector(`[data-testid="placement-attached-${node}"]`)?.textContent;
    const cells = () => [cell(nodeA), cell(nodeB), cell(nodeC)];
    const note = () => container.querySelector('[data-testid="placement-attached-note"]')?.textContent;
    const countButton = () => container.querySelector<HTMLButtonElement>('[data-testid="placement-count-pods"]');
    const clickCount = async () => {
        await act(async () => { countButton()!.click(); });
        await flush();
    };
    const expectNoPodReads = () => {
        expect(mockReviews).toEqual([]);
        expect(mockRequests).toEqual([]);
        expect(mockLists).toEqual([]);
    };

    describe('for an OVN network with the collector answering', () => {
        it('counts from the collector and reads no pods at all', async () => {
            await render();
            expect(cells()).toEqual(['2 pods', '2 pods', '0 pods']);
            expect(note()).toContain('Counted from OVN snapshots');
            expect(countButton()).toBeNull();
            expectNoPodReads();
        });

        it('needs no permission to list pods', async () => {
            mockDenied.add('pods');
            await render();
            expect(cell(nodeA)).toBe('2 pods');
            expectNoPodReads();
        });

        it('counts launcher pods as VMs where KubeVirt is served, without watching VMIs', async () => {
            mockModels.VirtualMachineInstance = { kind: 'VirtualMachineInstance' };
            await render();
            expect(cell(nodeB)).toBe('1 pod, 1 VM');
            expectNoPodReads();
        });

        it('reads unknown on a node without live OVN data', async () => {
            mockFetchAttachments.mockResolvedValue(collectorAnswer({ zones: [nodeA, nodeB] }));
            await render();
            expect(cell(nodeC)).toBe('unknown');
            expect(note()).toContain('1 node without live OVN data.');
        });
    });

    describe('when pods must be read', () => {
        beforeEach(() => {
            mockFetchAttachments.mockRejectedValue(new Error('collector is older'));
        });

        it('watches only the namespace of a UDN, and asks only about it', async () => {
            const udn: UserDefinedNetwork = {
                metadata: { name: 'tenant', namespace: 'blue' },
                spec: { topology: 'Layer2', layer2: { role: 'Secondary', subnets: ['10.20.0.0/24'] } },
            };
            mockWatches.UserDefinedNetwork = [udn];
            mockWatches.Pod = [attachedPod('a', 'blue', nodeA, 'blue/tenant')];
            await render({ kind: 'udn', namespace: 'blue', name: 'tenant' });
            expect(cell(nodeA)).toBe('1 pod');
            expect(mockReviews).toEqual([expect.objectContaining({ resource: 'pods', verb: 'list', namespace: 'blue' })]);
            expect(new Set(mockRequests.map((request) => request.namespace))).toEqual(new Set(['blue']));
            expect(mockLists).toEqual([]);
        });

        it('asks for active pods only', async () => {
            mockWatches.Pod = [attachedPod('a', 'demo-mirror', nodeA, `demo-mirror/${NARROW_NETWORK}`)];
            await render({ kind: 'cudn', name: NARROW_NETWORK });
            expect(cell(nodeA)).toBe('1 pod');
            expect(mockRequests[0]).toEqual(expect.objectContaining({
                namespace: 'demo-mirror',
                fieldSelector: 'status.phase!=Succeeded,status.phase!=Failed',
            }));
        });

        it('reads unknown, not zero, without permission, names the namespace and watches none', async () => {
            mockDenied.add('pods');
            await render({ kind: 'cudn', name: NARROW_NETWORK });
            expect(cell(nodeA)).toBe('unknown');
            expect(note()).toContain('You do not have permission to list pods in namespace demo-mirror.');
            expect(mockRequests).toEqual([]);
        });

        it('reads unknown when the pod watch fails after the review allowed it', async () => {
            mockWatchErrors.Pod = new Error('Forbidden');
            await render({ kind: 'cudn', name: NARROW_NETWORK });
            expect(cell(nodeC)).toBe('unknown');
            expect(note()).toContain('Pods could not be read: Forbidden');
        });

        it('makes no KubeVirt request and shows no VM count without KubeVirt', async () => {
            await render({ kind: 'cudn', name: NARROW_NETWORK });
            expect(mockReviews.map((review) => review.resource)).toEqual(['pods']);
            expect(mockRequests.map((request) => request.groupVersionKind.kind)).not.toContain('VirtualMachineInstance');
            expect(cell(nodeA)).not.toContain('VM');
        });

        describe('with KubeVirt', () => {
            beforeEach(() => {
                mockModels.VirtualMachineInstance = { kind: 'VirtualMachineInstance' };
                mockWatches.Pod = [
                    attachedPod('a', 'demo-mirror', nodeB, `demo-mirror/${NARROW_NETWORK}`),
                    launcherPod('virt-launcher-db-x7k2p', 'db', 'demo-mirror', nodeB, `demo-mirror/${NARROW_NETWORK}`),
                ];
                mockWatches.VirtualMachineInstance = [{ metadata: { name: 'db', namespace: 'demo-mirror' }, status: { nodeName: nodeB } }];
            });

            it('counts the VM, not its launcher pod', async () => {
                await render({ kind: 'cudn', name: NARROW_NETWORK });
                expect(cell(nodeB)).toBe('1 pod, 1 VM');
                expect(cell(nodeC)).toBe('0 pods, 0 VMs');
            });

            it('keeps the pod count and says VMs are unknown without permission to list them', async () => {
                mockDenied.add('virtualmachineinstances');
                await render({ kind: 'cudn', name: NARROW_NETWORK });
                expect(cell(nodeB)).toBe('1 pod, VMs unknown');
                expect(note()).toContain('list VirtualMachineInstances in namespace demo-mirror');
                expect(mockRequests.map((request) => request.groupVersionKind.kind)).not.toContain('VirtualMachineInstance');
            });
        });

        describe('and any namespace could hold them', () => {
            it('reads nothing until asked', async () => {
                await render();
                expect(cells()).toEqual(['-', '-', '-']);
                expect(note()).toContain('lists every pod in the cluster');
                expect(countButton()?.textContent).toBe('Count pods');
                expectNoPodReads();
            });

            it('lists active pods once when asked, and never watches them', async () => {
                await render();
                await clickCount();
                expect(cells()).toEqual(['2 pods', '1 pod', '0 pods']);
                expect(mockLists).toHaveLength(1);
                expect(mockLists[0].queryParams).toEqual({ fieldSelector: 'status.phase!=Succeeded,status.phase!=Failed' });
                expect(mockReviews).toEqual([expect.objectContaining({ resource: 'pods', namespace: '' })]);
                expect(mockRequests).toEqual([]);
                expect(note()).toContain('Counted once at');
                expect(countButton()?.textContent).toBe('Count again');
            });

            it('reads unknown when the user may not list pods, and lists none', async () => {
                mockDenied.add('pods');
                await render();
                await clickCount();
                expect(cell(nodeA)).toBe('unknown');
                expect(note()).toContain('You do not have permission to list pods across the cluster.');
                expect(mockLists).toEqual([]);
            });
        });
    });

    it('does not ask the collector about a NAD outside OVN', async () => {
        const bridge: NetworkAttachmentDefinition = {
            metadata: { name: 'br-net', namespace: 'blue' },
            spec: { config: '{"cniVersion":"0.3.1","name":"br-net","type":"bridge","bridge":"br-x"}' },
        };
        mockWatches.NetworkAttachmentDefinition = [...coverage.nads, bridge];
        mockWatches.Pod = [attachedPod('a', 'blue', nodeA, 'blue/br-net')];
        await render({ kind: 'nad', namespace: 'blue', name: 'br-net' });
        expect(cell(nodeA)).toBe('1 pod');
        expect(mockFetchAttachments).not.toHaveBeenCalled();
        expect(new Set(mockRequests.map((request) => request.namespace))).toEqual(new Set(['blue']));
    });

    it('does not ask the collector when it is turned off', async () => {
        mockGate.enabled = false;
        await render();
        expect(mockFetchAttachments).not.toHaveBeenCalled();
        expect(cell(nodeA)).toBe('-');
        expectNoPodReads();
    });

    it('waits for the collector gate before reading anything', async () => {
        mockGate.loaded = false;
        await render();
        expect(cell(nodeA)).toBe('Loading...');
        expect(mockFetchAttachments).not.toHaveBeenCalled();
        expectNoPodReads();
    });

    it('leaves the column off the cluster default network and counts nothing', async () => {
        const nad: NetworkAttachmentDefinition = {
            metadata: { name: 'default', namespace: 'openshift-ovn-kubernetes' },
            spec: { config: '{"cniVersion":"0.4.0","name":"ovn-kubernetes","type":"ovn-k8s-cni-overlay"}' },
        };
        mockWatches.NetworkAttachmentDefinition = [...coverage.nads, nad];
        await render({ kind: 'nad', namespace: 'openshift-ovn-kubernetes', name: 'default' });
        expect(container.querySelector('[data-testid="network-placement"]')?.textContent).not.toContain('Attached');
        expect(mockFetchAttachments).not.toHaveBeenCalled();
        expectNoPodReads();
    });

    it('reads nothing when the table is not drawn', async () => {
        mockModels.NodeNetworkState = undefined;
        await render();
        expect(container.querySelector('[data-testid="placement-unavailable"]')).not.toBeNull();
        expect(mockFetchAttachments).not.toHaveBeenCalled();
        expectNoPodReads();
    });

    it('reads unknown for a CUDN whose NADs cannot be found', async () => {
        const lonely = clone(coverage.cudns.find((cudn) => cudn.metadata?.name === NETWORK)!);
        lonely.status = {};
        mockWatches.ClusterUserDefinedNetwork = [lonely];
        mockWatches.NetworkAttachmentDefinition = [];
        await render();
        expect(cell(nodeA)).toBe('unknown');
        expect(mockFetchAttachments).not.toHaveBeenCalled();
        expectNoPodReads();
    });
});
