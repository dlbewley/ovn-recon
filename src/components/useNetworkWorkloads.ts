import * as React from 'react';
import {
    checkAccess,
    K8sResourceCommon,
    k8sListItems,
    useK8sModel,
    useK8sWatchResources,
    WatchK8sResource,
    WatchK8sResults,
} from '@openshift-console/dynamic-plugin-sdk';

import {
    ACTIVE_POD_FIELD_SELECTOR,
    AttachmentWatchScope,
    attachmentWatchScope,
    buildAttachmentIndex,
    VirtualMachineInstance,
} from '../topology/workloadAttachments';
import type { NetworkAttachmentsResponse, Pod } from '../types';
import { fetchNetworkAttachments, rememberedNetworkAttachments } from './collectorApi';
import {
    isOvnNetwork,
    networkAttachmentNames,
    NetworkInputs,
    NetworkRecord,
    NetworkWorkloads,
    workloadCountsFromCollector,
    workloadCountsFromIndex,
} from './networkPageModel';
import { useOvnCollectorFeatureGate } from './useOvnCollectorFeatureGate';

/*
 * The pods and VMs attached to one network (ovn-recon-nfs.4). A cluster's pod list is
 * large (about 15 KB per pod, nearly all of it unused here), so the page does not watch
 * it. In order of preference:
 *
 *   1. An OVN network is counted by the collector, from the switch ports in the
 *      snapshots it already holds: a few KB, and no pod is read.
 *   2. Otherwise (a bridge or macvlan NAD, or no collector answer) pods are watched, but
 *      only in the namespaces that can hold an attachment.
 *   3. Where any namespace could hold one, nothing is read until the user asks, and then
 *      the pods are listed once and only the counts are kept.
 *
 * Whatever cannot be read is reported as unknown, never as a count of zero.
 */

const POD_GVK = { version: 'v1', kind: 'Pod' };
const VMI_GVK = { group: 'kubevirt.io', version: 'v1', kind: 'VirtualMachineInstance' };

const COLLECTOR_REFRESH_MS = 60000;

const LOADING: NetworkWorkloads = { state: 'loading' };
const ON_REQUEST: NetworkWorkloads = { state: 'on-request' };

/** A cluster-wide access review is the empty namespace. */
const ALL_NAMESPACES = '';

export interface NetworkWorkloadsView {
    workloads: NetworkWorkloads;
    /** Lists the cluster's pods once and counts them; present where that is the only way. */
    requestCount?: () => void;
}

const listAllowed = (group: string, resource: string, namespace: string): Promise<boolean> =>
    checkAccess({ group, resource, verb: 'list', namespace })
        .then((review) => review.status?.allowed === true)
        // A review that fails has not said yes.
        .catch(() => false);

type ListAccess = { state: 'checking' } | { state: 'checked'; denied: string[] };

const CHECKING: ListAccess = { state: 'checking' };

/** Whether the user may list a resource in every one of the namespaces. */
const useListAccess = (group: string, resource: string, namespaces: string[], enabled: boolean): ListAccess => {
    const [answer, setAnswer] = React.useState<{ namespaces: string[]; access: ListAccess }>();
    React.useEffect(() => {
        if (!enabled) return undefined;
        let current = true;
        Promise.all(namespaces.map((namespace) => listAllowed(group, resource, namespace))).then((allowed) => {
            if (!current) return;
            setAnswer({
                namespaces,
                access: { state: 'checked', denied: namespaces.filter((_, index) => !allowed[index]) },
            });
        });
        return () => { current = false; };
    }, [group, resource, namespaces, enabled]);
    return enabled && answer?.namespaces === namespaces ? answer.access : CHECKING;
};

const whereText = (namespaces: string[]): string => {
    if (namespaces.includes(ALL_NAMESPACES)) return 'across the cluster';
    return `in namespace${namespaces.length === 1 ? '' : 's'} ${namespaces.join(', ')}`;
};

const errorText = (error: unknown): string => (error as Error)?.message || String(error);

type WatchResults = WatchK8sResults<Record<string, K8sResourceCommon[]>>;

/** The watches under one prefix, read as a single list. */
const readWatches = <T extends K8sResourceCommon>(results: WatchResults, prefix: string) => {
    const parts = Object.keys(results).filter((key) => key.startsWith(`${prefix}/`)).map((key) => results[key]);
    const failed = parts.find((part) => part.loadError);
    return {
        data: parts.flatMap((part) => (part.data ?? []) as T[]),
        loaded: parts.length > 0 && parts.every((part) => part.loaded),
        error: failed ? errorText(failed.loadError) : undefined,
    };
};

