import { nodeId } from '../topology/ids';
import type {
    ClusterUserDefinedNetwork,
    NetworkAttachmentDefinition,
    NodeNetworkConfigurationEnactment,
    NodeNetworkState,
    UserDefinedNetwork
} from '../types';
import type { Finding, FindingScope, FindingSubject, K8sRef } from './types';

const OVN_GROUP = 'k8s.ovn.org';
const NMSTATE_GROUP = 'nmstate.io';

export const cudnRef = (cudn: ClusterUserDefinedNetwork | string): K8sRef => ({
    group: OVN_GROUP, version: 'v1', kind: 'ClusterUserDefinedNetwork',
    name: typeof cudn === 'string' ? cudn : cudn.metadata?.name || ''
});

export const udnRef = (udn: UserDefinedNetwork): K8sRef => ({
    group: OVN_GROUP, version: 'v1', kind: 'UserDefinedNetwork',
    name: udn.metadata?.name || '', namespace: udn.metadata?.namespace || 'default'
});

export const nadRef = (nad: NetworkAttachmentDefinition): K8sRef => ({
    group: 'k8s.cni.cncf.io', version: 'v1', kind: 'NetworkAttachmentDefinition',
    name: nad.metadata?.name || '', namespace: nad.metadata?.namespace || 'default'
});

export const nnsRef = (nns: NodeNetworkState | string): K8sRef => ({
    group: NMSTATE_GROUP, version: 'v1beta1', kind: 'NodeNetworkState',
    name: typeof nns === 'string' ? nns : nns.metadata?.name || ''
});

export const nnceRef = (nnce: NodeNetworkConfigurationEnactment): K8sRef => ({
    group: NMSTATE_GROUP, version: 'v1beta1', kind: 'NodeNetworkConfigurationEnactment',
    name: nnce.metadata?.name || ''
});

export const nncpRef = (policyName: string): K8sRef => ({
    group: NMSTATE_GROUP, version: 'v1', kind: 'NodeNetworkConfigurationPolicy', name: policyName
});

export const nodeRef = (name: string): K8sRef => ({ group: '', version: 'v1', kind: 'Node', name });

export const podRef = (namespace: string, name: string): K8sRef =>
    ({ group: '', version: 'v1', kind: 'Pod', name, namespace });

export const multiNetworkPolicyRef = (namespace: string, name: string): K8sRef => ({
    group: 'k8s.cni.cncf.io', version: 'v1beta1', kind: 'MultiNetworkPolicy', name, namespace
});

export const nadRefByName = (namespace: string, name: string): K8sRef => ({
    group: 'k8s.cni.cncf.io', version: 'v1', kind: 'NetworkAttachmentDefinition', name, namespace
});

export const refKey = (ref: K8sRef): string =>
    `${ref.group}/${ref.kind}/${ref.namespace ? `${ref.namespace}/` : ''}${ref.name}`;

export const sameRef = (a: K8sRef | undefined, b: K8sRef | undefined): boolean =>
    Boolean(a && b && refKey(a) === refKey(b));

/**
 * The graph node a network object is drawn as, on any node's physical graph. Lets a
 * network-scope finding (subject: the CUDN) be shown on the graph node of that CUDN.
 */
export const graphNodeIdForRef = (ref: K8sRef): string | undefined => {
    if (ref.kind === 'ClusterUserDefinedNetwork') return nodeId('cudn', ref.name);
    if (ref.kind === 'UserDefinedNetwork') return nodeId('udn', ref.namespace || 'default', ref.name);
    if (ref.kind === 'NetworkAttachmentDefinition') return nodeId('nad', ref.namespace || 'default', ref.name);
    return undefined;
};

export const subjectKey = (subject: FindingSubject): string => {
    switch (subject.kind) {
        case 'graph-node': return `graph:${subject.node}:${subject.graphNodeId}`;
        case 'construct': return `construct:${subject.node ?? ''}:${subject.constructKind}:${subject.name}`;
        default: return `k8s:${refKey(subject.ref)}`;
    }
};

/**
 * A finding's identity: rule, subject and scope. Two evaluations of the same state
 * give the same key, so a surface can use it as a React key and dedupe on it.
 */
export const findingKey = (
    ruleId: string,
    subject: FindingSubject,
    scope: FindingScope,
    discriminator?: string
): string => [
    ruleId, subjectKey(subject), scope.node ?? '', scope.network ? refKey(scope.network) : '',
    ...(discriminator ? [discriminator] : [])
].join('|');

/**
 * Build a Finding, filling in its key. `discriminator` tells apart findings a rule
 * raises more than once on one subject (a VRF with two missing ports).
 */
export const makeFinding = (finding: Omit<Finding, 'key'>, discriminator?: string): Finding => ({
    ...finding,
    key: findingKey(finding.ruleId, finding.subject, finding.scope, discriminator)
});
