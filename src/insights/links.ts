import { networkPath } from '../components/networkPageModel';
import type { NetworkAddress } from '../components/networkPageModel';
import { nodePhysicalPath } from '../routes';
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
export const nodePagePath = (node: string, graphNodeId?: string): string => nodePhysicalPath(node, graphNodeId);

export interface FindingLink {
    /** A route inside the plugin, for a router Link. */
    to?: string;
    /** A console page outside the plugin. */
    href?: string;
    /** What the link opens, for its text. */
    label: string;
    /** A second place worth offering: a node's graph with the network selected. */
    secondary?: { to: string; label: string };
}

/** The network page address of a CUDN, UDN or NAD; undefined for any other kind. */
export const networkAddressForRef = (ref: K8sRef): NetworkAddress | undefined => {
    if (ref.kind === 'ClusterUserDefinedNetwork') return { kind: 'cudn', name: ref.name };
    if (ref.kind === 'UserDefinedNetwork') return { kind: 'udn', name: ref.name, namespace: ref.namespace || 'default' };
    if (ref.kind === 'NetworkAttachmentDefinition') return { kind: 'nad', name: ref.name, namespace: ref.namespace || 'default' };
    return undefined;
};

/**
 * Where an overview entry for a finding links to: its subject, selected.
 *
 *   on one node's graph   that node's page, ?select= the graph node
 *   a CUDN, UDN or NAD    the network's own page. For a CUDN or UDN, which every
 *                         node's graph draws, a node page with ?select= the network
 *                         is offered second (`anyNode` picks which one; the first by
 *                         name). A NAD's lane is hidden by default, so it cannot be
 *                         selected on arrival and gets no second link.
 *   anything else         the object in the console
 */
export const findingSubjectLink = (finding: Finding, anyNode?: string): FindingLink => {
    const { subject } = finding;
    if (subject.kind === 'graph-node') {
        return { to: nodePagePath(subject.node, subject.graphNodeId), label: subject.node };
    }
    if (subject.kind === 'k8s') {
        const address = networkAddressForRef(subject.ref);
        if (address) {
            const node = finding.scope.node ?? anyNode;
            const graphNodeId = graphNodeIdForRef(subject.ref);
            const drawnOnEveryNode = address.kind !== 'nad';
            return {
                to: networkPath(address),
                label: refLabel(subject.ref),
                ...(node && graphNodeId && drawnOnEveryNode
                    ? { secondary: { to: nodePagePath(node, graphNodeId), label: `Physical view on ${node}` } }
                    : {})
            };
        }
        return { href: consoleHrefForRef(subject.ref), label: refLabel(subject.ref) };
    }
    return { label: `${subject.constructKind} ${subject.name}` };
};
