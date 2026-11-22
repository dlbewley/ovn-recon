import * as React from 'react';

import type { SeverityCounts } from '../insights/selectors';
import type { Finding } from '../insights/types';
import { useClusterFindings, useHeldZoneDatabases, useHideInfoFindings, visibleFindings } from '../insights/ui/useFindings';
import { rememberedCollectorSnapshot } from './collectorApi';
import { buildCnoConfigModel, CnoConfigModel } from './cnoConfigModel';
import type { NetworkInputs } from './networkPageModel';
import { findingCountsByNode, NodeSummary, nodeRole, OverviewNetworkRow, overviewNetworkRows, summarizeNode } from './overviewModel';
import { ClusterWatches, useClusterWatches } from './useClusterWatches';

/**
 * What the explorer shell reads, once for every view it draws (ovn-recon-gbr.4): the
 * cluster-wide watches (`useClusterWatches`), and everything the tree
 * and the Cluster tabs derive from them, findings included, so the tree, the tabs and
 * the tables cannot disagree. The node, network and logical bodies the scopes load
 * still make their own watches; the console shares a watch between hooks that ask
 * for the same list.
 */
export interface ExplorerData extends ClusterWatches {
    /** One per NodeNetworkState, by name. */
    summaries: NodeSummary[];
    nodeNames: string[];
    /** Each node's role by name, from the Node list. */
    roles: ReadonlyMap<string, string>;
    /** Every finding, before the info filter. */
    allFindings: Finding[];
    /** The findings shown: info ones hidden when the user says so. */
    findings: Finding[];
    hideInfo: boolean;
    setHideInfo: (hide: boolean) => void;
    findingCounts: ReadonlyMap<string, SeverityCounts>;
    networkInputs: NetworkInputs;
    /** Every network, findings first. */
    networkRows: OverviewNetworkRow[];
    /** The cluster network configuration, for the summary strip and the Network config tab (ovn-recon-n7r.1). */
    networkConfigModel: CnoConfigModel;
    /** The NodeNetworkState watch has settled: loaded, or failed. */
    nodeNetworkStatesSettled: boolean;
    /** The collector gate is known and on: the logical views are offered. */
    showLogical: boolean;
}

/** The derived half, for a host that gathers the watches itself (and for tests). */
export const useExplorerModel = (data: ClusterWatches): ExplorerData => {
    const {
        nodeNetworkStates,
        nodeNetworkStatesLoaded: nnsLoaded,
        nodeNetworkStatesError: nnsError,
        nodes,
        cudns,
        udns,
        nads,
        routeAdvertisements,
        enactments,
        vteps,
        networkConfig,
        collector,
    } = data;

    // The zone databases this tab already holds (the cluster ladder's aggregate, a node's
    // logical view), for the masquerade rules (ovn-recon-2n6.5). No request is made for
    // them: a snapshot loaded meanwhile is read when the shell next renders, at the
    // latest on the collector status poll.
    const collectorOn = collector.gateLoaded && collector.enabled;
    const nodeNamesForZones = React.useMemo(
        () => (collectorOn ? nodes.map((node) => node.metadata?.name).filter((name): name is string => Boolean(name)) : []),
        [collectorOn, nodes],
    );
    const zoneDatabases = useHeldZoneDatabases(nodeNamesForZones, rememberedCollectorSnapshot);

    const allFindings = useClusterFindings({
        nodeNetworkStates,
        nodeNetworkStatesLoaded: nnsLoaded && !nnsError,
        cudns,
        udns,
        nads,
        enactments,
        nodes,
        zoneDatabases,
    });
    const [hideInfo, setHideInfo] = useHideInfoFindings();
    const findings = React.useMemo(() => visibleFindings(allFindings, hideInfo), [allFindings, hideInfo]);
    const findingCounts = React.useMemo(() => findingCountsByNode(findings), [findings]);

    const summaries = React.useMemo(
        () => (nodeNetworkStates ?? []).map(summarizeNode).sort((a, b) => a.name.localeCompare(b.name)),
        [nodeNetworkStates],
    );
    const nodeNames = React.useMemo(() => summaries.map((summary) => summary.name), [summaries]);
    const roles = React.useMemo(() => {
        const byName = new Map<string, string>();
        for (const node of nodes) {
            if (node.metadata?.name) byName.set(node.metadata.name, nodeRole(node));
        }
        return byName;
    }, [nodes]);

    const networkInputs = React.useMemo<NetworkInputs>(
        () => ({ cudns, udns, nads, routeAdvertisements }),
        [cudns, udns, nads, routeAdvertisements],
    );
    const networkRows = React.useMemo(
        () => overviewNetworkRows(
            networkInputs,
            nnsLoaded && !nnsError && Array.isArray(nodeNetworkStates) ? nodeNetworkStates : undefined,
            findings,
        ),
        [networkInputs, nodeNetworkStates, nnsLoaded, nnsError, findings],
    );

    const networkConfigModel = React.useMemo(
        () => buildCnoConfigModel({ ...networkConfig, nodes, routeAdvertisements, vteps }),
        [networkConfig, nodes, routeAdvertisements, vteps],
    );

    return {
        ...data,
        summaries,
        nodeNames,
        roles,
        allFindings,
        findings,
        hideInfo,
        setHideInfo,
        findingCounts,
        networkInputs,
        networkRows,
        networkConfigModel,
        nodeNetworkStatesSettled: nnsLoaded || Boolean(nnsError),
        showLogical: collector.gateLoaded && collector.enabled,
    };
};

/** The watches and everything derived from them. */
export const useExplorerData = (): ExplorerData => useExplorerModel(useClusterWatches());
