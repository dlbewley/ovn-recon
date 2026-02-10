import * as React from 'react';
import { Card, CardBody, CardTitle, Drawer, DrawerPanelContent, DrawerContent, DrawerContentBody, DrawerHead, DrawerActions, DrawerCloseButton, Title, DescriptionList, DescriptionListTerm, DescriptionListGroup, DescriptionListDescription, Switch, Tabs, Tab, TabTitleText, Flex, FlexItem, Button, FormSelect, FormSelectOption } from '@patternfly/react-core';
import { useHistory } from 'react-router-dom';
import { useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import { NetworkIcon, RouteIcon, InfrastructureIcon, LinuxIcon, ResourcePoolIcon, PficonVcenterIcon, MigrationIcon, TagIcon, ExternalLinkAltIcon } from '@patternfly/react-icons';

import { CodeEditor, Language } from '@patternfly/react-code-editor';
import * as yaml from 'js-yaml';

import { NodeNetworkState, ClusterUserDefinedNetwork, UserDefinedNetwork, Interface, OvnBridgeMapping, NetworkAttachmentDefinition, RouteAdvertisements } from '../types';
import {
    findRouteAdvertisementForVrf,
    getCudnAssociatedNamespaces,
    getCudnsSelectedByRouteAdvertisement,
    getRouteAdvertisementsMatchingCudn,
    getVrfRoutesForInterface,
    VrfAssociatedRoute,
    getVrfConnectionInfo,
    parseNadConfig
} from './nodeVisualizationSelectors';
import { buildTopologyEdges, TopologyEdge } from './nodeVisualizationModel';
import { computeGravityById, sortByGravity } from './nodeVisualizationLayout';

interface NodeVisualizationProps {
    nns: NodeNetworkState;
    cudns?: ClusterUserDefinedNetwork[];
    udns?: UserDefinedNetwork[];
    nads?: NetworkAttachmentDefinition[];
    routeAdvertisements?: RouteAdvertisements[];
}

const NodeVisualization: React.FC<NodeVisualizationProps> = ({ nns, cudns = [], udns = [], nads = [], routeAdvertisements = [] }) => {
    // Graph Types
    interface AttachmentNode {
        name: string;
        type: string;
        namespaces: string[];
        cudn?: string;
        udnId?: string; // 'namespace-name' for UDN-backed attachments
    }

    type NodeKind = 'interface' | 'ovn-mapping' | 'cudn' | 'udn' | 'attachment' | 'nad' | 'vrf' | 'other';

    interface ResourceRef {
        apiVersion: string;
        kind: string;
        name: string;
        namespace?: string;
    }

    interface NodeLink {
        label: string;
        href: string;
    }

    interface NodeViewModel {
        id: string;
        kind: NodeKind;
        label: string;
        title: string;
        subtitle: string;
        graphDisplayLabel?: string; // Abbreviation for graph node display (e.g., "CUDN", "NAD")
        state?: string;
        namespaces?: string[];
        badges?: string[];
        links?: NodeLink[];
        resourceRef?: ResourceRef;
        isSynthetic?: boolean;
        vrfRoutes?: VrfAssociatedRoute[];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        raw?: any;
    }

    interface NodeKindDefinition {
        label: string;
        buildBadges?: (node: NodeViewModel) => string[];
        buildLinks?: (node: NodeViewModel) => NodeLink[];
        renderDetails?: (node: NodeViewModel) => React.ReactNode;
        tabs?: DrawerTabId[];
    }

    type DrawerTabId = 'summary' | 'details' | 'links' | 'yaml';

    interface DrawerTabDefinition {
        id: DrawerTabId;
        title: string;
        render: (node: NodeViewModel) => React.ReactNode;
    }

    const getResourceLinks = (ref: ResourceRef): NodeLink[] => {
        const resourceId = ref.apiVersion ? `${ref.apiVersion.replace('/', '~')}~${ref.kind}` : ref.kind;
        const base = ref.namespace ? `/k8s/ns/${ref.namespace}` : '/k8s/cluster';
        const resourcePath = `${base}/${resourceId}/${ref.name}`;
        return [
            { label: 'Resource', href: resourcePath },
            { label: 'YAML', href: `${resourcePath}/yaml` }
        ];
    };

    const getNadNodeId = (nad: NetworkAttachmentDefinition) => {
        const name = nad.metadata?.name || 'unknown-nad';
        const namespace = nad.metadata?.namespace || 'default';
        return `nad-${namespace}-${name}`;
    };

    const getUdnNodeId = (udn: UserDefinedNetwork) => {
        const name = udn.metadata?.name || 'unknown-udn';
        const namespace = udn.metadata?.namespace || 'default';
        return `udn-${namespace}-${name}`;
    };

    const getUdnTopologyAndRole = (udn: UserDefinedNetwork): { topology: string; role: string } => {
        // UserDefinedNetworkSpec: topology, layer2, layer3 are at spec level (not spec.network)
        const topology = udn.spec?.topology || 'Unknown';
        const role =
            topology === 'Layer2' ? (udn.spec?.layer2?.role || 'Unknown')
                : topology === 'Layer3' ? (udn.spec?.layer3?.role || 'Unknown')
                    : 'Unknown';
        return { topology, role };
    };

    const getAttachmentNodeId = (node: AttachmentNode) =>
        node.udnId != null ? `attachment-udn-${node.udnId}` : `attachment-${node.cudn}`;

    type NetworkColumnItem = { kind: 'cudn'; item: ClusterUserDefinedNetwork } | { kind: 'udn'; item: UserDefinedNetwork };
    const getNetworkNodeId = (n: NetworkColumnItem) =>
        n.kind === 'cudn' ? `cudn-${n.item.metadata?.name}` : getUdnNodeId(n.item);
    const CUDN_NODE_COLOR = '#CC0099';
    const UDN_NODE_COLOR = '#0084A8';

    const nodeKindRegistry: Record<NodeKind, NodeKindDefinition> = {
        interface: {
            label: 'Interface',
            renderDetails: (node) => {
                const isBridgeNode = node.raw?.type === 'linux-bridge' || node.raw?.type === 'ovs-bridge';
                const rawPorts = node.raw?.bridge?.port || node.raw?.bridge?.ports || node.raw?.ports || [];
                const bridgePorts = Array.isArray(rawPorts)
                    ? rawPorts
                        .map((port: unknown) => {
                            if (typeof port === 'string') return port;
                            if (port && typeof port === 'object' && 'name' in (port as Record<string, unknown>)) {
                                const name = (port as Record<string, unknown>).name;
                                return typeof name === 'string' ? name : '';
                            }
                            return '';
                        })
                        .filter(Boolean)
                    : [];

                return (
                    <DescriptionList isCompact>
                        <DescriptionListGroup>
                            <DescriptionListTerm>Type</DescriptionListTerm>
                            <DescriptionListDescription>{node.subtitle}</DescriptionListDescription>
                        </DescriptionListGroup>
                        {node.state && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>State</DescriptionListTerm>
                                <DescriptionListDescription>{node.state}</DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                        {node.raw?.mac_address && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>MAC Address</DescriptionListTerm>
                                <DescriptionListDescription>{node.raw.mac_address}</DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                        {node.raw?.mtu && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>MTU</DescriptionListTerm>
                                <DescriptionListDescription>{node.raw.mtu}</DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                        {node.raw?.ipv4?.address && node.raw.ipv4.address.length > 0 && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>IPv4</DescriptionListTerm>
                                <DescriptionListDescription>{node.raw.ipv4.address[0].ip}/{node.raw.ipv4.address[0].prefix_length}</DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                        {isBridgeNode && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>Ports</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {bridgePorts.length > 0 ? (
                                        <ul className="pf-v6-c-list">
                                            {bridgePorts.map((portName) => (
                                                <li key={portName}>{portName}</li>
                                            ))}
                                        </ul>
                                    ) : (
                                        <span style={{ color: 'var(--pf-global--Color--200)' }}>No bridge ports reported in NNS.</span>
                                    )}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                    </DescriptionList>
                );
            }
        },
        'ovn-mapping': {
            label: 'OVN Mapping',
            renderDetails: (node) => {
                // Find all CUDNs that reference this bridge mapping
                const localnetName = node.raw?.localnet;
                const referencingCudns = cudns.filter((cudn: ClusterUserDefinedNetwork) => {
                    const physicalNetworkName = cudn.spec?.network?.localNet?.physicalNetworkName || cudn.spec?.network?.localnet?.physicalNetworkName;
                    return physicalNetworkName === localnetName;
                });

                return (
                    <DescriptionList isCompact>
                        {node.raw?.bridge && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>Bridge</DescriptionListTerm>
                                <DescriptionListDescription>{node.raw.bridge}</DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                        {referencingCudns.length > 0 && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>Referenced by CUDNs</DescriptionListTerm>
                                <DescriptionListDescription>
                                    <ul className="pf-v6-c-list">
                                        {referencingCudns.map((cudn: ClusterUserDefinedNetwork) => {
                                            const cudnName = cudn.metadata?.name || 'Unknown';
                                            // Build resource link for CUDN (cluster-scoped resource)
                                            const resourceRef: ResourceRef = {
                                                apiVersion: cudn.apiVersion || 'k8s.ovn.org/v1',
                                                kind: cudn.kind || 'ClusterUserDefinedNetwork',
                                                name: cudnName,
                                                namespace: undefined // CUDN is cluster-scoped
                                            };
                                            const resourceLinks = getResourceLinks(resourceRef);
                                            const resourceLink = resourceLinks.find(link => link.label === 'Resource') || resourceLinks[0];

                                            return (
                                                <li key={cudnName}>
                                                    <a
                                                        href={`${window.location.origin}${resourceLink?.href || '#'}`}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                    >
                                                        {cudnName}
                                                    </a>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                        {referencingCudns.length === 0 && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>Referenced by CUDNs</DescriptionListTerm>
                                <DescriptionListDescription>
                                    <span style={{ color: 'var(--pf-global--Color--200)' }}>No CUDNs reference this bridge mapping</span>
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                    </DescriptionList>
                );
            }
        },
        cudn: {
            label: 'CUDN',
            renderDetails: (node) => {
                const topology = node.raw?.spec?.network?.topology;
                const matchingRAs =
                    (topology === 'Layer2' || topology === 'Layer3')
                        ? getRouteAdvertisementsMatchingCudn(routeAdvertisements, node.raw as ClusterUserDefinedNetwork)
                        : [];
                const associatedNamespaces = getCudnAssociatedNamespaces(node.raw as ClusterUserDefinedNetwork);

                return (
                    <DescriptionList isCompact>
                        <DescriptionListGroup>
                            <DescriptionListTerm>Topology</DescriptionListTerm>
                            <DescriptionListDescription>{topology || 'Unknown'}</DescriptionListDescription>
                        </DescriptionListGroup>

                        {(topology === 'Layer2' || topology === 'Layer3') && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>Subnets</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {(topology === 'Layer2' ? node.raw?.spec?.network?.layer2?.subnets : node.raw?.spec?.network?.layer3?.subnets)?.join(', ') || '-'}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        )}

                        {(node.raw?.spec?.network?.localNet?.vlan?.access?.id || node.raw?.spec?.network?.localnet?.vlan?.access?.id) && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>VLAN ID</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {node.raw?.spec?.network?.localNet?.vlan?.access?.id || node.raw?.spec?.network?.localnet?.vlan?.access?.id}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        )}

                        {node.raw?.spec?.network?.localNet?.physicalNetworkName && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>Physical Network</DescriptionListTerm>
                                <DescriptionListDescription>{node.raw.spec.network.localNet.physicalNetworkName}</DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                        {node.raw?.spec?.network?.localnet?.physicalNetworkName && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>Physical Network</DescriptionListTerm>
                                <DescriptionListDescription>{node.raw.spec.network.localnet.physicalNetworkName}</DescriptionListDescription>
                            </DescriptionListGroup>
                        )}

                        {associatedNamespaces.length > 0 && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>Associated Namespaces</DescriptionListTerm>
                                <DescriptionListDescription>
                                    <ul className="pf-v6-c-list">
                                        {associatedNamespaces.map((ns: string) => (
                                            <li key={ns}>
                                                <a
                                                    href={`/k8s/ns/${ns}/k8s.cni.cncf.io~v1~NetworkAttachmentDefinition/${node.raw.metadata.name}`}
                                                    className="pf-v6-c-button pf-m-link pf-m-inline"
                                                >
                                                    {ns}
                                                </a>
                                            </li>
                                        ))}
                                    </ul>
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        )}

                        {matchingRAs.length > 0 && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>Route Advertisements</DescriptionListTerm>
                                <DescriptionListDescription>
                                    <ul className="pf-v6-c-list">
                                        {matchingRAs.map((ra: RouteAdvertisements) => {
                                            const raName = ra.metadata?.name || 'Unknown';
                                            const resourceRef: ResourceRef = {
                                                apiVersion: ra.apiVersion || 'k8s.ovn.org/v1',
                                                kind: ra.kind || 'RouteAdvertisements',
                                                name: raName,
                                                namespace: undefined // Cluster scoped
                                            };
                                            const resourceLinks = getResourceLinks(resourceRef);
                                            const resourceLink = resourceLinks.find(link => link.label === 'Resource') || resourceLinks[0];

                                            return (
                                                <li key={raName}>
                                                    <a
                                                        href={`${window.location.origin}${resourceLink?.href || '#'}`}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                    >
                                                        {raName}
                                                    </a>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                    </DescriptionList>
                );
            }
        },
        udn: {
            label: 'UDN',
            renderDetails: (node) => {
                const udn = node.raw as UserDefinedNetwork;
                const namespace = udn?.metadata?.namespace || '';
                const { topology, role } = getUdnTopologyAndRole(udn);
                const name = udn?.metadata?.name || '';
                const nadInNs = name && namespace ? nads.find((nad: NetworkAttachmentDefinition) => nad.metadata?.namespace === namespace && nad.metadata?.name === name) : undefined;
                return (
                    <DescriptionList isCompact>
                        <DescriptionListGroup>
                            <DescriptionListTerm>Topology</DescriptionListTerm>
                            <DescriptionListDescription>{topology}</DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                            <DescriptionListTerm>Namespace</DescriptionListTerm>
                            <DescriptionListDescription>
                                <a href={`/k8s/ns/${namespace}`} className="pf-v6-c-button pf-m-link pf-m-inline">{namespace}</a>
                            </DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                            <DescriptionListTerm>Role</DescriptionListTerm>
                            <DescriptionListDescription>{role}</DescriptionListDescription>
                        </DescriptionListGroup>
                        {nadInNs && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>NetworkAttachmentDefinition</DescriptionListTerm>
                                <DescriptionListDescription>
                                    <a
                                        href={`/k8s/ns/${namespace}/k8s.cni.cncf.io~v1~NetworkAttachmentDefinition/${name}`}
                                        className="pf-v6-c-button pf-m-link pf-m-inline"
                                    >
                                        {name}
                                    </a>
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                    </DescriptionList>
                );
            }
        },
        attachment: {
            label: 'Attachment',
            buildBadges: (node) => (node.isSynthetic ? ['synthetic', 'derived'] : [])
        },
        nad: {
            label: 'NAD',
            renderDetails: (node) => {
                const config = parseNadConfig(node.raw?.spec?.config);
                const nadType = typeof config?.type === 'string' ? config.type : 'Unknown';
                const nadName = typeof config?.name === 'string' ? config.name : undefined;
                return (
                    <DescriptionList isCompact>
                        <DescriptionListGroup>
                            <DescriptionListTerm>Type</DescriptionListTerm>
                            <DescriptionListDescription>{nadType}</DescriptionListDescription>
                        </DescriptionListGroup>
                        {nadName && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>Network Name</DescriptionListTerm>
                                <DescriptionListDescription>{nadName}</DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                    </DescriptionList>
                );
            }
        },
        vrf: {
            label: 'VRF',
            renderDetails: (node) => {
                const ra = findRouteAdvertisementForVrf(routeAdvertisements, node.raw.name);
                const matchedCudns = getCudnsSelectedByRouteAdvertisement(ra, cudns);
                const { brIntPorts } = getVrfConnectionInfo(node.raw as Interface, interfaces);

                return (
                    <DescriptionList isCompact>
                        {node.raw?.vrf?.['route-table-id'] && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>Route Table</DescriptionListTerm>
                                <DescriptionListDescription>{node.raw.vrf['route-table-id']}</DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                        <DescriptionListGroup>
                            <DescriptionListTerm>Routes</DescriptionListTerm>
                            <DescriptionListDescription>
                                {node.vrfRoutes && node.vrfRoutes.length > 0 ? (
                                    <ul className="pf-v6-c-list">
                                        {node.vrfRoutes.map((route, index) => (
                                            <li key={`${route.destination}-${route.nextHopAddress || ''}-${route.nextHopInterface || ''}-${index}`}>
                                                {route.destination}
                                                {route.nextHopAddress ? ` via ${route.nextHopAddress}` : ''}
                                                {route.nextHopInterface ? ` dev ${route.nextHopInterface}` : ''}
                                                {route.metric ? ` metric ${route.metric}` : ''}
                                                {route.protocol ? ` proto ${route.protocol}` : ''}
                                            </li>
                                        ))}
                                    </ul>
                                ) : (
                                    <span style={{ color: 'var(--pf-global--Color--200)' }}>No associated routes found in NNS.</span>
                                )}
                            </DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                            <DescriptionListTerm>br-int Ports</DescriptionListTerm>
                            <DescriptionListDescription>
                                {brIntPorts.length > 0 ? (
                                    <ul className="pf-v6-c-list">
                                        {brIntPorts.map((iface) => {
                                            const ipv4Addresses = iface.ipv4?.address || [];
                                            return (
                                                <li key={iface.name}>
                                                    {iface.name}
                                                    {ipv4Addresses.length > 0
                                                        ? ` ${ipv4Addresses
                                                            .map((addr: Record<string, unknown>) => {
                                                                const prefixLength = addr.prefix_length ?? addr['prefix-length'];
                                                                return `${String(addr.ip)}/${String(prefixLength)}`;
                                                            })
                                                            .join(', ')}`
                                                        : ''}
                                                </li>
                                            );
                                        })}
                                    </ul>
                                ) : (
                                    <span style={{ color: 'var(--pf-global--Color--200)' }}>No matching br-int ports inferred from NNS.</span>
                                )}
                            </DescriptionListDescription>
                        </DescriptionListGroup>
                        {ra && (
                            <>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>Route Advertisement</DescriptionListTerm>
                                    <DescriptionListDescription>
                                        <ul className="pf-v6-c-list">
                                            <li>
                                                <a
                                                    href={`/k8s/cluster/k8s.ovn.org~v1~RouteAdvertisements/${ra.metadata?.name}`}
                                                    className="pf-v6-c-button pf-m-link pf-m-inline"
                                                >
                                                    {ra.metadata?.name}
                                                </a>
                                            </li>
                                        </ul>
                                    </DescriptionListDescription>
                                </DescriptionListGroup>
                                {matchedCudns.length > 0 && (
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>Matched CUDNs</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            <ul className="pf-v6-c-list">
                                                {matchedCudns.map(cudn => (
                                                    <li key={cudn.metadata?.name}>
                                                        <a
                                                            href={`/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/${cudn.metadata?.name}`}
                                                            className="pf-v6-c-button pf-m-link pf-m-inline"
                                                        >
                                                            {cudn.metadata?.name}
                                                        </a>
                                                    </li>
                                                ))}
                                            </ul>
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                )}
                            </>
                        )}

                    </DescriptionList >
                );
            }
        },
        other: {
            label: 'Other'
        }
    };

    const DEFAULT_DRAWER_TABS: DrawerTabId[] = ['summary', 'details', 'links', 'yaml'];

    interface GraphNode {
        id: string;
        upstream: string[];
        downstream: string[];
    }

    interface Graph {
        nodes: { [id: string]: GraphNode };
    }

    const history = useHistory();

    // Fetch all NodeNetworkState resources for the dropdown
    const [allNodeNetworkStates] = useK8sWatchResource<NodeNetworkState[]>({
        groupVersionKind: {
            group: 'nmstate.io',
            version: 'v1beta1',
            kind: 'NodeNetworkState',
        },
        isList: true,
    });

    const handleHostSelect = (event: React.FormEvent<HTMLSelectElement>) => {
        const value = (event.target as HTMLSelectElement).value;
        if (value) {
            history.push(`/ovn-recon/node-network-state/${value}`);
        }
    };

    const interfaces: Interface[] = nns?.status?.currentState?.interfaces || [];
    const ovn = nns?.status?.currentState?.ovn;
    const bridgeMappings: OvnBridgeMapping[] = ovn?.['bridge-mappings'] || [];

    // State for toggle
    const [showHiddenColumns, setShowHiddenColumns] = React.useState<boolean>(false);
    const [showNads, setShowNads] = React.useState<boolean>(false);

    // Pan/Zoom state
    const [viewBox, setViewBox] = React.useState<{ x: number; y: number; width: number; height: number } | null>(null);
    const [isPanning, setIsPanning] = React.useState<boolean>(false);
    const [panStart, setPanStart] = React.useState<{ x: number; y: number } | null>(null);
    const [zoomLevel, setZoomLevel] = React.useState<number>(1);
    const svgContainerRef = React.useRef<SVGSVGElement | null>(null);

    // Simple layout logic
    const width = 1600; // Increased width for new columns
    // const height = 800; // Unused
    const padding = 10; // Reduced padding to minimize whitespace
    const itemHeight = 80;
    const itemWidth = 160;
    const colSpacing = 220;

    // Identify controllers
    const controllerNames = new Set(interfaces.map((iface: Interface) => iface.controller || iface.master).filter(Boolean));

    // Group interfaces
    const ethInterfaces = interfaces.filter((iface: Interface) => iface.type === 'ethernet' && iface.state !== 'ignore');
    const bondInterfaces = interfaces.filter((iface: Interface) => iface.type === 'bond');
    const vrfInterfaces = interfaces.filter((iface: Interface) => iface.type === 'vrf');
    const vlanInterfaces = interfaces.filter((iface: Interface) => iface.type === 'vlan' || iface.type === 'mac-vlan'); // Includes mac-vlan

    const explicitBridgeNames = new Set(interfaces.filter(i => ['linux-bridge', 'ovs-bridge', 'openvswitch'].includes(i.type)).map(i => i.name));

    const resolveNodeId = (iface: any, type: string) => {
        if (type === 'ovn-mapping') return `ovn-${iface.localnet}`;
        if (type === 'cudn') return `cudn-${iface.metadata?.name}`;
        if (type === 'udn') return getUdnNodeId(iface);
        if (type === 'attachment') return getAttachmentNodeId(iface);
        if (type === 'nad') return getNadNodeId(iface);
        // Special handling for ovs-interface with same name as a bridge
        if (type === 'ovs-interface' && explicitBridgeNames.has(iface.name)) {
            return `interface-${iface.name}`;
        }
        return iface.name;
    };

    const isBridge = (iface: Interface) => {
        if (['linux-bridge', 'ovs-bridge', 'openvswitch'].includes(iface.type)) return true;

        // ovs-interface is a bridge if it is a controller AND does NOT have a patch
        if (iface.type === 'ovs-interface' && controllerNames.has(iface.name) && !iface.patch && iface.state !== 'ignore') {
            // CRITICAL: If there is an explicit bridge with this name, this ovs-interface is NOT the bridge.
            // It is the internal interface of the bridge.
            if (explicitBridgeNames.has(iface.name)) return false;
            return true;
        }
        return false;
    };

    const bridgeInterfaces = interfaces.filter(isBridge);

    // Logical interfaces: ovs-interface that are NOT bridges and NOT ignored
    const logicalInterfaces = interfaces.filter((iface: Interface) => {
        if (iface.type !== 'ovs-interface') return false;
        if (iface.state === 'ignore') return false;
        if (iface.name.startsWith('patch')) return false;

        // Condition 1: It is NOT considered a bridge
        if (!isBridge(iface)) return true;

        // Condition 2: It MIGHT be considered a bridge by heuristic, BUT we want to forcefully include it
        // if it shadows an explicit bridge.
        if (explicitBridgeNames.has(iface.name)) return true;

        return false;
    });

    const otherInterfaces = interfaces.filter((iface: Interface) => !['ethernet', 'bond', 'vlan', 'mac-vlan', 'vrf'].includes(iface.type) && !isBridge(iface) && iface.type !== 'ovs-interface');

    // Define columns with their data
    const networkItems: NetworkColumnItem[] = [...cudns.map((c): NetworkColumnItem => ({ kind: 'cudn', item: c })), ...udns.map((u): NetworkColumnItem => ({ kind: 'udn', item: u }))];
    const columns = [
        { name: 'Physical Interfaces', data: ethInterfaces, key: 'eth' },
        { name: 'Bonds', data: bondInterfaces, key: 'bond' },
        { name: 'VLAN Interfaces', data: vlanInterfaces, key: 'vlan' },
        { name: 'Bridges', data: bridgeInterfaces, key: 'bridge' },
        { name: 'Logical Interfaces', data: logicalInterfaces, key: 'logical' },
        { name: 'Layer 3', data: [...bridgeMappings, ...vrfInterfaces], key: 'l3' },
        { name: 'Networks', data: networkItems, key: 'cudn' },
    ];

    // Filter columns based on showHiddenColumns
    const visibleColumns = showHiddenColumns ? columns : columns.filter(col => col.data.length > 0 && col.key !== 'logical');

    // Attachments (from CUDN status + one per UDN for controller-created NAD)
    const attachmentNodes: AttachmentNode[] = [];
    cudns.forEach((cudn: ClusterUserDefinedNetwork) => {
        const namespaces = getCudnAssociatedNamespaces(cudn);
        if (namespaces.length > 0) {
            attachmentNodes.push({
                name: cudn.metadata?.name || '',
                type: 'attachment',
                namespaces,
                cudn: cudn.metadata?.name || ''
            });
        }
    });
    udns.forEach((udn: UserDefinedNetwork) => {
        const ns = udn.metadata?.namespace || 'default';
        const name = udn.metadata?.name || '';
        if (name) {
            attachmentNodes.push({
                name,
                type: 'attachment',
                namespaces: [ns],
                udnId: `${ns}-${name}`
            });
        }
    });

    const topologyEdges = buildTopologyEdges({
        interfaces,
        vrfInterfaces,
        bridgeMappings,
        cudns,
        udns,
        attachmentNodes,
        nads,
        routeAdvertisements,
        showNads,
        resolveNodeId,
        getAttachmentNodeId,
        getUdnNodeId,
        getNadNodeId
    });

    const gravityById = computeGravityById({
        topologyEdges,
        interfaces,
        physicalNodeIds: new Set([
            ...ethInterfaces.map((i) => i.name),
            ...bondInterfaces.map((i) => i.name),
            ...vrfInterfaces.map((i) => i.name),
            ...vlanInterfaces.map((i) => i.name),
            ...bridgeInterfaces.map((i) => i.name)
        ]),
        importantNodes: new Set<string>(['br-ex'])
    });

    const sortedEthInterfaces = sortByGravity(ethInterfaces, (iface) => iface.name, gravityById);
    const sortedBondInterfaces = sortByGravity(bondInterfaces, (iface) => iface.name, gravityById);
    const sortedVrfInterfaces = sortByGravity(vrfInterfaces, (iface) => iface.name, gravityById);
    const sortedVlanInterfaces = sortByGravity(vlanInterfaces, (iface) => iface.name, gravityById);
    const sortedBridgeInterfaces = sortByGravity(bridgeInterfaces, (iface) => iface.name, gravityById);
    const sortedLogicalInterfaces = sortByGravity(logicalInterfaces, (iface) => iface.name, gravityById);
    const sortedBridgeMappings = sortByGravity(bridgeMappings, (mapping) => `ovn-${mapping.localnet || ''}`, gravityById);
    const sortedCudns = sortByGravity(cudns, (cudn) => `cudn-${cudn.metadata?.name || ''}`, gravityById);
    const sortedNetworkItems = sortByGravity(networkItems, getNetworkNodeId, gravityById);
    const sortedAttachmentNodes = sortByGravity(attachmentNodes, getAttachmentNodeId, gravityById);
    const sortedNads = sortByGravity(nads, (nad) => getNadNodeId(nad), gravityById);
    const sortedOtherInterfaces = sortByGravity(otherInterfaces, (iface) => iface.name, gravityById);

    // Calculate positions with dynamic column visibility
    const nodePositions: { [name: string]: { x: number, y: number } } = {};

    // Position nodes based on visible columns
    // const currentColIndex = 0; // Unused

    if (showHiddenColumns || ethInterfaces.length > 0) {
        const colOffset = visibleColumns.findIndex(col => col.key === 'eth');
        if (colOffset >= 0) {
            // Defensive guard: avoid assigning off-canvas positions for hidden columns.
            // Hidden columns previously produced x<0 nodes and phantom connectors.
            sortedEthInterfaces.forEach((iface: Interface, index: number) => {
                nodePositions[resolveNodeId(iface, iface.type)] = { x: padding + (colOffset * colSpacing), y: padding + (index * (itemHeight + 20)) };
            });
        }
    }

    if (showHiddenColumns || bondInterfaces.length > 0) {
        const colOffset = visibleColumns.findIndex(col => col.key === 'bond');
        if (colOffset >= 0) {
            sortedBondInterfaces.forEach((iface: Interface, index: number) => {
                nodePositions[resolveNodeId(iface, iface.type)] = { x: padding + (colOffset * colSpacing), y: padding + (index * (itemHeight + 20)) };
            });
        }
    }



    if (showHiddenColumns || vlanInterfaces.length > 0) {
        const colOffset = visibleColumns.findIndex(col => col.key === 'vlan');
        if (colOffset >= 0) {
            sortedVlanInterfaces.forEach((iface: Interface, index: number) => {
                nodePositions[resolveNodeId(iface, iface.type)] = { x: padding + (colOffset * colSpacing), y: padding + (index * (itemHeight + 20)) };
            });
        }
    }

    if (showHiddenColumns || bridgeInterfaces.length > 0) {
        const colOffset = visibleColumns.findIndex(col => col.key === 'bridge');
        if (colOffset >= 0) {
            sortedBridgeInterfaces.forEach((iface: Interface, index: number) => {
                nodePositions[resolveNodeId(iface, iface.type)] = { x: padding + (colOffset * colSpacing), y: padding + (index * (itemHeight + 20)) };
            });
        }
    }

    if (showHiddenColumns || logicalInterfaces.length > 0) {
        const colOffset = visibleColumns.findIndex(col => col.key === 'logical');
        if (colOffset >= 0) {
            sortedLogicalInterfaces.forEach((iface: Interface, index: number) => {
                nodePositions[resolveNodeId(iface, iface.type)] = { x: padding + (colOffset * colSpacing), y: padding + (index * (itemHeight + 20)) };
            });
        }
    }

    // Combine Bridge Mappings and VRFs in 'l3' column
    if (showHiddenColumns || bridgeMappings.length > 0 || vrfInterfaces.length > 0) {
        const colOffset = visibleColumns.findIndex(col => col.key === 'l3');
        if (colOffset >= 0) {
            let currentY = padding;

            // Stack Bridge Mappings first
            sortedBridgeMappings.forEach((mapping: OvnBridgeMapping) => {
                nodePositions[`ovn-${mapping.localnet}`] = { x: padding + (colOffset * colSpacing), y: currentY };
                currentY += (itemHeight + 20);
            });

            // Add gap for VRF header if we have VRFs
            if (sortedVrfInterfaces.length > 0) {
                // If we had bridge mappings, add a bit more space for the header
                if (sortedBridgeMappings.length > 0) {
                    currentY += 40; // Extra gap for header
                }
            }

            // Stack VRFs below
            sortedVrfInterfaces.forEach((iface: Interface) => {
                nodePositions[resolveNodeId(iface, iface.type)] = { x: padding + (colOffset * colSpacing), y: currentY };
                currentY += (itemHeight + 20);
            });
        }
    }

    if (showHiddenColumns || networkItems.length > 0) {
        const colOffset = visibleColumns.findIndex(col => col.key === 'cudn');
        if (colOffset >= 0) {
            sortedNetworkItems.forEach((n: NetworkColumnItem, index: number) => {
                nodePositions[getNetworkNodeId(n)] = { x: padding + (colOffset * colSpacing), y: padding + (index * (itemHeight + 20)) };
            });
        }
    }

    // Helper to calculate attachment node height
    const getAttachmentHeight = (node: AttachmentNode) => {
        const nsString = node.namespaces.join(', ');
        const charsPerLine = 25; // Approximate characters per line
        const lines = Math.ceil(nsString.length / charsPerLine);
        // Base height (60px for icon/title) + text height (approx 12px per line) + padding
        return Math.max(itemHeight, 60 + (lines * 12) + 10);
    };

    // Build Graph
    const graph = React.useMemo(() => {
        const g: Graph = { nodes: {} };
        const addNode = (id: string) => {
            if (!g.nodes[id]) g.nodes[id] = { id, upstream: [], downstream: [] };
        };
        const addEdge = (source: string, target: string) => {
            addNode(source);
            addNode(target);
            if (!g.nodes[source].downstream.includes(target)) g.nodes[source].downstream.push(target);
            if (!g.nodes[target].upstream.includes(source)) g.nodes[target].upstream.push(source);
        };

        topologyEdges.forEach((edge) => addEdge(edge.source, edge.target));

        return g;
    }, [topologyEdges]);

    // Path Traversal
    const [highlightedPath, setHighlightedPath] = React.useState<Set<string>>(new Set());
    const [isHighlightActive, setIsHighlightActive] = React.useState<boolean>(false);

    const getFlowPath = (startNodeId: string) => {
        const path = new Set<string>();
        const visited = new Set<string>();

        const traverse = (nodeId: string, direction: 'upstream' | 'downstream') => {
            if (visited.has(nodeId)) return;
            visited.add(nodeId);
            path.add(nodeId);

            const node = graph.nodes[nodeId];
            if (!node) return;

            const nextNodes = direction === 'upstream' ? node.upstream : node.downstream;
            nextNodes.forEach(nextId => {
                path.add(`${nodeId}-${nextId}`); // Add Edge ID (source-target)
                path.add(`${nextId}-${nodeId}`); // Add Edge ID (reverse for safety)
                traverse(nextId, direction);
            });
        };

        traverse(startNodeId, 'upstream');
        visited.clear(); // Reset visited for downstream traversal (allow overlap)
        traverse(startNodeId, 'downstream');

        return path;
    };

    // Attachments positions with dynamic spacing
    let currentAttachmentY = padding;
    const attachmentColOffset = visibleColumns.length; // Attachments always after visible columns
    sortedAttachmentNodes.forEach((node: AttachmentNode) => {
        const height = getAttachmentHeight(node);
        nodePositions[getAttachmentNodeId(node)] = { x: padding + (attachmentColOffset * colSpacing), y: currentAttachmentY };
        currentAttachmentY += height + 20; // Add gap
    });

    const nadColOffset = attachmentColOffset + 1; // NADs render to the right of Attachments
    if (showNads && (showHiddenColumns || nads.length > 0)) {
        sortedNads.forEach((nad: NetworkAttachmentDefinition, index: number) => {
            nodePositions[getNadNodeId(nad)] = { x: padding + (nadColOffset * colSpacing), y: padding + (index * (itemHeight + 20)) };
        });
    }

    // Dynamic height calculation
    const maxRows = Math.max(
        ethInterfaces.length,
        bondInterfaces.length,
        bridgeInterfaces.length,
        logicalInterfaces.length,
        bridgeMappings.length,
        vrfInterfaces.length,
        networkItems.length,
        showNads ? nads.length : 0,
        Math.ceil(otherInterfaces.length / 4) + 2
    );
    // Use currentAttachmentY for attachment column height
    const calculatedHeight = Math.max(600, padding + (maxRows * (itemHeight + 20)) + 200, currentAttachmentY + 100);

    // Initialize viewBox after calculatedHeight is computed
    React.useEffect(() => {
        if (!viewBox && calculatedHeight > 0) {
            setViewBox({ x: 0, y: 0, width, height: calculatedHeight });
            setZoomLevel(1);
        }
    }, [calculatedHeight, width]);

    const getIcon = (type: string) => {
        switch (type) {
            case 'ethernet': return <ResourcePoolIcon />;
            case 'bond': return <PficonVcenterIcon />;
            case 'linux-bridge': return <LinuxIcon />;
            case 'ovs-bridge': return <InfrastructureIcon />;
            case 'ovs-interface': return <NetworkIcon />; // Logical
            case 'ovn-mapping': return <RouteIcon />;
            case 'vrf': return <InfrastructureIcon />;
            case 'cudn': return <NetworkIcon />;
            case 'udn': return <NetworkIcon />;
            case 'attachment': return <MigrationIcon />;
            case 'vlan': return <TagIcon />;
            case 'mac-vlan': return <TagIcon />;
            case 'nad': return <RouteIcon />;
            default: return <NetworkIcon />;
        }
    };

    const renderConnector = (startNode: string, endNode: string) => {
        const start = nodePositions[startNode];
        const end = nodePositions[endNode];

        if (!start || !end) return null;

        const x1 = start.x + itemWidth;
        const y1 = start.y + (itemHeight / 2);
        const x2 = end.x;
        const y2 = end.y + (itemHeight / 2);

        return (
            <line
                key={`${startNode}-${endNode}`}
                x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={isHighlightActive ? (highlightedPath.has(`${startNode}-${endNode}`) || highlightedPath.has(`${endNode}-${startNode}`) ? '#0066CC' : '#ccc') : 'currentColor'}
                strokeWidth={isHighlightActive ? (highlightedPath.has(`${startNode}-${endNode}`) || highlightedPath.has(`${endNode}-${startNode}`) ? 4 : 1) : 2}
                opacity={isHighlightActive ? (highlightedPath.has(`${startNode}-${endNode}`) || highlightedPath.has(`${endNode}-${startNode}`) ? 1 : 0.1) : 1}
            />
        );
    };


    // Pan/Zoom handlers
    const handleZoom = (delta: number, clientX?: number, clientY?: number) => {
        if (!viewBox || !svgContainerRef.current) return;

        const svgRect = svgContainerRef.current.getBoundingClientRect();
        const zoomFactor = delta > 0 ? 1.1 : 0.9;
        const newZoom = Math.max(0.1, Math.min(5, zoomLevel * zoomFactor));

        if (clientX !== undefined && clientY !== undefined) {
            // Zoom towards mouse position
            const mouseX = clientX - svgRect.left;
            const mouseY = clientY - svgRect.top;
            const svgWidth = svgRect.width;
            const svgHeight = svgRect.height;

            const mouseXPercent = mouseX / svgWidth;
            const mouseYPercent = mouseY / svgHeight;

            const newWidth = width / newZoom;
            const newHeight = calculatedHeight / newZoom;

            const newX = viewBox.x + (mouseXPercent * viewBox.width) - (mouseXPercent * newWidth);
            const newY = viewBox.y + (mouseYPercent * viewBox.height) - (mouseYPercent * newHeight);

            setViewBox({ x: newX, y: newY, width: newWidth, height: newHeight });
        } else {
            // Zoom towards center
            const newWidth = width / newZoom;
            const newHeight = calculatedHeight / newZoom;
            const newX = viewBox.x + (viewBox.width - newWidth) / 2;
            const newY = viewBox.y + (viewBox.height - newHeight) / 2;

            setViewBox({ x: newX, y: newY, width: newWidth, height: newHeight });
        }

        setZoomLevel(newZoom);
    };

    const handleWheel = (event: React.WheelEvent<SVGSVGElement>) => {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
            // Zoom with Ctrl/Cmd + wheel
            handleZoom(-event.deltaY, event.clientX, event.clientY);
        }
    };

    const handleMouseDown = (event: React.MouseEvent<SVGSVGElement>) => {
        // Don't pan if clicking on a node (g element)
        const target = event.target as HTMLElement;
        if (target && (target.tagName === 'g' || target.closest('g'))) {
            return; // Let node click handler deal with it
        }

        // Only pan with middle mouse button or shift + left click
        if (event.button === 1 || (event.button === 0 && event.shiftKey)) {
            event.preventDefault();
            setIsPanning(true);
            setPanStart({ x: event.clientX, y: event.clientY });
        }
    };

    const handleMouseMove = (event: React.MouseEvent<SVGSVGElement>) => {
        if (isPanning && panStart && viewBox) {
            const deltaX = event.clientX - panStart.x;
            const deltaY = event.clientY - panStart.y;

            if (svgContainerRef.current) {
                const svgRect = svgContainerRef.current.getBoundingClientRect();
                const scaleX = viewBox.width / svgRect.width;
                const scaleY = viewBox.height / svgRect.height;

                setViewBox({
                    x: viewBox.x - (deltaX * scaleX),
                    y: viewBox.y - (deltaY * scaleY),
                    width: viewBox.width,
                    height: viewBox.height
                });
            }

            setPanStart({ x: event.clientX, y: event.clientY });
        }
    };

    const handleMouseUp = () => {
        setIsPanning(false);
        setPanStart(null);
    };

    const handleZoomIn = () => handleZoom(1);
    const handleZoomOut = () => handleZoom(-1);
    const handleResetZoom = () => {
        setViewBox({ x: 0, y: 0, width, height: calculatedHeight });
        setZoomLevel(1);
    };

    // State for Popover
    const [activeNode, setActiveNode] = React.useState<NodeViewModel | null>(null);
    const [anchorElement, setAnchorElement] = React.useState<HTMLElement | null>(null);
    const [activePopoverTab, setActivePopoverTab] = React.useState<DrawerTabId>('summary');

    const handleNodeClick = (event: React.MouseEvent, node: NodeViewModel) => {
        event.stopPropagation(); // Prevent clearing highlight when clicking a node
        setAnchorElement(event.currentTarget as HTMLElement);

        const wasDrawerOpen = activeNode !== null;

        setActiveNode(node);

        if (!wasDrawerOpen) {
            setActivePopoverTab(getDrawerTabsForNode(node)[0]?.id || 'summary');
        }

        // Highlight Path
        const path = getFlowPath(node.id);
        setHighlightedPath(path);
        setIsHighlightActive(true);
    };

    const handleBackgroundClick = () => {
        setIsHighlightActive(false);
        setHighlightedPath(new Set());
        handlePopoverClose();
    };

    const handlePopoverClose = () => {
        setActiveNode(null);
        setAnchorElement(null);
    };



    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buildNodeViewModel = (iface: any, type: string): NodeViewModel => {
        const nodeId = resolveNodeId(iface, type);
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
            vrfRoutes = getVrfRoutesForInterface(iface as Interface, nns);
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
        }

        const baseNode: NodeViewModel = {
            id: nodeId,
            kind,
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
            baseNode.links = definition.buildLinks(baseNode);
        }

        return baseNode;
    };

    const drawerTabsById: Record<DrawerTabId, DrawerTabDefinition> = {
        summary: {
            id: 'summary',
            title: 'Summary',
            render: (node) => (
                <div style={{ padding: '16px', overflow: 'auto', flex: 1 }}>
                    <DescriptionList isCompact>
                        <DescriptionListGroup>
                            <DescriptionListTerm>Type</DescriptionListTerm>
                            <DescriptionListDescription>{node.subtitle}</DescriptionListDescription>
                        </DescriptionListGroup>
                        {(() => {
                            let cudnValue: string | null = null;
                            if (node.kind === 'cudn') {
                                cudnValue = node.label || null;
                            } else if (node.kind === 'vrf') {
                                const ra = findRouteAdvertisementForVrf(routeAdvertisements, node.raw?.name || '');
                                const matchedCudnNames = getCudnsSelectedByRouteAdvertisement(ra, cudns)
                                    .map((cudn) => cudn.metadata?.name)
                                    .filter(Boolean)
                                    .join(', ');
                                cudnValue = matchedCudnNames || 'N/A';
                            } else {
                                const badgeCudn = node.badges?.find((badge) => badge.startsWith('CUDN:'))?.split(':')[1];
                                cudnValue = badgeCudn || null;
                            }

                            return cudnValue ? (
                                <DescriptionListGroup>
                                    <DescriptionListTerm>CUDN</DescriptionListTerm>
                                    <DescriptionListDescription>{cudnValue}</DescriptionListDescription>
                                </DescriptionListGroup>
                            ) : null;
                        })()}
                        {node.state && node.kind !== 'vrf' && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>State</DescriptionListTerm>
                                <DescriptionListDescription>{node.state}</DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                        {node.kind === 'interface' && node.raw && node.raw.type === 'vlan' && node.raw.vlan && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>Localnet VLAN {node.raw.vlan.id}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    Base: {node.raw.vlan['base-iface']} <br />
                                    ID: {node.raw.vlan.id}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                    </DescriptionList>
                </div>
            )
        },
        details: {
            id: 'details',
            title: 'Details',
            render: (node) => (
                <div style={{ padding: '16px', overflow: 'auto', flex: 1 }}>
                    {nodeKindRegistry[node.kind]?.renderDetails?.(node) || (
                        <DescriptionList isCompact>
                            <DescriptionListGroup>
                                <DescriptionListTerm>No details available</DescriptionListTerm>
                            </DescriptionListGroup>
                        </DescriptionList>
                    )}
                </div>
            )
        },
        links: {
            id: 'links',
            title: 'Links',
            render: (node) => (
                <div style={{ padding: '16px', overflow: 'auto', flex: 1 }}>
                    {node.links && node.links.length > 0 ? (
                        <DescriptionList isCompact>
                            <DescriptionListGroup>
                                <DescriptionListTerm>Available Links</DescriptionListTerm>
                                <DescriptionListDescription>
                                    <ul className="pf-v6-c-list">
                                        {node.links.map((link) => (
                                            <li key={link.href}>
                                                <a href={link.href} target="_blank" rel="noopener noreferrer">
                                                    {link.label}
                                                </a>
                                            </li>
                                        ))}
                                    </ul>
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        </DescriptionList>
                    ) : (
                        <div style={{ color: 'var(--pf-global--Color--200)' }}>No links available.</div>
                    )}
                </div>
            )
        },
        yaml: {
            id: 'yaml',
            title: 'YAML',
            render: (node) => (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                    {node.raw && (
                        <>
                            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', borderBottom: '1px solid var(--pf-global--BorderColor--100)' }}>
                                <CodeEditor
                                    isDarkTheme
                                    isLineNumbersVisible
                                    isReadOnly
                                    code={yaml.dump(node.raw)}
                                    language={Language.yaml}
                                    height="100%"
                                    style={{ height: '100%' }}
                                />
                            </div>
                            <div style={{ flex: '0 0 auto', padding: 'var(--pf-global--spacer--md)', backgroundColor: 'var(--pf-global--BackgroundColor--100)' }}>
                                <ExternalLinkAltIcon style={{ marginRight: 'var(--pf-global--spacer--sm)' }} />
                                <a
                                    href={(() => {
                                        if (node.resourceRef) {
                                            const resourceId = node.resourceRef.apiVersion
                                                ? `${node.resourceRef.apiVersion.replace('/', '~')}~${node.resourceRef.kind}`
                                                : node.resourceRef.kind;
                                            const base = node.resourceRef.namespace
                                                ? `/k8s/ns/${node.resourceRef.namespace}`
                                                : '/k8s/cluster';
                                            return `${window.location.origin}${base}/${resourceId}/${node.resourceRef.name}/yaml`;
                                        }
                                        const namespace = node.raw?.metadata?.namespace;
                                        const resourceId = node.kind === 'other' || node.kind === 'interface' || node.kind === 'ovn-mapping'
                                            ? 'nodenetworkstates.nmstate.io'
                                            : 'clusteruserdefinednetworks.k8s.cni.cncf.io';
                                        const base = namespace ? `/k8s/ns/${namespace}` : '/k8s/cluster';
                                        return `${window.location.origin}${base}/${resourceId}/${node.raw.metadata?.name}/yaml`;
                                    })()}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    View Resource in Console
                                </a>
                            </div>
                        </>
                    )}
                    {!node.raw && (
                        <span style={{ fontSize: '0.9em', color: 'var(--pf-global--Color--200)', padding: '16px' }}>No YAML content available.</span>
                    )}
                </div>
            )
        }
    };

    const getDrawerTabsForNode = (node: NodeViewModel): DrawerTabDefinition[] => {
        const configuredTabs = nodeKindRegistry[node.kind]?.tabs || DEFAULT_DRAWER_TABS;
        return configuredTabs.map((tabId) => drawerTabsById[tabId]);
    };

    const activeNodeTabs = React.useMemo(
        () => (activeNode ? getDrawerTabsForNode(activeNode) : []),
        [activeNode]
    );

    React.useEffect(() => {
        if (!activeNode || activeNodeTabs.length === 0) {
            return;
        }
        if (!activeNodeTabs.some((tab) => tab.id === activePopoverTab)) {
            setActivePopoverTab(activeNodeTabs[0].id);
        }
    }, [activeNode, activeNodeTabs, activePopoverTab]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const renderInterfaceNode = (iface: any, x: number, y: number, color: string, typeOverride?: string, heightOverride?: number) => {
        const type = typeOverride || iface.type;
        const Icon = getIcon(type);
        const viewNode = buildNodeViewModel(iface, type);
        const displayName = viewNode.label;
        const displayType = viewNode.graphDisplayLabel || viewNode.subtitle; // Use abbreviation for graph, verbose for drawer
        const displayState = viewNode.state;
        let extraInfo = null;
        const nodeHeight = heightOverride || itemHeight;

        if (type === 'ovn-mapping') {
            // Already handled in buildNodeViewModel.
        } else if (type === 'cudn') {
            // Already handled in buildNodeViewModel.
        } else if (type === 'attachment') {
            extraInfo = (
                <foreignObject x={10} y={60} width={itemWidth - 20} height={nodeHeight - 70}>
                    <div style={{ fontSize: '10px', color: '#eee', wordWrap: 'break-word', lineHeight: '1.2' }}>
                        {viewNode.namespaces?.join(', ') || ''}
                    </div>
                </foreignObject>
            );
        }

        return (
            <g
                transform={`translate(${x}, ${y})`}
                style={{ cursor: 'pointer', opacity: isHighlightActive ? (highlightedPath.has(viewNode.id) ? 1 : 0.3) : 1 }}
                onClick={(e) => handleNodeClick(e, viewNode)}
            >
                <title>{displayName} ({displayType})</title>
                <rect width={itemWidth} height={nodeHeight} rx={5} fill={color} stroke="var(--pf-global--BorderColor--100)" strokeWidth={1} />
                <foreignObject x={10} y={10} width={20} height={20}>
                    <div style={{ color: '#fff' }}>{Icon}</div>
                </foreignObject>
                <text x={35} y={25} fontSize="12" fontWeight="bold" fill="#fff">{displayName}</text>
                <text x={10} y={45} fontSize="10" fill="#eee">{displayType}</text>
                {type !== 'attachment' && displayState && <text x={10} y={60} fontSize="10" fill="#eee">{displayState}</text>}
                {extraInfo}
                {type !== 'ovn-mapping' && type !== 'cudn' && type !== 'udn' && type !== 'attachment' && (
                    <circle cx={itemWidth - 15} cy={15} r={5} fill={iface.state === 'up' ? '#4CAF50' : '#F44336'} />
                )}
            </g>
        );
    };

    if (interfaces.length === 0) {
        return (
            <Card isFullHeight>
                <CardTitle>OVN Recon - Network Topology</CardTitle>
                <CardBody>
                    No interfaces found in NodeNetworkState status.
                </CardBody>
            </Card>
        );
    }

    const panelContent = (
        <DrawerPanelContent isResizable widths={{ default: 'width_33' }}>
            <DrawerHead>
                <Flex direction={{ default: 'column' }}>
                    <FlexItem>
                        <Title headingLevel="h2" size="xl">
                            {activeNode?.title}
                        </Title>
                    </FlexItem>
                    <FlexItem>
                        {activeNode?.subtitle && <span style={{ color: 'var(--pf-global--Color--200)', fontSize: '0.9em' }}>{activeNode.subtitle}</span>}
                    </FlexItem>
                </Flex>
                <DrawerActions>
                    <DrawerCloseButton onClick={handlePopoverClose} />
                </DrawerActions>
            </DrawerHead>
            {activeNode && (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
                    <div style={{ flex: '0 0 auto', zIndex: 10, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.1)' }}>
                        <Tabs
                            activeKey={activePopoverTab}
                            onSelect={(_event, key) => {
                                if (typeof key === 'string') {
                                    setActivePopoverTab(key as DrawerTabId);
                                }
                            }}
                            isFilled
                            className="node-details-tabs"
                        >
                            {activeNodeTabs.map((tab) => (
                                <Tab key={tab.id} eventKey={tab.id} title={<TabTitleText>{tab.title}</TabTitleText>} />
                            ))}
                        </Tabs>
                    </div>
                    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                        {activeNodeTabs.find((tab) => tab.id === activePopoverTab)?.render(activeNode)}
                    </div>
                </div>
            )}
        </DrawerPanelContent>
    );

    return (
        <Card isFullHeight>
            <CardTitle>OVN Recon - Network Topology</CardTitle>
            <CardBody style={{ padding: 0, overflow: 'hidden', position: 'relative' }}>
                <Drawer isExpanded={!!activeNode}>
                    <DrawerContent panelContent={activeNode ? panelContent : null}>
                        <DrawerContentBody style={{ padding: '12px 24px', overflow: 'auto' }}>
                            <Flex style={{ marginBottom: '16px', alignItems: 'center', gap: '16px' }}>
                                <FlexItem>
                                    <FormSelect
                                        value={nns?.metadata?.name || ''}
                                        onChange={handleHostSelect}
                                        aria-label="Host selector"
                                        style={{ minWidth: '200px' }}
                                    >
                                        <FormSelectOption key="placeholder" value="" label="Select host" isPlaceholder />
                                        {allNodeNetworkStates
                                            ?.slice()
                                            .sort((a: NodeNetworkState, b: NodeNetworkState) => {
                                                const nameA = a.metadata?.name || '';
                                                const nameB = b.metadata?.name || '';
                                                return nameA.localeCompare(nameB);
                                            })
                                            .map((nnsItem: NodeNetworkState) => (
                                                <FormSelectOption key={nnsItem.metadata?.name} value={nnsItem.metadata?.name || ''} label={nnsItem.metadata?.name || 'Unknown'} />
                                            ))}
                                    </FormSelect>
                                </FlexItem>
                                <FlexItem>
                                    <Switch
                                        id="show-nads-toggle"
                                        label="Show Net Attach Defs"
                                        isChecked={showNads}
                                        onChange={(event, checked) => setShowNads(checked)}
                                    />
                                </FlexItem>
                                <FlexItem>
                                    <Switch
                                        id="show-hidden-columns-toggle"
                                        label="Show hidden columns"
                                        isChecked={showHiddenColumns}
                                        onChange={(event, checked) => setShowHiddenColumns(checked)}
                                    />
                                </FlexItem>
                            </Flex>
                            <svg
                                ref={svgContainerRef}
                                width="100%"
                                height={calculatedHeight}
                                viewBox={viewBox ? `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}` : `0 0 ${width} ${calculatedHeight}`}
                                style={{
                                    border: '1px solid var(--pf-global--BorderColor--100)',
                                    background: 'var(--pf-global--BackgroundColor--200)',
                                    color: 'var(--pf-global--Color--100)',
                                    cursor: isPanning ? 'grabbing' : 'grab'
                                }}
                                onWheel={handleWheel}
                                onMouseDown={handleMouseDown}
                                onMouseMove={handleMouseMove}
                                onMouseUp={handleMouseUp}
                                onMouseLeave={handleMouseUp}
                                onClick={handleBackgroundClick}
                            >
                                {/* Connectors */}
                                {topologyEdges.map((edge: TopologyEdge) => {
                                    const renderSourceId = nodePositions[edge.source]
                                        ? edge.source
                                        : !edge.source.startsWith('ovn-') && nodePositions[`interface-${edge.source}`]
                                            ? `interface-${edge.source}`
                                            : null;
                                    const renderTargetId = nodePositions[edge.target]
                                        ? edge.target
                                        : !edge.target.startsWith('ovn-') && nodePositions[`interface-${edge.target}`]
                                            ? `interface-${edge.target}`
                                            : null;

                                    if (!renderSourceId || !renderTargetId) {
                                        return null;
                                    }

                                    return (
                                        <React.Fragment key={`edge-${edge.source}-${edge.target}`}>
                                            {renderConnector(renderSourceId, renderTargetId)}
                                        </React.Fragment>
                                    );
                                })}

                                {/* Render visible columns dynamically */}
                                {visibleColumns.map((col, idx) => {
                                    const xPos = padding + (idx * colSpacing);
                                    return (
                                        <React.Fragment key={col.key}>
                                            {col.key !== 'l3' && <text x={xPos} y={padding - 10} fontWeight="bold" fill="currentColor">{col.name}</text>}
                                            {col.key === 'eth' && sortedEthInterfaces
                                                .filter((iface: Interface) => nodePositions[resolveNodeId(iface, iface.type)])
                                                .map((iface: Interface, renderIndex: number) => {
                                                    const pos = nodePositions[resolveNodeId(iface, iface.type)];
                                                    return renderInterfaceNode(iface, pos.x, padding + (renderIndex * (itemHeight + 20)), '#0066CC');
                                                })}
                                            {col.key === 'bond' && sortedBondInterfaces
                                                .filter((iface: Interface) => nodePositions[resolveNodeId(iface, iface.type)])
                                                .map((iface: Interface, renderIndex: number) => {
                                                    const pos = nodePositions[resolveNodeId(iface, iface.type)];
                                                    return renderInterfaceNode(iface, pos.x, padding + (renderIndex * (itemHeight + 20)), '#663399');
                                                })}
                                            {col.key === 'vlan' && sortedVlanInterfaces
                                                .filter((iface: Interface) => nodePositions[resolveNodeId(iface, iface.type)])
                                                .map((iface: Interface, renderIndex: number) => {
                                                    const pos = nodePositions[resolveNodeId(iface, iface.type)];
                                                    return renderInterfaceNode(iface, pos.x, padding + (renderIndex * (itemHeight + 20)), '#9933CC');
                                                })}
                                            {col.key === 'bridge' && sortedBridgeInterfaces
                                                .filter((iface: Interface) => nodePositions[resolveNodeId(iface, iface.type)])
                                                .map((iface: Interface, renderIndex: number) => {
                                                    const pos = nodePositions[resolveNodeId(iface, iface.type)];
                                                    // Recalculate Y position based on render index to eliminate gaps
                                                    return renderInterfaceNode(iface, pos.x, padding + (renderIndex * (itemHeight + 20)), '#FF6600');
                                                })}
                                            {col.key === 'logical' && sortedLogicalInterfaces
                                                .filter((iface: Interface) => nodePositions[resolveNodeId(iface, iface.type)])
                                                .map((iface: Interface, renderIndex: number) => {
                                                    const pos = nodePositions[resolveNodeId(iface, iface.type)];
                                                    return renderInterfaceNode(iface, pos.x, padding + (renderIndex * (itemHeight + 20)), '#0099CC');
                                                })}
                                            {col.key === 'l3' && (
                                                <>
                                                    {/* Bridge Mappings Section */}
                                                    <text x={xPos} y={padding - 10} fontWeight="bold" fill="currentColor">Bridge Mappings</text>
                                                    {sortedBridgeMappings
                                                        .filter((mapping: OvnBridgeMapping) => nodePositions[`ovn-${mapping.localnet}`])
                                                        .map((mapping: OvnBridgeMapping, renderIndex: number) => {
                                                            const pos = nodePositions[`ovn-${mapping.localnet}`];
                                                            // For l3 column, we rely on the pre-calculated nodePositions.
                                                            // However, if we want to visually separate them, we might need to adjust Y manually if nodePositions wasn't aware of the split.
                                                            // But gravity sort assumes a single column.
                                                            // To strictly stack them, we should rely on the sorting *logic* to have put them in order.
                                                            // OR, we just render them based on position.
                                                            // The user wants TWO headers.
                                                            // So we find the Y range of the first group.
                                                            return renderInterfaceNode(mapping, pos.x, pos.y, '#009900', 'ovn-mapping');
                                                        })}

                                                    {/* VRFs Section Header - Position it above the first VRF node */}
                                                    {(() => {
                                                        const firstVrf = sortedVrfInterfaces.find(iface => nodePositions[iface.name]);
                                                        if (firstVrf) {
                                                            const pos = nodePositions[firstVrf.name];
                                                            // Draw header slightly above the first VRF node
                                                            return <text x={xPos} y={pos.y - 15} fontWeight="bold" fill="currentColor">VRFs</text>;
                                                        }
                                                        return null;
                                                    })()}

                                                    {sortedVrfInterfaces
                                                        .filter((iface: Interface) => nodePositions[iface.name])
                                                        .map((iface: Interface, renderIndex: number) => {
                                                            const pos = nodePositions[iface.name];
                                                            return renderInterfaceNode(iface, pos.x, pos.y, '#CC6600', 'vrf');
                                                        })}
                                                </>
                                            )}
                                            {col.key === 'cudn' && sortedNetworkItems
                                                .filter((n: NetworkColumnItem) => nodePositions[getNetworkNodeId(n)])
                                                .map((n: NetworkColumnItem, renderIndex: number) => {
                                                    const pos = nodePositions[getNetworkNodeId(n)];
                                                    const color = n.kind === 'cudn' ? CUDN_NODE_COLOR : UDN_NODE_COLOR;
                                                    return renderInterfaceNode(n.item, pos.x, padding + (renderIndex * (itemHeight + 20)), color, n.kind);
                                                })}
                                        </React.Fragment>
                                    );
                                })}

                                {/* Layer 7: Attachments (from CUDN status) */}
                                <text x={padding + (attachmentColOffset * colSpacing)} y={padding - 10} fontWeight="bold" fill="currentColor">Attachments</text>
                                {sortedAttachmentNodes.map((node: AttachmentNode) => {
                                    const pos = nodePositions[getAttachmentNodeId(node)];
                                    return pos && renderInterfaceNode(node, pos.x, pos.y, 'var(--pf-global--palette--gold-400)', 'attachment', getAttachmentHeight(node));
                                })}

                                {showNads && (
                                    <>
                                        <text x={padding + (nadColOffset * colSpacing)} y={padding - 10} fontWeight="bold" fill="currentColor">NADs</text>
                                        {sortedNads.map((nad: NetworkAttachmentDefinition) =>
                                            nodePositions[getNadNodeId(nad)] && renderInterfaceNode(nad, nodePositions[getNadNodeId(nad)].x, nodePositions[getNadNodeId(nad)].y, '#CC9900', 'nad')
                                        )}
                                    </>
                                )}

                                {/* Layer 8: Others */}
                                <text x={padding} y={calculatedHeight - 150} fontWeight="bold" fill="currentColor">Other Interfaces</text>
                                <g transform={`translate(${padding}, ${calculatedHeight - 140})`}>
                                    {sortedOtherInterfaces.map((iface: Interface, index: number) => {
                                        const col = index % 4;
                                        const row = Math.floor(index / 4);
                                        return renderInterfaceNode(iface, col * (itemWidth + 20), row * (itemHeight + 20), '#666');
                                    })}
                                </g>
                            </svg>
                            <Flex style={{ marginTop: '16px', alignItems: 'center' }}>
                                <FlexItem>
                                    <Button variant="secondary" onClick={handleZoomIn} aria-label="Zoom in" style={{ marginRight: '4px' }}>+</Button>
                                </FlexItem>
                                <FlexItem>
                                    <Button variant="secondary" onClick={handleZoomOut} aria-label="Zoom out" style={{ marginRight: '4px' }}>−</Button>
                                </FlexItem>
                                <FlexItem>
                                    <Button variant="secondary" onClick={handleResetZoom} aria-label="Reset zoom" style={{ marginRight: '16px' }}>Reset</Button>
                                </FlexItem>
                                <FlexItem>
                                    <span style={{ fontSize: '0.9em', color: 'var(--pf-global--Color--200)' }}>
                                        Zoom: {Math.round(zoomLevel * 100)}% | Use Ctrl/Cmd + Scroll to zoom | Shift + Drag to pan
                                    </span>
                                </FlexItem>
                            </Flex>
                        </DrawerContentBody>
                    </DrawerContent>
                </Drawer>
            </CardBody>
        </Card >
    );
};

export default NodeVisualization;
