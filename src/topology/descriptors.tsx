import * as React from 'react';
import {
    InfrastructureIcon, LinuxIcon, MigrationIcon, NetworkIcon, PficonVcenterIcon,
    PluggedIcon, ResourcePoolIcon, RouteIcon, TagIcon
} from '@patternfly/react-icons';

import {
    findCudnNameForNad,
    findRouteAdvertisementForVrf,
    getCudnsSelectedByRouteAdvertisement,
    getNadUpstreamNodeIdsForEdges,
    parseNadConfig,
    LldpNeighborNode
} from '../components/nodeVisualizationSelectors';
import {
    ClusterUserDefinedNetwork, Interface, NetworkAttachmentDefinition, OvnBridgeMapping,
    UserDefinedNetwork
} from '../types';
import { InterfaceRole, interfacesWithRole } from './classify';
import { EdgeKind } from '../components/nodeVisualizationModel';
import { GraphContext } from './context';
import {
    attachmentNodeId, attachmentSourceNodeId, bridgeMappingNodeId, cudnNodeId,
    interfaceNodeId, nadNodeId, udnNodeId
} from './ids';
import { getUdnTopologyAndRole } from './registry';
import { AttachmentNode, NetworkColumnItem, NodeKind, ResourceRef } from './types';

/**
 * One descriptor per kind of node the graph draws.
 *
 * Adding a node type used to mean ten coordinated edits across the component -- a
 * filter, a lane entry, a position block, a sort call, a height calculation, a render
 * branch, an icon case, a colour literal, a view-model branch and an edge rule -- none
 * of which were enforced, and each of which failed differently and silently when
 * forgotten. All of that now lives here, in one object per type.
 *
 * CLASSIFICATION STAYS CENTRALISED. Interface-backed descriptors declare the ROLE they
 * render and topology/classify.ts remains the single ordered rule table that decides
 * what an interface is. Scattering `match` predicates across descriptors would turn
 * classify's two load-bearing orderings into an invisible coupling between files -- see
 * the note on ovn-recon-s3t.9.
 */

export type NodeTypeId =
    | 'physical' | 'bond' | 'vlan' | 'bridge' | 'bridge-port' | 'vrf'
    | 'ovn-mapping' | 'cudn' | 'udn' | 'attachment' | 'nad' | 'lldp-neighbor' | 'other';

/** What the node shows on the canvas and in the drawer header. */
export interface NodePresentation {
    label: string;
    subtitle: string;
    /** Abbreviation shown on the canvas. Falls back to the subtitle. */
    graphLabel?: string;
    state?: string;
    namespaces?: string[];
    resourceRef?: ResourceRef;
    isSynthetic?: boolean;
}

/** Collects edges, so a descriptor never constructs the result shape itself. */
export interface EdgeSink {
    /** An edge between two known node ids. Must say what the relationship is. */
    edge: (
        source: string | undefined,
        target: string | undefined,
        kind: EdgeKind,
        rule: string
    ) => void;
    /**
     * An edge to whatever an interface NAME refers to. Records the reference when it
     * resolves to nothing, rather than dropping it in silence.
     */
    named: (
        rule: string,
        kind: EdgeKind,
        from: string,
        reference: string | undefined,
        direction: 'to' | 'from'
    ) => void;
}

/**
 * The table holds descriptors for differently-shaped items, so its element type is
 * erased. Required fields are still enforced per descriptor at its declaration site,
 * which is what makes an incomplete one a compile error.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyNodeTypeDescriptor = NodeTypeDescriptor<any>;

export interface NodeTypeDescriptor<T = never> {
    type: NodeTypeId;
    /** Which drawer panel set this node uses. */
    kind: NodeKind;
    /** Lane it draws in, or null when it is placed outside the lanes. */
    lane: string | null;
    /** Sub-header, when more than one type shares a lane. */
    groupTitle?: string;
    /** Extra gap above this type when it follows another in the same lane. */
    gapBefore?: number;
    items: (ctx: GraphContext) => T[];
    id: (item: T, ctx: GraphContext) => string;
    icon: React.ReactNode;
    color: string;
    /** Node height when it varies with content. */
    height?: (item: T, defaultHeight: number) => number;
    present: (item: T, ctx: GraphContext) => NodePresentation;
    /** Status dot on the node. Omitted by types that have no meaningful up/down. */
    status?: (item: T) => 'up' | 'down' | 'unknown';
    /** Extra content drawn inside the node box, e.g. the attachment namespace list. */
    detail?: (item: T, box: { width: number; height: number }) => React.ReactNode;
    edges?: (item: T, ctx: GraphContext, out: EdgeSink) => void;
}

