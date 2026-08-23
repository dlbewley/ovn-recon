import { Interface } from '../types';
import { GraphContext } from '../topology/context';
import {
    attachmentNodeId,
    attachmentSourceNodeId,
    bridgeMappingNodeId,
    cudnNodeId,
    interfaceNodeId,
    nadNodeId,
    resolveInterfaceRef,
    udnNodeId
} from '../topology/ids';
import { AttachmentNode } from '../topology/types';
import {
    findCudnNameForNad,
    LldpNeighborNode,
    findRouteAdvertisementForVrf,
    getCudnsSelectedByRouteAdvertisement,
    getNadUpstreamNodeIdsForEdges
} from './nodeVisualizationSelectors';

/** @deprecated Use AttachmentNode from ../topology/types. Kept for one release. */
export type AttachmentNodeModel = AttachmentNode;

export interface TopologyEdge {
    source: string;
    target: string;
}

/** An edge that could not be drawn because one end names something not on this node. */
export interface UnresolvedEdge {
    /** What produced it, e.g. 'controller' or 'bridge-mapping'. */
    rule: string;
    /** The name that did not resolve. */
    reference: string;
    /** The node that carried the reference. */
    from: string;
}

export interface TopologyEdgeResult {
    edges: TopologyEdge[];
    /**
     * References that pointed at nothing. Previously these were dropped in silence,
     * which made a dangling controller look identical to a node with no edges.
     */
    unresolved: UnresolvedEdge[];
}

interface BuildTopologyEdgesParams {
    ctx: GraphContext;
    vrfInterfaces: Interface[];
    lldpNeighbors: LldpNeighborNode[];
    attachmentNodes: AttachmentNode[];
    showNads: boolean;
    showLldpNeighbors: boolean;
}

/**
 * Controllers that legitimately name something nmstate does not report as an interface.
 *
 * `ovs-system` is the OVS kernel datapath device. Veths and the Geneve tunnel are
 * enslaved to it, and it appears in no NodeNetworkState -- both real captures show it.
 * Reporting these would fire on every cluster, which is how a useful warning becomes
 * noise nobody reads.
 */
const KNOWN_UNREPORTED_CONTROLLERS = new Set(['ovs-system']);

export const buildTopologyEdges = ({
    ctx,
    vrfInterfaces,
    lldpNeighbors,
    attachmentNodes,
    showNads,
    showLldpNeighbors
}: BuildTopologyEdgesParams): TopologyEdgeResult => {
    const edges: TopologyEdge[] = [];
    const edgeKeys = new Set<string>();
    const unresolved: UnresolvedEdge[] = [];

    const pushEdge = (source: string | undefined, target: string | undefined) => {
        if (!source || !target) return;
        const key = `${source}=>${target}`;
        if (edgeKeys.has(key)) return;
        edgeKeys.add(key);
        edges.push({ source, target });
    };

    /** Follow a name reference, recording it when it points at nothing. */
    const pushNamedEdge = (
        rule: string,
        from: string,
        reference: string | undefined,
        direction: 'to' | 'from'
    ) => {
        if (!reference) return;
        const target = resolveInterfaceRef(reference, ctx);
        if (!target) {
            if (!KNOWN_UNREPORTED_CONTROLLERS.has(reference)) {
                unresolved.push({ rule, reference, from });
            }
            return;
        }
        if (direction === 'to') pushEdge(from, target);
        else pushEdge(target, from);
    };

    ctx.interfaces.forEach((iface) => {
        const ifaceId = interfaceNodeId(iface, ctx);
        // Enslavement: this interface is a port of its controller.
        pushNamedEdge('controller', ifaceId, iface.controller || iface.master, 'to');
        // Layering: a VLAN or MACVLAN device is built on its base interface.
        pushNamedEdge(
            'base-iface',
            ifaceId,
            iface.vlan?.['base-iface'] || iface['mac-vlan']?.['base-iface'],
            'from'
        );
    });

    ctx.bridgeMappings.forEach((mapping) => {
        pushNamedEdge('bridge-mapping', bridgeMappingNodeId(mapping.localnet), mapping.bridge, 'from');
    });

    if (showLldpNeighbors) {
        lldpNeighbors.forEach((neighbor) => {
            pushNamedEdge('lldp', neighbor.id, neighbor.localInterface, 'to');
        });
    }

    ctx.cudns.forEach((cudn) => {
        const physicalNetworkName =
            cudn.spec?.network?.localNet?.physicalNetworkName
            || cudn.spec?.network?.localnet?.physicalNetworkName;
        if (physicalNetworkName) {
            pushEdge(bridgeMappingNodeId(physicalNetworkName), cudnNodeId(cudn.metadata?.name));
        }
    });

    attachmentNodes.forEach((attachment) => {
        pushEdge(attachmentSourceNodeId(attachment), attachmentNodeId(attachment));
    });

    if (showNads) {
        ctx.nads.forEach((nad) => {
            const nadId = nadNodeId(nad);
            const cudnName = findCudnNameForNad(nad, ctx.cudns);
            if (cudnName) {
                pushEdge(cudnNodeId(cudnName), nadId);
            }
            const udnForNad = ctx.udns.find(
                (u) => u.metadata?.namespace === nad.metadata?.namespace
                    && u.metadata?.name === nad.metadata?.name
            );
            if (udnForNad) {
                pushEdge(udnNodeId(udnForNad), nadId);
            }
            getNadUpstreamNodeIdsForEdges(nad, ctx.cudns).forEach((upstreamId) => {
                // Bridge references arrive as bare names; localnet references already
                // arrive as canonical ovn: ids.
                if (upstreamId.startsWith('ovn:')) pushEdge(upstreamId, nadId);
                else pushNamedEdge('nad-bridge', nadId, upstreamId, 'from');
            });
        });
    }

    vrfInterfaces.forEach((vrf) => {
        const ra = findRouteAdvertisementForVrf(ctx.routeAdvertisements, vrf.name);
        getCudnsSelectedByRouteAdvertisement(ra, ctx.cudns).forEach((cudn) => {
            pushEdge(interfaceNodeId(vrf, ctx), cudnNodeId(cudn.metadata?.name));
        });
    });

    return { edges, unresolved };
};