type CollectorAnswer =
    | { state: 'loading' }
    | { state: 'failed' }
    | { state: 'ready'; response: NetworkAttachmentsResponse };

/**
 * The collector's counts, refreshed while wanted. The last good answer stands through a
 * failed refresh, so a collector restart does not turn the column into a pod watch.
 */
const useCollectorAttachments = (enabled: boolean): CollectorAnswer => {
    const [response, setResponse] = React.useState(rememberedNetworkAttachments);
    const [failed, setFailed] = React.useState(false);
    React.useEffect(() => {
        if (!enabled) return undefined;
        let current = true;
        const load = () => {
            fetchNetworkAttachments()
                .then((next) => {
                    if (!current) return;
                    setResponse(next);
                    setFailed(false);
                })
                .catch(() => {
                    if (current) setFailed(true);
                });
        };
        load();
        const timer = window.setInterval(load, COLLECTOR_REFRESH_MS);
        return () => {
            current = false;
            window.clearInterval(timer);
        };
    }, [enabled]);
    if (response) return { state: 'ready', response };
    return failed ? { state: 'failed' } : { state: 'loading' };
};

type OneTimeCount =
    | { state: 'idle' }
    | { state: 'counting' }
    | { state: 'failed'; reason: string }
    | { state: 'done'; workloads: NetworkWorkloads };

const IDLE: OneTimeCount = { state: 'idle' };

/** Lists every active pod once, on request, and keeps only the counts. */
const useOneTimeCount = (networks: string[]) => {
    const [podModel] = useK8sModel(POD_GVK);
    const [vmiModel] = useK8sModel(VMI_GVK);
    const key = networks.join(',');
    const [answer, setAnswer] = React.useState<{ key: string; count: OneTimeCount }>();
    const latest = React.useRef(0);
    React.useEffect(() => () => { latest.current += 1; }, []);

    const request = React.useCallback(async () => {
        if (!podModel) return;
        latest.current += 1;
        const run = latest.current;
        const finish = (count: OneTimeCount) => {
            if (run === latest.current) setAnswer({ key, count });
        };
        finish({ state: 'counting' });
        try {
            if (!await listAllowed('', 'pods', ALL_NAMESPACES)) {
                finish({ state: 'failed', reason: `You do not have permission to list pods ${whereText([ALL_NAMESPACES])}.` });
                return;
            }
            const pods = await k8sListItems<Pod>({
                model: podModel,
                queryParams: { fieldSelector: ACTIVE_POD_FIELD_SELECTOR },
            });
            let vmis: VirtualMachineInstance[] | undefined;
            let vmsUnknown: string | undefined;
            if (vmiModel) {
                if (await listAllowed('kubevirt.io', 'virtualmachineinstances', ALL_NAMESPACES)) {
                    vmis = await k8sListItems<VirtualMachineInstance>({ model: vmiModel, queryParams: {} });
                } else {
                    vmsUnknown = `You do not have permission to list VirtualMachineInstances ${whereText([ALL_NAMESPACES])}.`;
                }
            }
            finish({
                state: 'done',
                workloads: {
                    state: 'known',
                    source: 'pods',
                    counts: workloadCountsFromIndex(buildAttachmentIndex(pods, vmis), networks),
                    kubevirt: Boolean(vmiModel),
                    countedAt: new Date().toISOString(),
                    ...(vmsUnknown ? { vmsUnknown } : {}),
                },
            });
        } catch (error) {
            finish({ state: 'failed', reason: `Pods could not be read: ${errorText(error)}` });
        }
        // `key` stands for `networks`.
    }, [key, podModel, vmiModel]);

    return { count: answer?.key === key ? answer.count : IDLE, request };
};

/**
 * What is attached to the network, for the placement table. `enabled` is false while the
 * table is not drawn, and then nothing is fetched, reviewed or watched.
 */
