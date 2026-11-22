import type { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';
import * as React from 'react';

import { buildGraphContext, GraphContext } from '../../topology/context';
import type {
    ClusterUserDefinedNetwork,
    LogicalTopologySnapshot,
    NetworkAttachmentDefinition,
    NodeNetworkConfigurationEnactment,
    NodeNetworkState,
    UserDefinedNetwork
} from '../../types';
import { evaluatePhysical, PhysicalEvaluator } from '../evaluate';
import { applySurfaceGates } from '../gates';
import type { ClusterNetworkInputs, Finding, ZoneDatabase } from '../types';

/**
 * The hooks between the findings engine and the surfaces (ovn-recon-7i6.1).
 *
 * Evaluation runs in a useMemo keyed on the same objects the page already builds, so
 * it reruns only when watched data changes -- never in graph layout, which recomputes
 * on every toggle and pan. The evaluator itself is memoised by identity on top.
 */

/**
 * The evaluator the surfaces use. Tests provide one with an extra rule (an info rule,
 * say, since none ships yet); the pages take the shared default.
 */
export const FindingsEvaluatorContext = React.createContext<PhysicalEvaluator>(evaluatePhysical);

// --- "Hide info findings" -----------------------------------------------------

export const HIDE_INFO_STORAGE_KEY = 'ovn-recon.insights.hideInfo';

/**
 * The remembered choice. Storage can be absent, full or refused (a private window, a
 * policy); any failure reads as "not hidden", the default.
 */
export const readHideInfo = (): boolean => {
    try {
        return window.localStorage.getItem(HIDE_INFO_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
};

/** Remember the choice where storage allows; the toggle works for this page either way. */
export const writeHideInfo = (hide: boolean): void => {
    try {
        window.localStorage.setItem(HIDE_INFO_STORAGE_KEY, hide ? 'true' : 'false');
    } catch {
        // Not remembered; nothing else depends on it.
    }
};

/** The one "Hide info findings" toggle's state, shared by every surface on a page. */
export const useHideInfoFindings = (): [boolean, (hide: boolean) => void] => {
    const [hideInfo, setHideInfo] = React.useState<boolean>(readHideInfo);
    const update = React.useCallback((hide: boolean) => {
        setHideInfo(hide);
        writeHideInfo(hide);
    }, []);
    return [hideInfo, update];
};

/** What a surface draws: warnings always, info unless hidden. */
export const visibleFindings = (findings: Finding[], hideInfo: boolean): Finding[] =>
    (hideInfo ? findings.filter((finding) => finding.severity !== 'info') : findings);

// --- Evaluation -----------------------------------------------------------------

/**
 * Every node's NodeNetworkState for the cluster-scope rules, or undefined while the
 * list is not (yet) usable -- loading, refused, nmstate absent -- so those rules stay
 * quiet instead of reading an empty cluster as "mapped nowhere".
 */
export const clusterNodeNetworkStates = (
    list: NodeNetworkState[] | undefined | null,
    loaded: boolean
): NodeNetworkState[] | undefined => (loaded && Array.isArray(list) && list.length > 0 ? list : undefined);

/**
 * Findings for one node's physical page: its node rules plus the cluster's network
 * rules, less what the surface gates hold back.
 */
export const useNodeFindings = (
    ctx: GraphContext,
    allNodeNetworkStates: NodeNetworkState[] | undefined | null,
    allLoaded: boolean
): Finding[] => {
    const evaluate = React.useContext(FindingsEvaluatorContext);
    const nodeNetworkStates = clusterNodeNetworkStates(allNodeNetworkStates, allLoaded);
    const cluster = React.useMemo<ClusterNetworkInputs>(
        () => ({ cudns: ctx.cudns, udns: ctx.udns, nads: ctx.nads, nodeNetworkStates }),
        [ctx.cudns, ctx.udns, ctx.nads, nodeNetworkStates]
    );
    return React.useMemo(() => {
        const nodeName = ctx.nns?.metadata?.name;
        return applySurfaceGates(
            evaluate({ domain: 'physical', node: ctx, cluster }),
            (node) => (node === nodeName ? ctx : undefined)
        );
    }, [evaluate, ctx, cluster]);
};

/**
 * The zone databases of the snapshots a tab already holds, for the masquerade rules
 * (ovn-recon-2n6.5). A degraded snapshot is the collector's sample data, which says
 * nothing about this cluster, so it is left out.
 */
export const zoneDatabasesOf = (snapshots: ReadonlyArray<LogicalTopologySnapshot | null | undefined>): ZoneDatabase[] =>
    snapshots.flatMap((snapshot) => {
        const node = snapshot?.metadata?.nodeName;
        if (!snapshot || !node || !snapshot.database || snapshot.metadata.sourceHealth === 'degraded') return [];
        if ((snapshot.warnings ?? []).some((warning) => warning.code === 'LIVE_PROBE_FAILED')) return [];
        return [{ node, database: snapshot.database }];
    });

/**
 * The snapshots `read` hands back for each node, as zone databases, kept the same
 * array while every snapshot is the same object, so the findings re-evaluate only
 * when a held snapshot changes. `read` must not fetch: it reads what the tab holds.
 */
export const useHeldZoneDatabases = (
    nodeNames: readonly string[],
    read: (nodeName: string) => LogicalTopologySnapshot | null
): ZoneDatabase[] => {
    const snapshots = nodeNames.map(read);
    const previous = React.useRef<{ snapshots: Array<LogicalTopologySnapshot | null>; zones: ZoneDatabase[] }>();
    const same = previous.current !== undefined
        && previous.current.snapshots.length === snapshots.length
        && previous.current.snapshots.every((snapshot, index) => snapshot === snapshots[index]);
    if (!same) previous.current = { snapshots, zones: zoneDatabasesOf(snapshots) };
    return (previous.current as { zones: ZoneDatabase[] }).zones;
};

export interface ClusterFindingsInput {
    nodeNetworkStates: NodeNetworkState[] | undefined | null;
    nodeNetworkStatesLoaded: boolean;
    cudns: ClusterUserDefinedNetwork[];
    udns: UserDefinedNetwork[];
    nads: NetworkAttachmentDefinition[];
    /** Every enactment in the cluster; each node's context takes its own. */
    enactments: NodeNetworkConfigurationEnactment[];
    /** The cluster's Nodes, for the masquerade rules' annotation reads. */
    nodes?: K8sResourceCommon[];
    /** Zone databases already held (heldZoneDatabases); never fetched for the findings. */
    zoneDatabases?: ZoneDatabase[];
}

export const NODE_LABEL = 'nmstate.io/node';

/**
 * Findings for the overview: network rules once, node rules on every node, less what
 * the surface gates hold back. Each node gets the same context its own page builds
 * (the inputs rules read), so the two surfaces agree.
 */
export const useClusterFindings = ({
    nodeNetworkStates, nodeNetworkStatesLoaded, cudns, udns, nads, enactments, nodes, zoneDatabases
}: ClusterFindingsInput): Finding[] => {
    const evaluate = React.useContext(FindingsEvaluatorContext);
    const contexts = React.useMemo(() => {
        const byName = new Map<string, GraphContext>();
        if (!nodeNetworkStatesLoaded || !Array.isArray(nodeNetworkStates)) return byName;
        nodeNetworkStates.forEach((nns) => {
            const name = nns?.metadata?.name;
            if (!name) return;
            byName.set(name, buildGraphContext({
                nns, cudns, udns, nads,
                enactments: enactments.filter((enactment) => enactment.metadata?.labels?.[NODE_LABEL] === name)
            }));
        });
        return byName;
    }, [nodeNetworkStates, nodeNetworkStatesLoaded, cudns, udns, nads, enactments]);
    const cluster = React.useMemo<ClusterNetworkInputs>(() => ({
        cudns, udns, nads,
        nodeNetworkStates: clusterNodeNetworkStates(nodeNetworkStates, nodeNetworkStatesLoaded),
        ...(nodes && nodes.length > 0 ? { nodes } : {}),
        ...(zoneDatabases && zoneDatabases.length > 0 ? { zoneDatabases } : {})
    }), [cudns, udns, nads, nodeNetworkStates, nodeNetworkStatesLoaded, nodes, zoneDatabases]);
    return React.useMemo(
        () => applySurfaceGates(
            evaluate.cluster(cluster, Array.from(contexts.values())),
            (node) => contexts.get(node)
        ),
        [evaluate, cluster, contexts]
    );
};