// --- shared behaviour ------------------------------------------------------

/** Every interface-backed node presents the same way and contributes the same edges. */
const presentInterface = (iface: Interface): NodePresentation => ({
    label: iface.name,
    subtitle: iface.type,
    state: iface.state
});

const interfaceEdges = (iface: Interface, ctx: GraphContext, out: EdgeSink) => {
    const id = interfaceNodeId(iface, ctx);
    // Enslavement: this interface is a port of its controller.
    out.named('controller', 'membership', id, iface.controller || iface.master, 'to');
    // Layering: a VLAN or MACVLAN device is built on its base interface.
    out.named('base-iface', 'layering', id, iface.vlan?.['base-iface'] || iface['mac-vlan']?.['base-iface'], 'from');
};

/** An interface-backed descriptor differs only in role, lane, icon and colour. */
const interfaceType = (
    type: NodeTypeId,
    role: InterfaceRole,
    lane: string | null,
    icon: React.ReactNode,
    color: string
): NodeTypeDescriptor<Interface> => ({
    type,
    kind: 'interface',
    lane,
    icon,
    color,
    items: (ctx) => interfacesWithRole(ctx, role),
    id: (iface, ctx) => interfaceNodeId(iface, ctx),
    present: presentInterface,
    status: (iface) => (iface.state === 'up' ? 'up' : 'down'),
    edges: interfaceEdges
});

const resourceRefOf = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resource: any,
    defaultKind: string
): ResourceRef | undefined => (resource.metadata?.name
    ? {
        apiVersion: resource.apiVersion || '',
        kind: resource.kind || defaultKind,
        name: resource.metadata.name,
        namespace: resource.metadata.namespace
    }
    : undefined);

// --- the table -------------------------------------------------------------

/**
 * ORDER MATTERS WITHIN A LANE. Descriptors sharing a lane stack in table order and take
 * their group rank from it, so bridge mappings must precede VRFs in the Layer 3 lane.
 * Getting this backwards inverts the lane and moves every edge that touches it -- which
 * it did, once, before the snapshot caught it.
 */
