import type { ContextChip, DrawerIdentityProps, Identifier } from '../components/drawerKit';
import { interfaceStateStatus } from '../components/drawerKit';
import { findPrimaryNetworkForVrf } from '../components/nodeVisualizationSelectors';
import { Interface } from '../types';
import { GraphContext } from './context';
import { resourceTarget } from '../linkOut/registry';
import { nodeKindRegistry } from './registry';
import { AttachmentNode, NodeViewModel, ResourceRef } from './types';

/**
 * The physical drawer's identity header as data (ovn-recon-dp7.1): the same
 * name, kind, state and context chips the logical drawer opens with. Pure, so
 * the header is tested without rendering the graph.
 */

/** Kinds whose raw item is an nmstate interface, with an oper state. */
const INTERFACE_KINDS = new Set(['interface', 'vrf']);

const nodeRef = (name: string): ResourceRef => ({ apiVersion: 'v1', kind: 'Node', name });

const cudnRef = (name: string): ResourceRef => ({ apiVersion: 'k8s.ovn.org/v1', kind: 'ClusterUserDefinedNetwork', name });

const udnRef = (namespace: string, name: string): ResourceRef => ({
    apiVersion: 'k8s.ovn.org/v1', kind: 'UserDefinedNetwork', name, namespace
});

/** The network a selection belongs to, when it is not itself the network. */
const networkChip = (node: NodeViewModel, ctx: GraphContext): ContextChip | undefined => {
    if (node.kind === 'vrf') {
        const primary = findPrimaryNetworkForVrf(node.raw as Interface, ctx.cudns, ctx.udns, ctx.interfaces, ctx.nads);
        if (!primary) return undefined;
        // The same evidence rule as the Serves Primary Network fact: only the
        // network's own status is declared.
        const inferred = !primary.signals.includes('status');
        return primary.kind === 'cudn'
            ? { kind: 'Network', value: primary.name, target: resourceTarget(cudnRef(primary.name)), inferred }
            : {
                kind: 'Network',
                value: `${primary.namespace}/${primary.name}`,
                target: resourceTarget(udnRef(primary.namespace ?? 'default', primary.name)),
                inferred
            };
    }
    if (node.kind === 'attachment') {
        const attachment = node.raw as AttachmentNode | undefined;
        if (attachment?.cudn) {
            return { kind: 'Network', value: attachment.cudn, target: resourceTarget(cudnRef(attachment.cudn)) };
        }
        if (attachment?.udn) {
            const { namespace, name } = attachment.udn;
            return { kind: 'Network', value: `${namespace}/${name}`, target: resourceTarget(udnRef(namespace, name)) };
        }
    }
    return undefined;
};

export const physicalIdentity = (
    node: NodeViewModel,
    ctx: GraphContext
): Omit<DrawerIdentityProps, 'icon'> => {
    const nodeName = ctx.nns?.metadata?.name;
    // An interface says what nmstate calls it (ovs-bridge, ethernet, bond);
    // every other kind says what kind of thing it is.
    const kind = node.kind === 'interface' ? node.subtitle : nodeKindRegistry[node.kind]?.label;
    const rawState = INTERFACE_KINDS.has(node.kind) ? (node.raw as Interface | undefined)?.state : undefined;
    const network = networkChip(node, ctx);
    return {
        name: node.title,
        kind,
        state: typeof rawState === 'string' && rawState
            ? { text: rawState, status: interfaceStateStatus(rawState) }
            : undefined,
        chips: [
            ...(nodeName ? [{ kind: 'Node', value: nodeName, target: resourceTarget(nodeRef(nodeName)) }] : []),
            ...(network ? [network] : [])
        ]
    };
};

/**
 * The physical drawer's Identifiers: the Kubernetes UID of a selection that
 * is a resource (a CUDN, a UDN, a NAD). Interfaces have none beyond their
 * name and MAC, which are facts.
 */
export const physicalIdentifiers = (node: NodeViewModel): Identifier[] => {
    const uid = node.raw?.metadata?.uid;
    return typeof uid === 'string' && uid ? [{ label: 'UID', value: uid }] : [];
};
