import { graphNodeIdForRef, sameRef, subjectKey } from './refs';
import type { Finding, FindingSubject, K8sRef, Severity } from './types';

/**
 * What the surfaces ask of a list of findings (ovn-recon-7i6.1). All pure; pass the
 * array an evaluator returned.
 */

/** Findings whose subject is exactly this one. */
export const findingsForSubject = (findings: Finding[], subject: FindingSubject): Finding[] => {
    const key = subjectKey(subject);
    return findings.filter((finding) => subjectKey(finding.subject) === key);
};

/**
 * Findings to badge on one node of one node's physical graph: those about that graph
 * node on that node, and the network-wide findings about the network object it draws
 * (a CUDN, UDN or NAD), which belong on every node's graph.
 */
export const findingsForGraphNode = (findings: Finding[], node: string, graphNodeId: string): Finding[] =>
    findings.filter((finding) => {
        const { subject } = finding;
        if (subject.kind === 'graph-node') return subject.node === node && subject.graphNodeId === graphNodeId;
        if (subject.kind === 'k8s') {
            return graphNodeIdForRef(subject.ref) === graphNodeId
                && (finding.scope.node === undefined || finding.scope.node === node);
        }
        return false;
    });

/**
 * Findings on one logical construct, by the kind and name a `?select=KIND:NAME` link
 * uses. With `node`, only that zone's findings and the zone-less ones.
 */
export const findingsForConstruct = (
    findings: Finding[],
    constructKind: string,
    name: string,
    node?: string
): Finding[] => findings.filter(({ subject }) =>
    subject.kind === 'construct'
    && subject.constructKind === constructKind
    && subject.name === name
    && (node === undefined || subject.node === undefined || subject.node === node));

/** Findings scoped to one node: what the overview's node table counts. */
export const findingsForNode = (findings: Finding[], node: string): Finding[] =>
    findings.filter((finding) => finding.scope.node === node);

/** Findings about one network object, network-wide or on any node. */
export const findingsForNetwork = (findings: Finding[], network: K8sRef): Finding[] =>
    findings.filter((finding) => sameRef(finding.scope.network, network)
        || (finding.subject.kind === 'k8s' && sameRef(finding.subject.ref, network)));

export type SeverityCounts = Record<Severity, number> & { total: number };

export const countBySeverity = (findings: Finding[]): SeverityCounts =>
    findings.reduce<SeverityCounts>((counts, finding) => {
        counts[finding.severity] += 1;
        counts.total += 1;
        return counts;
    }, { warning: 0, info: 0, total: 0 });

/** The worst severity present, for a badge; undefined when there are none. */
export const highestSeverity = (findings: Finding[]): Severity | undefined => {
    if (findings.some((finding) => finding.severity === 'warning')) return 'warning';
    return findings.length > 0 ? 'info' : undefined;
};