export const useNetworkWorkloads = (
    record: NetworkRecord,
    inputs: NetworkInputs,
    enabled: boolean,
): NetworkWorkloadsView => {
    const networks = React.useMemo(() => networkAttachmentNames(record, inputs), [record, inputs]);
    // Keyed by value: the watched lists change often, the names they imply rarely.
    const networksKey = networks.join(',');
    const stableNetworks = React.useMemo(() => networks, [networksKey]);
    const scope = React.useMemo<AttachmentWatchScope>(() => attachmentWatchScope(stableNetworks), [stableNetworks]);
    const namespaces = React.useMemo(() => scope.namespaces ?? [], [scope]);
    const namespaced = scope.namespaces !== undefined;

    const gate = useOvnCollectorFeatureGate();
    const gateSettled = gate.loaded || Boolean(gate.loadError);
    const countable = enabled && stableNetworks.length > 0;

    const wantsCollector = countable && gate.loaded && gate.enabled && isOvnNetwork(record);
    const collector = useCollectorAttachments(wantsCollector);
    const readsPods = countable && gateSettled && (!wantsCollector || collector.state === 'failed');
    const watching = readsPods && namespaced;

    const [vmiModel, vmiModelInFlight] = useK8sModel(VMI_GVK);
    const kubevirt = Boolean(vmiModel);

    const podAccess = useListAccess('', 'pods', namespaces, watching);
    const vmiAccess = useListAccess('kubevirt.io', 'virtualmachineinstances', namespaces, watching && kubevirt);
    const podsAllowed = watching && podAccess.state === 'checked' && podAccess.denied.length === 0;
    const vmisAllowed = podsAllowed && kubevirt && vmiAccess.state === 'checked' && vmiAccess.denied.length === 0;

    const resources = React.useMemo(() => {
        const watches: Record<string, WatchK8sResource> = {};
        namespaces.forEach((namespace) => {
            if (podsAllowed) {
                watches[`pods/${namespace}`] = {
                    groupVersionKind: POD_GVK,
                    isList: true,
                    namespace,
                    fieldSelector: ACTIVE_POD_FIELD_SELECTOR,
                };
            }
            if (vmisAllowed) {
                watches[`vmis/${namespace}`] = { groupVersionKind: VMI_GVK, isList: true, namespace };
            }
        });
        return watches;
    }, [namespaces, podsAllowed, vmisAllowed]);
    const watched = useK8sWatchResources<Record<string, K8sResourceCommon[]>>(resources);

    const { count: oneTime, request } = useOneTimeCount(stableNetworks);

    const workloads = React.useMemo((): NetworkWorkloads => {
        if (!enabled) return LOADING;
        if (stableNetworks.length === 0) {
            return {
                state: 'unknown',
                reason: 'No NetworkAttachmentDefinition was found for this network, so where its workloads run is not known.',
            };
        }
        if (!gateSettled || vmiModelInFlight) return LOADING;

        if (wantsCollector && collector.state !== 'failed') {
            if (collector.state === 'loading') return LOADING;
            return {
                state: 'known',
                source: 'collector',
                kubevirt,
                ...workloadCountsFromCollector(collector.response, stableNetworks, kubevirt),
            };
        }

        if (!namespaced) {
            if (oneTime.state === 'idle') return ON_REQUEST;
            if (oneTime.state === 'counting') return LOADING;
            return oneTime.state === 'failed' ? { state: 'unknown', reason: oneTime.reason } : oneTime.workloads;
        }

        if (podAccess.state === 'checking') return LOADING;
        if (podAccess.denied.length > 0) {
            return {
                state: 'unknown',
                reason: `You do not have permission to list pods ${whereText(podAccess.denied)}.`,
            };
        }
        const pods = readWatches<Pod>(watched, 'pods');
        if (pods.error) return { state: 'unknown', reason: `Pods could not be read: ${pods.error}` };
        if (!pods.loaded) return LOADING;
        if (!kubevirt) {
            return {
                state: 'known',
                source: 'pods',
                counts: workloadCountsFromIndex(buildAttachmentIndex(pods.data), stableNetworks),
                kubevirt: false,
            };
        }

        if (vmiAccess.state === 'checking') return LOADING;
        const vmis = readWatches<VirtualMachineInstance>(watched, 'vmis');
        let vmsUnknown: string | undefined;
        if (vmiAccess.denied.length > 0) {
            vmsUnknown = `You do not have permission to list VirtualMachineInstances ${whereText(vmiAccess.denied)}.`;
        } else if (vmis.error) {
            vmsUnknown = `VirtualMachineInstances could not be read: ${vmis.error}`;
        } else if (!vmis.loaded) {
            return LOADING;
        }
        return {
            state: 'known',
            source: 'pods',
            counts: workloadCountsFromIndex(
                buildAttachmentIndex(pods.data, vmsUnknown ? undefined : vmis.data),
                stableNetworks,
            ),
            kubevirt: true,
            ...(vmsUnknown ? { vmsUnknown } : {}),
        };
    }, [
        enabled, stableNetworks, gateSettled, vmiModelInFlight, wantsCollector, collector, kubevirt,
        namespaced, oneTime, podAccess, vmiAccess, watched,
    ]);

    const offersCount = enabled && readsPods && !namespaced && oneTime.state !== 'counting';
    return React.useMemo(
        () => (offersCount ? { workloads, requestCount: () => { void request(); } } : { workloads }),
        [workloads, offersCount, request],
    );
};
