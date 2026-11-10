import { withSelectParam } from '../components/useSelectParam';
import { graphNodeIdForRef } from './refs';
import type { Finding, K8sRef } from './types';

/**
 * Where the surfaces send a reader (ovn-recon-7i6.1). Pure.
 */

/** The console's path segment for a kind: `group~version~Kind`, `core` for the core group. */
const consoleModelId = (ref: K8sRef): string => `${ref.group || 'core'}~${ref.version}~${ref.kind}`;

/** The console page of a Kubernetes object: its details page, or its YAML with `yaml`. */
export const consoleHrefForRef = (ref: K8sRef, yaml = false): string => {
    const base = ref.namespace ? `/k8s/ns/${encodeURIComponent(ref.namespace)}` : '/k8s/cluster';
    return `${base}/${consoleModelId(ref)}/${encodeURIComponent(ref.name)}${yaml ? '/yaml' : ''}`;
};

/** `NodeNetworkConfigurationPolicy br-ex-policy`, `NetworkAttachmentDefinition demo/blue`. */
export const refLabel = (ref: K8sRef): string =>
    `${ref.kind} ${ref.namespace ? `${ref.namespace}/` : ''}${ref.name}`;

/** The physical page of one node, with `?select=` on one of its graph nodes. */
export const nodePagePath = (node: string, graphNodeId?: string): string =>
    `/ovn-recon/node-network-state/${encodeURIComponent(node)}${graphNodeId ? withSelectParam('', graphNodeId) : ''}`;

export interface FindingLink {
    /** A route inside the plugin, for a router Link. */
    to?: string;
    /** A console page outside the plugin. */
    href?: string;
    /** What the link opens, for its text. */
    label: string;
}

/**
 * Where an overview entry for a finding links to: its subject, selected.
 *
 *   on one node's graph   that node's page, ?select= the graph node
 *   a CUDN or UDN         a node page with ?select= the network, which every node's
 *                         graph draws (`anyNode` picks which one; the first by name)
 *   anything else         the object in the console (a NAD, whose lane is hidden by
 *                         default and so cannot be selected on arrival)
 */
export const findingSubjectLink = (finding: Finding, anyNode?: string): FindingLink => {
    const { subject } = finding;
    if (subject.kind === 'graph-node') {
        return { to: nodePagePath(subject.node, subject.graphNodeId), label: subject.node };
    }
    if (subject.kind === 'k8s') {
        const node = finding.scope.node ?? anyNode;
        const graphNodeId = graphNodeIdForRef(subject.ref);
        const drawnOnEveryNode = subject.ref.kind === 'ClusterUserDefinedNetwork'
            || subject.ref.kind === 'UserDefinedNetwork';
        if (node && graphNodeId && drawnOnEveryNode) {
            return { to: nodePagePath(node, graphNodeId), label: refLabel(subject.ref) };
        }
        return { href: consoleHrefForRef(subject.ref), label: refLabel(subject.ref) };
    }
    return { label: `${subject.constructKind} ${subject.name}` };
};