export const NODE_TYPES: AnyNodeTypeDescriptor[] = [
    interfaceType('physical', 'physical', 'eth', <ResourcePoolIcon />, '#0066CC'),
    interfaceType('bond', 'bond', 'bond', <PficonVcenterIcon />, '#663399'),
    interfaceType('vlan', 'vlan', 'vlan', <TagIcon />, '#9933CC'),
    interfaceType('bridge', 'bridge', 'bridge', <InfrastructureIcon />, '#FF6600'),
    interfaceType('bridge-port', 'bridge-port', 'logical', <NetworkIcon />, '#0099CC'),
    // Rendered in the grid at the foot of the canvas rather than in a lane.
    interfaceType('other', 'host-local', null, <NetworkIcon />, '#666'),

    {
        type: 'ovn-mapping',
        kind: 'ovn-mapping',
        lane: 'l3',
        groupTitle: 'Bridge Mappings',
        icon: <RouteIcon />,
        color: '#009900',
        items: (ctx) => ctx.bridgeMappings,
        id: (mapping) => bridgeMappingNodeId(mapping.localnet),
        present: (mapping) => ({
            label: mapping.localnet,
            subtitle: 'OVN Bridge Mapping',
            graphLabel: 'OVN Bridge Mapping',
            state: mapping.bridge ? `Bridge: ${mapping.bridge}` : undefined
        }),
        edges: (mapping, _ctx, out) => {
            out.named('bridge-mapping', 'reference', bridgeMappingNodeId(mapping.localnet), mapping.bridge, 'from');
        }
    } as NodeTypeDescriptor<OvnBridgeMapping>,

    {
        type: 'vrf',
        kind: 'vrf',
        lane: 'l3',
        groupTitle: 'VRFs',
        gapBefore: 40,
        icon: <InfrastructureIcon />,
        color: '#CC6600',
        items: (ctx) => interfacesWithRole(ctx, 'vrf'),
        id: (vrf, ctx) => interfaceNodeId(vrf, ctx),
        present: (vrf) => {
            const details: string[] = [];
            if (vrf.vrf?.port) {
                details.push(Array.isArray(vrf.vrf.port) ? vrf.vrf.port.join(', ') : String(vrf.vrf.port));
            }
            if (vrf.vrf?.['route-table-id']) details.push(`Tbl ${vrf.vrf['route-table-id']}`);
            return {
                label: vrf.name,
                subtitle: 'VRF Interface',
                graphLabel: 'VRF',
                state: details.length > 0 ? details.join(' ') : vrf.state
            };
        },
        status: (vrf) => (vrf.state === 'up' ? 'up' : 'down'),
        edges: (vrf, ctx, out) => {
            const ra = findRouteAdvertisementForVrf(ctx.routeAdvertisements, vrf.name);
            getCudnsSelectedByRouteAdvertisement(ra, ctx.cudns).forEach((cudn) => {
                out.edge(interfaceNodeId(vrf, ctx), cudnNodeId(cudn.metadata?.name), 'reference', 'route-advertisement');
            });
        }
    } as NodeTypeDescriptor<Interface>,

    {
        type: 'cudn',
        kind: 'cudn',
        lane: 'networks',
        icon: <NetworkIcon />,
        color: '#CC0099',
        items: (ctx) => ctx.cudns,
        id: (cudn) => cudnNodeId(cudn.metadata?.name),
        present: (cudn) => {
            const network = cudn.spec?.network;
            const topology = network?.topology || 'Unknown';
            let state = topology;
            if (topology === 'Localnet') {
                const vlan = network?.localnet?.vlan?.access?.id;
                if (vlan) state += ` VLAN ${vlan}`;
            } else if (topology === 'Layer2' || topology === 'Layer3') {
                const subnets = topology === 'Layer2' ? network?.layer2?.subnets : network?.layer3?.subnets;
                if (subnets && subnets.length > 0) state += ` ${subnets.join(', ')}`;
            }
            return {
                label: cudn.metadata?.name || '',
                subtitle: `${topology} ClusterUserDefinedNetwork`,
                graphLabel: 'CUDN',
                state,
                resourceRef: resourceRefOf(cudn, 'ClusterUserDefinedNetwork')
            };
        },
        edges: (cudn, _ctx, out) => {
            const physicalNetworkName = cudn.spec?.network?.localNet?.physicalNetworkName
                || cudn.spec?.network?.localnet?.physicalNetworkName;
            if (physicalNetworkName) {
                out.edge(bridgeMappingNodeId(physicalNetworkName), cudnNodeId(cudn.metadata?.name), 'reference', 'physical-network-name');
            }
        }
    } as NodeTypeDescriptor<ClusterUserDefinedNetwork>,

    {
        type: 'udn',
        kind: 'udn',
        lane: 'networks',
        icon: <NetworkIcon />,
        color: '#0084A8',
        items: (ctx) => ctx.udns,
        id: (udn) => udnNodeId(udn),
        present: (udn) => {
            const ns = udn.metadata?.namespace || '';
            const { topology, role } = getUdnTopologyAndRole(udn);
            return {
                label: udn.metadata?.name || '',
                subtitle: `UserDefinedNetwork · ${ns} · ${topology} · ${role}`,
                graphLabel: ns ? `UDN · ${ns}` : 'UDN',
                state: `${topology} · ${role}`,
                resourceRef: resourceRefOf(udn, 'UserDefinedNetwork')
            };
        }
    } as NodeTypeDescriptor<UserDefinedNetwork>,

    {
        type: 'attachment',
        kind: 'attachment',
        lane: 'attachments',
        icon: <MigrationIcon />,
        color: '#F0AB00',
        // Synthetic: built by the caller from CUDN status and UDN presence, so it is
        // supplied rather than derived from the context.
        items: (ctx) => ctx.attachmentNodes ?? [],
        id: (attachment) => attachmentNodeId(attachment),
        height: (attachment, defaultHeight) => {
            const chars = attachment.namespaces.join(', ').length;
            // Base height for icon and title, plus a line per ~25 characters.
            return Math.max(defaultHeight, 60 + Math.ceil(chars / 25) * 12 + 10);
        },
        present: (attachment) => ({
            label: attachment.name,
            subtitle: 'NetworkAttachmentDefinition',
            graphLabel: 'NAD',
            state: 'Namespaces:',
            namespaces: attachment.namespaces || [],
            isSynthetic: true
        }),
        detail: (attachment, box) => (
            <foreignObject x={10} y={60} width={box.width - 20} height={box.height - 70}>
                <div style={{ fontSize: '10px', color: '#eee', wordWrap: 'break-word', lineHeight: '1.2' }}>
                    {attachment.namespaces.join(', ')}
                </div>
            </foreignObject>
        ),
        edges: (attachment, _ctx, out) => {
            out.edge(attachmentSourceNodeId(attachment), attachmentNodeId(attachment), 'membership', 'attached-namespaces');
        }
    } as NodeTypeDescriptor<AttachmentNode>,

    {
        type: 'nad',
        kind: 'nad',
        lane: 'nads',
        icon: <RouteIcon />,
        color: '#CC9900',
        items: (ctx) => ctx.nads,
        id: (nad) => nadNodeId(nad),
        present: (nad) => {
            const config = parseNadConfig(nad.spec?.config);
            const nadType = typeof config?.type === 'string' ? config.type : undefined;
            return {
                label: nad.metadata?.name || '',
                subtitle: 'NetworkAttachmentDefinition',
                graphLabel: 'NAD',
                state: nadType ? `Type: ${nadType}` : undefined,
                resourceRef: resourceRefOf(nad, 'NetworkAttachmentDefinition')
            };
        },
        edges: (nad, ctx, out) => {
            const id = nadNodeId(nad);
            const cudnName = findCudnNameForNad(nad, ctx.cudns);
            if (cudnName) out.edge(cudnNodeId(cudnName), id, 'reference', 'cudn-created-nad');

            const udnForNad = ctx.udns.find(
                (u) => u.metadata?.namespace === nad.metadata?.namespace
                    && u.metadata?.name === nad.metadata?.name
            );
            if (udnForNad) out.edge(udnNodeId(udnForNad), id, 'reference', 'udn-created-nad');

            getNadUpstreamNodeIdsForEdges(nad, ctx.cudns).forEach((upstream) => {
                // Localnet references already arrive canonical; bridges arrive as names.
                if (upstream.startsWith('ovn:')) out.edge(upstream, id, 'reference', 'nad-physical-network');
                else out.named('nad-bridge', 'reference', id, upstream, 'from');
            });
        }
    } as NodeTypeDescriptor<NetworkAttachmentDefinition>,

    {
        type: 'lldp-neighbor',
        kind: 'lldp-neighbor',
        lane: 'lldp',
        icon: <PluggedIcon />,
        color: '#2E7D32',
        items: (ctx) => ctx.lldpNeighbors ?? [],
        id: (neighbor) => neighbor.id,
        present: (neighbor) => {
            const details: string[] = [];
            if (neighbor.localInterface) details.push(`Local: ${neighbor.localInterface}`);
            if (neighbor.portId) details.push(`Port: ${neighbor.portId}`);
            return {
                label: neighbor.label || `LLDP Neighbor ${neighbor.neighborIndex + 1}`,
                subtitle: 'LLDP Neighbor',
                graphLabel: 'LLDP',
                state: details.join(' · ')
            };
        },
        edges: (neighbor, _ctx, out) => {
            out.named('lldp', 'peer', neighbor.id, neighbor.localInterface, 'to');
        }
    } as NodeTypeDescriptor<LldpNeighborNode>
];

