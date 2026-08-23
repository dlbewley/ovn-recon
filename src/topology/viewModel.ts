import {
    getVrfRoutesForInterface,
    parseNadConfig,
    VrfAssociatedRoute
} from '../components/nodeVisualizationSelectors';
import { Interface, UserDefinedNetwork } from '../types';
import { GraphContext } from './context';
import { resolveNodeId } from './ids';
import { getResourceLinks } from './links';
import { nodeKindRegistry, getUdnTopologyAndRole } from './registry';
import { NodeKind, NodeViewModel, ResourceRef } from './types';

/**
 * Build the view model for one graph node.
 *
 * Moved out of the component body unchanged apart from taking the context
 * explicitly. It was previously invoked from renderInterfaceNode for EVERY node on
 * EVERY render, which is why ovn-recon-s3t.4 exists -- for VRF nodes it walks the
 * whole NNS route table, and only the selected node's model is ever read.
 */
 
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const buildNodeViewModel = (iface: any, type: string, ctx: GraphContext): NodeViewModel => {
    const nodeId = resolveNodeId(iface, type, ctx);
    const kind: NodeKind = type === 'ovn-mapping'
        ? 'ovn-mapping'
        : type === 'vrf'
            ? 'vrf'
            : type === 'cudn'
                ? 'cudn'
                : type === 'udn'
                    ? 'udn'
                    : type === 'attachment'
                    ? 'attachment'
                    : type === 'nad'
                        ? 'nad'
                        : type === 'lldp-neighbor'
                            ? 'lldp-neighbor'
                        : type === 'other'
                            ? 'other'
                            : 'interface';

    let label = iface.name;
    let title = iface.name;
    let subtitle = type;
    let graphDisplayLabel: string | undefined;
    let state = iface.state;
    let namespaces: string[] | undefined;
    let resourceRef: ResourceRef | undefined;
    let isSynthetic = false;
    let vrfRoutes: VrfAssociatedRoute[] | undefined;

    if (type === 'ovn-mapping') {
        label = iface.localnet;
        title = iface.localnet;
        subtitle = 'OVN Bridge Mapping';
        graphDisplayLabel = 'OVN Bridge Mapping'; // Same as subtitle for bridge mappings
        state = iface.bridge ? `Bridge: ${iface.bridge}` : undefined;
    } else if (type === 'vrf') {
        label = iface.name;
        title = iface.name;
        subtitle = 'VRF Interface';
        graphDisplayLabel = 'VRF';
        const details: string[] = [];
        if (iface.vrf?.port) details.push(`${Array.isArray(iface.vrf.port) ? iface.vrf.port.join(', ') : iface.vrf.port}`);
        if (iface.vrf?.['route-table-id']) details.push(`Tbl ${iface.vrf['route-table-id']}`);
        state = details.length > 0 ? details.join(' ') : iface.state;
        vrfRoutes = getVrfRoutesForInterface(iface as Interface, ctx.nns);
    } else if (type === 'cudn') {
        label = iface.metadata?.name || '';
        title = iface.metadata?.name || '';
        const topology = iface.spec?.network?.topology || 'Unknown';
        subtitle = `${topology} ClusterUserDefinedNetwork`;
        graphDisplayLabel = 'CUDN'; // Abbreviation for graph display
        state = topology;
        if (iface.spec?.network?.topology === 'Localnet') {
            const vlan = iface.spec?.network?.localnet?.vlan?.access?.id;
            if (vlan) {
                state += ` VLAN ${vlan}`;
            }
        } else if (iface.spec?.network?.topology === 'Layer2' || iface.spec?.network?.topology === 'Layer3') {
            const subnets = iface.spec?.network?.topology === 'Layer2'
                ? iface.spec?.network?.layer2?.subnets
                : iface.spec?.network?.layer3?.subnets;
            if (subnets && subnets.length > 0) {
                state += ` ${subnets.join(', ')}`;
            }
        }
        if (iface.metadata?.name) {
            resourceRef = {
                apiVersion: iface.apiVersion || '',
                kind: iface.kind || 'ClusterUserDefinedNetwork',
                name: iface.metadata.name,
                namespace: iface.metadata.namespace
            };
        }
    } else if (type === 'udn') {
        const ns = iface.metadata?.namespace || '';
        const { topology, role } = getUdnTopologyAndRole(iface as UserDefinedNetwork);
        label = iface.metadata?.name || '';
        title = iface.metadata?.name || '';
        subtitle = `UserDefinedNetwork · ${ns} · ${topology} · ${role}`;
        graphDisplayLabel = ns ? `UDN · ${ns}` : 'UDN';
        state = `${topology} · ${role}`;
        if (iface.metadata?.name) {
            resourceRef = {
                apiVersion: iface.apiVersion || '',
                kind: iface.kind || 'UserDefinedNetwork',
                name: iface.metadata.name,
                namespace: iface.metadata.namespace
            };
        }
    } else if (type === 'attachment') {
        label = iface.name;
        title = iface.name;
        subtitle = 'NetworkAttachmentDefinition';
        graphDisplayLabel = 'NAD'; // Abbreviation for graph display
        state = 'Namespaces:';
        namespaces = iface.namespaces || [];
        isSynthetic = true;
    } else if (type === 'nad') {
        label = iface.metadata?.name || '';
        title = iface.metadata?.name || '';
        subtitle = 'NetworkAttachmentDefinition';
        graphDisplayLabel = 'NAD'; // Abbreviation for graph display
        const config = parseNadConfig(iface.spec?.config);
        const nadType = typeof config?.type === 'string' ? config.type : undefined;
        state = nadType ? `Type: ${nadType}` : undefined;
        if (iface.metadata?.name) {
            resourceRef = {
                apiVersion: iface.apiVersion || '',
                kind: iface.kind || 'NetworkAttachmentDefinition',
                name: iface.metadata.name,
                namespace: iface.metadata.namespace
            };
        }
    } else if (type === 'lldp-neighbor') {
        label = iface.label || `LLDP Neighbor ${Number(iface.neighborIndex || 0) + 1}`;
        title = label;
        subtitle = 'LLDP Neighbor';
        graphDisplayLabel = 'LLDP';
        const details: string[] = [];
        if (iface.localInterface) {
            details.push(`Local: ${iface.localInterface}`);
        }
        if (iface.portId) {
            details.push(`Port: ${iface.portId}`);
        }
        state = details.join(' · ');
    }

    const baseNode: NodeViewModel = {
        id: nodeId,
        kind,
        iconType: type,
        label,
        title,
        subtitle,
        graphDisplayLabel,
        state,
        namespaces,
        resourceRef,
        isSynthetic,
        vrfRoutes,
        raw: iface
    };

    const definition = nodeKindRegistry[kind];
    if (resourceRef && !definition.buildLinks) {
        baseNode.links = getResourceLinks(resourceRef);
    }
    if (definition.buildBadges) {
        baseNode.badges = definition.buildBadges(baseNode);
    }
    if (definition.buildLinks) {
        baseNode.links = definition.buildLinks(baseNode, ctx);
    }

    return baseNode;
};
