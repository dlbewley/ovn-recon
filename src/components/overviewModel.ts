import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import { NodeNetworkState } from '../types';
import { findingSubjectLink, FindingLink } from '../insights/links';
import { countBySeverity, findingsForNetwork, SeverityCounts } from '../insights/selectors';
import type { Finding, Severity } from '../insights/types';
import {
    buildPlacement,
    listNetworks,
    networkCreationFailure,
    NetworkInputs,
    NetworkKind,
    networkPath,
    NetworkRecord,
    placementSummary,
} from './networkPageModel';
import { extractLldpNeighbors } from './nodeVisualizationSelectors';
import { parseSnapshotAgeMs } from './snapshotFreshness';

/**
 * Pure summaries behind the OVN Recon overview page (ovn-recon-brx). Every
 * figure is derived from resources the plugin already watches; nothing here
 * fetches. The page's job is to let someone choose a node, or the cluster
 * view, for a reason -- so each summary is a fact that distinguishes one node
 * or one cluster from another, not a restatement of the raw resource.
 */

export interface NodeSummary {
    name: string;
    /** Interfaces in state "up" over every interface nmstate reports. */
    interfacesUp: number;
    interfacesTotal: number;
    /**
     * OVS bridges other than br-int. br-int is OVN's integration bridge and is
     * on every node, so listing it would tell the reader nothing.
     */
    bridges: string[];
    bridgeMappings: number;
    /** Distinct LLDP neighbors seen across all interfaces, as the physical view counts them. */
    lldpNeighbors: number;
}

export const summarizeNode = (nns: NodeNetworkState): NodeSummary => {
    const interfaces = nns.status?.currentState?.interfaces ?? [];
    const mappings = nns.status?.currentState?.ovn?.['bridge-mappings'] ?? [];
    return {
        name: nns.metadata?.name ?? '',
        interfacesUp: interfaces.filter((iface) => iface.state === 'up').length,
        interfacesTotal: interfaces.length,
        bridges: interfaces
            .filter((iface) => iface.type === 'ovs-bridge' && iface.name !== 'br-int')
            .map((iface) => iface.name)
            .sort(),
        bridgeMappings: mappings.length,
        lldpNeighbors: extractLldpNeighbors(interfaces).length,
    };
};

const ROLE_LABEL_PREFIX = 'node-role.kubernetes.io/';

/**
 * Human role from the node's role labels. Control plane wins when a node
 * carries both control-plane and worker (a compact or SNO cluster), since
 * that is the role that explains what else is on the node.
 */
export const nodeRole = (node: K8sResourceCommon | undefined): string => {
    const roles = Object.keys(node?.metadata?.labels ?? {})
        .filter((key) => key.startsWith(ROLE_LABEL_PREFIX))
        .map((key) => key.slice(ROLE_LABEL_PREFIX.length))
        .filter((role) => role !== '');
    if (roles.includes('control-plane') || roles.includes('master')) return 'control plane';
    if (roles.includes('worker')) return 'worker';
    return roles.sort()[0] ?? '';
};

export interface FleetSummary {
    nodes: number;
    bridgeMappings: number;
    /** Distinct non-br-int bridge names across the fleet. */
    bridges: number;
    nodesWithLldp: number;
}

export const summarizeFleet = (summaries: NodeSummary[]): FleetSummary => ({
    nodes: summaries.length,
    bridgeMappings: summaries.reduce((total, node) => total + node.bridgeMappings, 0),
    bridges: new Set(summaries.flatMap((node) => node.bridges)).size,
    nodesWithLldp: summaries.filter((node) => node.lldpNeighbors > 0).length,
});

/** Case-insensitive substring match on the node name; an empty query keeps everything. */
export const filterNodeSummaries = (summaries: NodeSummary[], query: string): NodeSummary[] => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return summaries;
    return summaries.filter((node) => node.name.toLowerCase().includes(needle));
};

// --- Findings (ovn-recon-7i6.1) ---------------------------------------------------

/** Findings counted per node, for the node table's Findings column. Network-wide findings belong to no node. */
export const findingCountsByNode = (findings: Finding[]): Map<string, SeverityCounts> => {
    const byNode = new Map<string, Finding[]>();
    findings.forEach((finding) => {
        const node = finding.scope.node;
        if (!node) return;
        byNode.set(node, [...(byNode.get(node) ?? []), finding]);
    });
    return new Map(Array.from(byNode.entries()).map(([node, list]) => [node, countBySeverity(list)]));
};

export interface FindingGroupEntry {
    finding: Finding;
    /** Where the entry links: its subject, selected. */
    link: FindingLink;
    /** "on worker-1", or "network-wide" for a finding that belongs to no one node. */
    where: string;
}

