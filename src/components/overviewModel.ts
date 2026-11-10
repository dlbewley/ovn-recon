import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import {
    ClusterUserDefinedNetwork,
    NetworkAttachmentDefinition,
    NodeNetworkState,
    RouteAdvertisements,
    UserDefinedNetwork,
} from '../types';
import { findingSubjectLink, FindingLink } from '../insights/links';
import { countBySeverity, SeverityCounts } from '../insights/selectors';
import type { Finding, Severity } from '../insights/types';
import { extractLldpNeighbors } from './nodeVisualizationSelectors';

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

export interface NetworkSummary {
    cudns: number;
    /** CUDN count per topology as declared, e.g. { Localnet: 3, Layer2: 1 }. */
    cudnsByTopology: Record<string, number>;
    udns: number;
    nads: number;
    routeAdvertisements: number;
}

export const summarizeNetworks = (
    cudns: ClusterUserDefinedNetwork[],
    udns: UserDefinedNetwork[],
    nads: NetworkAttachmentDefinition[],
    routeAdvertisements: RouteAdvertisements[],
): NetworkSummary => {
    const cudnsByTopology: Record<string, number> = {};
    for (const cudn of cudns) {
        const topology = cudn.spec?.network?.topology ?? 'Unknown';
        cudnsByTopology[topology] = (cudnsByTopology[topology] ?? 0) + 1;
    }
    return {
        cudns: cudns.length,
        cudnsByTopology,
        udns: udns.length,
        nads: nads.length,
        routeAdvertisements: routeAdvertisements.length,
    };
};

/** "3 Localnet, 1 Layer2", topologies in descending count order; empty string with no CUDNs. */
export const formatCudnBreakdown = (byTopology: Record<string, number>): string =>
    Object.entries(byTopology)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([topology, count]) => `${count} ${topology}`)
        .join(', ');

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
