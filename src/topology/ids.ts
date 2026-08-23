import { Interface, NetworkAttachmentDefinition, UserDefinedNetwork } from '../types';
import { GraphContext } from './context';
import { AttachmentNode, NetworkColumnItem } from './types';

/**
 * Node id construction, moved verbatim from the component.
 *
 * These ids are not namespaced: most interfaces resolve to their bare name, so
 * interface names share one id space with everything else, and edges are matched by
 * name string. That is why `resolveNodeId` carries a special case for an ovs-interface
 * that shadows a bridge, and why the connector renderer probes for an 'interface-'
 * prefix before giving up. ovn-recon-s3t.6 replaces the scheme; this module only moves
 * it, so the extraction stays behaviour-preserving.
 */

export const getNadNodeId = (nad: NetworkAttachmentDefinition): string =>
    `nad-${nad.metadata?.namespace || 'default'}-${nad.metadata?.name || 'unknown-nad'}`;

export const getUdnNodeId = (udn: UserDefinedNetwork): string =>
    `udn-${udn.metadata?.namespace || 'default'}-${udn.metadata?.name || 'unknown-udn'}`;

export const getAttachmentNodeId = (node: AttachmentNode): string =>
    node.udnId != null ? `attachment-udn-${node.udnId}` : `attachment-${node.cudn}`;

export const getNetworkNodeId = (n: NetworkColumnItem): string =>
    n.kind === 'cudn' ? `cudn-${n.item.metadata?.name}` : getUdnNodeId(n.item);

export const getBridgeMappingNodeId = (localnet: string | undefined): string => `ovn-${localnet}`;

/**
 * Resolve the graph id for an item being rendered as `type`.
 *
 * `item` is deliberately loose: this is called with interfaces, bridge mappings, CUDNs,
 * UDNs, NADs, attachments and LLDP neighbours, which share no common shape. The typing
 * tightens once each kind owns its own id function under ovn-recon-s3t.9.
 */
export const resolveNodeId = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    item: any,
    type: string,
    ctx: Pick<GraphContext, 'explicitBridgeNames'>
): string => {
    if (type === 'ovn-mapping') return getBridgeMappingNodeId(item.localnet);
    if (type === 'cudn') return `cudn-${item.metadata?.name}`;
    if (type === 'udn') return getUdnNodeId(item as UserDefinedNetwork);
    if (type === 'attachment') return getAttachmentNodeId(item as AttachmentNode);
    if (type === 'nad') return getNadNodeId(item as NetworkAttachmentDefinition);
    if (type === 'lldp-neighbor') return item.id;
    // An ovs-interface sharing a name with a declared bridge is the internal port of
    // that bridge, not the bridge itself, so it needs an id of its own.
    if (type === 'ovs-interface' && ctx.explicitBridgeNames.has(item.name)) {
        return `interface-${item.name}`;
    }
    return item.name;
};

/** Convenience for the common case of resolving an interface by its own type. */
export const interfaceNodeId = (
    iface: Interface,
    ctx: Pick<GraphContext, 'explicitBridgeNames'>
): string => resolveNodeId(iface, iface.type, ctx);