export interface FindingGroup {
    ruleId: string;
    title: string;
    severity: Severity;
    entries: FindingGroupEntry[];
}

/**
 * The overview list: findings grouped by rule, warnings' rules first. A network-scope
 * finding is one entry, under its network, because the evaluator raises it once for
 * the cluster rather than once per node. `nodeNames` gives a node page on which to
 * select a network that every node's graph draws (the first by name).
 */
export const groupFindingsByRule = (
    findings: Finding[],
    nodeNames: string[],
    titleFor: (ruleId: string) => string | undefined
): FindingGroup[] => {
    const anyNode = nodeNames.slice().sort()[0];
    const groups = new Map<string, FindingGroup>();
    findings.forEach((finding) => {
        let group = groups.get(finding.ruleId);
        if (!group) {
            group = {
                ruleId: finding.ruleId,
                title: titleFor(finding.ruleId) ?? finding.ruleId,
                severity: finding.severity,
                entries: []
            };
            groups.set(finding.ruleId, group);
        }
        if (finding.severity === 'warning') group.severity = 'warning';
        group.entries.push({
            finding,
            link: findingSubjectLink(finding, anyNode),
            where: finding.scope.node ? `on ${finding.scope.node}` : 'network-wide'
        });
    });
    return Array.from(groups.values()).sort((a, b) =>
        (a.severity === b.severity ? 0 : a.severity === 'warning' ? -1 : 1)
        || a.title.localeCompare(b.title));
};

// --- Networks table (ovn-recon-nfs.6) ---------------------------------------------

export const NETWORK_KIND_LABEL: Record<NetworkKind, string> = { cudn: 'CUDN', udn: 'UDN', nad: 'NAD' };


export interface OverviewNetworkRow {
    /** Unique among the rows: kind, namespace and name. */
    key: string;
    record: NetworkRecord;
    /** The network's own page. */
    path: string;
    /**
     * Nodes the network is wired on, of the nodes with a NodeNetworkState. Undefined
     * when nothing node-local is checked for the network, or no node's state is known.
     */
    wired?: { wired: number; total: number };
    /** The network's NetworkCreated condition is False: nothing else about it exists yet. */
    notCreated: boolean;
    /** Findings about the network, network-wide or on any node. */
    findings: SeverityCounts;
}

/**
 * One row per network for the overview's table, as the networks page lists them
 * (listNetworks) and wires them (buildPlacement). Networks with warnings come first,
 * then those with only info findings, then the rest, each in the list's own order, so
 * what a capped table leaves out has nothing to report.
 *
 * Pass `nodeNetworkStates` as undefined while the list is loading, refused or absent:
 * "0 of 0" would read as a network wired nowhere.
 */
export const overviewNetworkRows = (
    inputs: NetworkInputs,
    nodeNetworkStates: NodeNetworkState[] | undefined,
    findings: Finding[],
): OverviewNetworkRow[] => {
    const states = nodeNetworkStates && nodeNetworkStates.length > 0 ? nodeNetworkStates : undefined;
    const rank = (row: OverviewNetworkRow): number => (row.findings.warning > 0 ? 0 : row.findings.info > 0 ? 1 : 2);
    return listNetworks(inputs)
        .map((record): OverviewNetworkRow => {
            const placement = states ? buildPlacement(record, states, inputs) : undefined;
            return {
                key: `${record.kind}/${record.namespace ?? ''}/${record.name}`,
                record,
                path: networkPath(record),
                wired: placement && placementSummary(placement) !== undefined
                    ? { wired: placement.wired, total: placement.total }
                    : undefined,
                notCreated: networkCreationFailure(record) !== undefined,
                findings: countBySeverity(findingsForNetwork(findings, record.ref)),
            };
        })
        // Array.prototype.sort is stable, so ties keep listNetworks' order.
        .sort((a, b) => rank(a) - rank(b));
};

// --- Collector status (ovn-recon-nt4.9) -------------------------------------------

export interface SnapshotAges {
    /** The stalest zone snapshot: what the status line's freshness is judged on. */
    oldestMs: number | null;
    newestMs: number | null;
}

/** Oldest and newest age across zone snapshots; null where no snapshot carries a usable time. */
export const snapshotAges = (generatedAts: (string | undefined)[]): SnapshotAges => {
    const ages = generatedAts
        .map((generatedAt) => (generatedAt ? parseSnapshotAgeMs(generatedAt) : null))
        .filter((age): age is number => age != null);
    return ages.length === 0
        ? { oldestMs: null, newestMs: null }
        : { oldestMs: Math.max(...ages), newestMs: Math.min(...ages) };
};