const BY_TYPE = new Map(NODE_TYPES.map((d) => [d.type, d]));
export const descriptorFor = (type: NodeTypeId): AnyNodeTypeDescriptor | undefined =>
    BY_TYPE.get(type);

/** Descriptors drawing in a given lane, in table order. */
export const descriptorsInLane = (lane: string): AnyNodeTypeDescriptor[] =>
    NODE_TYPES.filter((d) => d.lane === lane);

/**
 * A few icons are keyed on the nmstate type rather than the node type, because all
 * interface roles share one descriptor family but draw different pictures.
 */
const INTERFACE_ICONS: Record<string, React.ReactNode> = {
    ethernet: <ResourcePoolIcon />,
    bond: <PficonVcenterIcon />,
    'linux-bridge': <LinuxIcon />,
    'ovs-bridge': <InfrastructureIcon />,
    'ovs-interface': <NetworkIcon />,
    vlan: <TagIcon />,
    'mac-vlan': <TagIcon />
};

export const iconFor = (descriptor: AnyNodeTypeDescriptor, item: unknown): React.ReactNode => {
    if (descriptor.kind === 'interface') {
        const type = (item as Interface | undefined)?.type;
        return (type && INTERFACE_ICONS[type]) || descriptor.icon;
    }
    return descriptor.icon;
};

export type { NetworkColumnItem };
