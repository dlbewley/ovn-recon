import { Interface, NetworkAttachmentDefinition, UserDefinedNetwork } from '../types';
import { GraphContext } from './context';
import { AttachmentNode, NetworkColumnItem } from './types';

/**
 * Canonical node ids.
 *
 * Every id is `<kind>:<key>`, with `/` separating the parts of a compound key. The
 * scheme replaces one where most interfaces resolved to their bare name, so interface
 * names shared an id space with everything else and edges were matched by name string.
 * Two workarounds fell out of that and are now gone: a special case giving a shadowing
 * ovs-interface an `interface-` prefix, and a connector renderer that probed for both
 * spellings before silently dropping the edge.
 *
 *   iface:br-ex                  an interface, including bridges
 *   port:br-ex                   an OVS internal port whose name collides with a bridge
 *   vrf:blue                     a VRF interface
 *   ovn:physnet                  an OVN localnet bridge mapping
 *   cudn:blue                    a ClusterUserDefinedNetwork
 *   udn:ns1/blue                 a namespaced UserDefinedNetwork
 *   nad:ns1/blue                 a NetworkAttachmentDefinition
 *   attachment:cudn/blue         namespaces attached to a CUDN
 *   attachment:udn/ns1/blue      namespaces attached to a UDN
 *   lldp:eno1/0                  the nth LLDP neighbour seen on an interface
 *
 * `port:` exists because that collision is the only one nmstate actually produces: an
 * OVS bridge and its internal port share a name. Giving the port its own kind keeps
 * `iface:<name>` unambiguous, which is what makes name-based edge references resolvable
 * without a lookup table. It also matches where ovn-recon-s3t.26 is heading, where an
 * internal port is drawn on its bridge rather than beside it.
 */

export type NodeIdKind =
    | 'iface' | 'port' | 'vrf' | 'ovn' | 'cudn' | 'udn' | 'nad' | 'attachment' | 'lldp';

export const nodeId = (kind: NodeIdKind, ...parts: (string | number)[]): string =>
    `${kind}:${parts.map((p) => String(p)).join('/')}`;

/** Split an id back into its kind and key. Returns null for anything unrecognised. */
export const parseNodeId = (id: string): { kind: NodeIdKind; key: string } | null => {
    const separator = id.indexOf(':');
    if (separator < 0) return null;
    return { kind: id.slice(0, separator) as NodeIdKind, key: id.slice(separator + 1) };
};

export const ifaceNodeId = (name: string): string => nodeId('iface', name);
export const portNodeId = (name: string): string => nodeId('port', name);
export const vrfNodeId = (name: string): string => nodeId('vrf', name);
export const bridgeMappingNodeId = (localnet: string | undefined): string => nodeId('ovn', localnet ?? '');
export const cudnNodeId = (name: string | undefined): string => nodeId('cudn', name ?? '');
export const lldpNodeId = (localInterface: string, index: number): string =>
    nodeId('lldp', localInterface, index);

export const udnNodeId = (udn: UserDefinedNetwork): string =>
    nodeId('udn', udn.metadata?.namespace || 'default', udn.metadata?.name || 'unknown-udn');

export const nadNodeId = (nad: NetworkAttachmentDefinition): string =>
    nodeId('nad', nad.metadata?.namespace || 'default', nad.metadata?.name || 'unknown-nad');

export const attachmentNodeId = (node: AttachmentNode): string =>
    node.udn
        ? nodeId('attachment', 'udn', node.udn.namespace, node.udn.name)
        : nodeId('attachment', 'cudn', node.cudn ?? '');

/** The network a synthetic attachment node hangs off. */
export const attachmentSourceNodeId = (node: AttachmentNode): string =>
    node.udn ? nodeId('udn', node.udn.namespace, node.udn.name) : cudnNodeId(node.cudn);

export const networkNodeId = (n: NetworkColumnItem): string =>
    n.kind === 'cudn' ? cudnNodeId(n.item.metadata?.name) : udnNodeId(n.item);

/**
 * True when this interface is an OVS internal port sharing its name with a declared
 * bridge. Such a port is the bridge's own interface, not the bridge, and needs an id
 * that does not collide with it.
 */
export const isShadowingInternalPort = (
    iface: Pick<Interface, 'name' | 'type'>,
    ctx: Pick<GraphContext, 'explicitBridgeNames'>
): boolean => iface.type === 'ovs-interface' && ctx.explicitBridgeNames.has(iface.name);

export const interfaceNodeId = (
    iface: Pick<Interface, 'name' | 'type'>,
    ctx: Pick<GraphContext, 'explicitBridgeNames'>
): string => {
    if (iface.type === 'vrf') return vrfNodeId(iface.name);
    return isShadowingInternalPort(iface, ctx) ? portNodeId(iface.name) : ifaceNodeId(iface.name);
};

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
    if (type === 'ovn-mapping') return bridgeMappingNodeId(item.localnet);
    if (type === 'cudn') return cudnNodeId(item.metadata?.name);
    if (type === 'udn') return udnNodeId(item as UserDefinedNetwork);
    if (type === 'attachment') return attachmentNodeId(item as AttachmentNode);
    if (type === 'nad') return nadNodeId(item as NetworkAttachmentDefinition);
    if (type === 'lldp-neighbor') return item.id;
    return interfaceNodeId({ name: item.name, type }, ctx);
};

/**
 * Resolve a bare interface name -- from `controller`, `master`, `vlan.base-iface` or a
 * bridge mapping -- to the node it refers to.
 *
 * Always `iface:` and never `port:`: a reference by name means the bridge, not the
 * bridge's internal port. Returns undefined when no interface carries that name, so
 * callers can report the dangling reference instead of dropping it silently.
 */
export const resolveInterfaceRef = (
    name: string | undefined,
    ctx: Pick<GraphContext, 'interfaces'>
): string | undefined => {
    if (!name) return undefined;
    return ctx.interfaces.some((i) => i.name === name) ? ifaceNodeId(name) : undefined;
};

/**
 * Ids appearing more than once. Duplicates make React log a duplicate-key warning and
 * draw one node on top of another, which reads as missing data rather than as a bug.
 */
export const findDuplicateIds = (ids: string[]): string[] => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    ids.forEach((id) => (seen.has(id) ? duplicates.add(id) : seen.add(id)));
    return Array.from(duplicates).sort();
};

/**
 * Key for an edge between two nodes, independent of direction.
 *
 * Normalised by sorting the endpoints, so an edge has exactly one key. Path
 * highlighting used to insert both spellings "for safety", which worked but meant the
 * set carried two entries per edge and every lookup had to try both.
 */
export const edgeKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
