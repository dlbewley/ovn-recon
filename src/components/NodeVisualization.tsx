import * as React from 'react';
import { Card, CardBody, CardTitle, Popover, DescriptionList, DescriptionListTerm, DescriptionListGroup, DescriptionListDescription, Switch, Tabs, Tab, TabTitleText } from '@patternfly/react-core';
import { NetworkIcon, RouteIcon, InfrastructureIcon, LinuxIcon, ResourcePoolIcon, PficonVcenterIcon, MigrationIcon, TagIcon } from '@patternfly/react-icons';

import { NodeNetworkState, ClusterUserDefinedNetwork, Interface, OvnBridgeMapping, NetworkAttachmentDefinition } from '../types';

interface NodeVisualizationProps {
    nns: NodeNetworkState;
    cudns?: ClusterUserDefinedNetwork[];
    nads?: NetworkAttachmentDefinition[];
}

const NodeVisualization: React.FC<NodeVisualizationProps> = ({ nns, cudns = [], nads = [] }) => {
    // Graph Types
    interface AttachmentNode {
        name: string;
        type: string;
        namespaces: string[];
        cudn: string;
    }

    type NodeKind = 'interface' | 'ovn-mapping' | 'cudn' | 'attachment' | 'nad' | 'other';

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
        state?: string;
        namespaces?: string[];
        badges?: string[];
        links?: NodeLink[];
        resourceRef?: ResourceRef;
        isSynthetic?: boolean;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        raw?: any;
    }

    interface NodeKindDefinition {
        label: string;
        buildBadges?: (node: NodeViewModel) => string[];
        buildLinks?: (node: NodeViewModel) => NodeLink[];
        renderDetails?: (node: NodeViewModel) => React.ReactNode;
    }

    const parseNadConfig = (configString?: string) => {
        if (!configString) return null;
        try {
            return JSON.parse(configString);
        } catch {
            return null;
        }
    };

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

    const nodeKindRegistry: Record<NodeKind, NodeKindDefinition> = {
        interface: {
            label: 'Interface',
            renderDetails: (node) => (
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
                </DescriptionList>
            )
        },
        'ovn-mapping': {
            label: 'OVN Mapping'
        },
        cudn: {
            label: 'CUDN',
            renderDetails: (node) => (
                <DescriptionList isCompact>
                    <DescriptionListGroup>
                        <DescriptionListTerm>Topology</DescriptionListTerm>
                        <DescriptionListDescription>{node.raw?.spec?.network?.topology || 'Unknown'}</DescriptionListDescription>
                    </DescriptionListGroup>
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
                </DescriptionList>
            )
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
        other: {
            label: 'Other'
        }
    };

    interface GraphNode {
        id: string;
        upstream: string[];
        downstream: string[];
    }

    interface Graph {
        nodes: { [id: string]: GraphNode };
    }

    const interfaces: Interface[] = nns?.status?.currentState?.interfaces || [];
    const ovn = nns?.status?.currentState?.ovn;
    const bridgeMappings: OvnBridgeMapping[] = ovn?.['bridge-mappings'] || [];

    // State for toggle
    const [showHiddenColumns, setShowHiddenColumns] = React.useState<boolean>(false);
    const [showNads, setShowNads] = React.useState<boolean>(false);

    // Simple layout logic
    const width = 1600; // Increased width for new columns
    // const height = 800; // Unused
    const padding = 50;
    const itemHeight = 80;
    const itemWidth = 160;
    const colSpacing = 220;

    // Identify controllers
    const controllerNames = new Set(interfaces.map((iface: Interface) => iface.controller || iface.master).filter(Boolean));

    // Group interfaces
    const ethInterfaces = interfaces.filter((iface: Interface) => iface.type === 'ethernet' && iface.state !== 'ignore');
    const bondInterfaces = interfaces.filter((iface: Interface) => iface.type === 'bond');
    const vlanInterfaces = interfaces.filter((iface: Interface) => iface.type === 'vlan' || iface.type === 'mac-vlan'); // Includes mac-vlan

    const isBridge = (iface: Interface) => {
        if (['linux-bridge', 'ovs-bridge'].includes(iface.type)) return true;
        // ovs-interface is a bridge if it is a controller AND does NOT have a patch
        if (iface.type === 'ovs-interface' && controllerNames.has(iface.name) && !iface.patch && iface.state !== 'ignore') return true;
        return false;
    };

    const bridgeInterfaces = interfaces.filter(isBridge);

    // Logical interfaces: ovs-interface that are NOT bridges and NOT ignored
    const logicalInterfaces = interfaces.filter((iface: Interface) => iface.type === 'ovs-interface' && !isBridge(iface) && iface.state !== 'ignore' && !iface.name.startsWith('patch'));

    const otherInterfaces = interfaces.filter((iface: Interface) => !['ethernet', 'bond', 'vlan', 'mac-vlan'].includes(iface.type) && !isBridge(iface) && iface.type !== 'ovs-interface');

    // Calculate positions with dynamic column visibility
    const nodePositions: { [name: string]: { x: number, y: number } } = {};

    // Define columns with their data
    const columns = [
        { name: 'Physical Interfaces', data: ethInterfaces, key: 'eth' },
        { name: 'Bonds', data: bondInterfaces, key: 'bond' },
        { name: 'VLAN Interfaces', data: vlanInterfaces, key: 'vlan' },
        { name: 'Bridges', data: bridgeInterfaces, key: 'bridge' },
        { name: 'Logical Interfaces', data: logicalInterfaces, key: 'logical' },
        { name: 'Bridge Mappings', data: bridgeMappings, key: 'ovn' },
        { name: 'Networks', data: cudns, key: 'cudn' },
    ];

    // Filter columns based on showHiddenColumns
    const visibleColumns = showHiddenColumns ? columns : columns.filter(col => col.data.length > 0);

    // Position nodes based on visible columns
    // const currentColIndex = 0; // Unused

    if (showHiddenColumns || ethInterfaces.length > 0) {
        ethInterfaces.forEach((iface: Interface, index: number) => {
            const colOffset = visibleColumns.findIndex(col => col.key === 'eth');
            nodePositions[iface.name] = { x: padding + (colOffset * colSpacing), y: padding + (index * (itemHeight + 20)) };
        });
    }

    if (showHiddenColumns || bondInterfaces.length > 0) {
        bondInterfaces.forEach((iface: Interface, index: number) => {
            const colOffset = visibleColumns.findIndex(col => col.key === 'bond');
            nodePositions[iface.name] = { x: padding + (colOffset * colSpacing), y: padding + (index * (itemHeight + 20)) };
        });
    }

    if (showHiddenColumns || vlanInterfaces.length > 0) {
        vlanInterfaces.forEach((iface: Interface, index: number) => {
            const colOffset = visibleColumns.findIndex(col => col.key === 'vlan');
            nodePositions[iface.name] = { x: padding + (colOffset * colSpacing), y: padding + (index * (itemHeight + 20)) };
        });
    }

    if (showHiddenColumns || bridgeInterfaces.length > 0) {
        bridgeInterfaces.forEach((iface: Interface, index: number) => {
            const colOffset = visibleColumns.findIndex(col => col.key === 'bridge');
            nodePositions[iface.name] = { x: padding + (colOffset * colSpacing), y: padding + (index * (itemHeight + 20)) };
        });
    }

    if (showHiddenColumns || logicalInterfaces.length > 0) {
        logicalInterfaces.forEach((iface: Interface, index: number) => {
            const colOffset = visibleColumns.findIndex(col => col.key === 'logical');
            nodePositions[iface.name] = { x: padding + (colOffset * colSpacing), y: padding + (index * (itemHeight + 20)) };
        });
    }

    if (showHiddenColumns || bridgeMappings.length > 0) {
        bridgeMappings.forEach((mapping: OvnBridgeMapping, index: number) => {
            const colOffset = visibleColumns.findIndex(col => col.key === 'ovn');
            nodePositions[`ovn-${mapping.localnet}`] = { x: padding + (colOffset * colSpacing), y: padding + (index * (itemHeight + 20)) };
        });
    }

    if (showHiddenColumns || cudns.length > 0) {
        cudns.forEach((cudn: ClusterUserDefinedNetwork, index: number) => {
            const colOffset = visibleColumns.findIndex(col => col.key === 'cudn');
            nodePositions[`cudn-${cudn.metadata?.name}`] = { x: padding + (colOffset * colSpacing), y: padding + (index * (itemHeight + 20)) };
        });
    }

    // Attachments (from CUDN status) - AGGREGATED
    const attachmentNodes: AttachmentNode[] = [];
    cudns.forEach((cudn: ClusterUserDefinedNetwork) => {
        const condition = cudn.status?.conditions?.find((c) => c.type === 'NetworkCreated' && c.status === 'True');
        if (condition && condition.message) {
            const match = condition.message.match(/\[(.*?)\]/);
            if (match && match[1]) {
                const namespaces = match[1].split(',').map((ns: string) => ns.trim()).sort();
                if (namespaces.length > 0) {
                    attachmentNodes.push({
                        name: cudn.metadata?.name || '', // Name same as CUDN
                        type: 'attachment',
                        namespaces: namespaces, // List of namespaces
                        cudn: cudn.metadata?.name || ''
                    });
                }
            }
        }
    });

    const getNadNetworkName = (nad: NetworkAttachmentDefinition) => {
        const config = parseNadConfig(nad.spec?.config);
        if (typeof config?.name === 'string') return config.name;
        return undefined;
    };

    const findCudnNameForNad = (nad: NetworkAttachmentDefinition) => {
        const nadConfigName = getNadNetworkName(nad);
        const directMatch = nad.metadata?.name && cudns.find((cudn) => cudn.metadata?.name === nad.metadata?.name)?.metadata?.name;
        if (directMatch) return directMatch;
        if (nadConfigName) {
            const configMatch = cudns.find((cudn) => cudn.metadata?.name === nadConfigName)?.metadata?.name;
            if (configMatch) return configMatch;
        }
        return undefined;
    };

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

        // 1. Interfaces (Physical, Bond, VLAN, Bridge, Logical)
        interfaces.forEach((iface: Interface) => {
            addNode(iface.name);
            // Upstream: master/controller
            const master = iface.controller || iface.master;
            if (master) addEdge(iface.name, master);

            // Upstream: base-iface (VLAN/MAC-VLAN)
            const baseIface = iface.vlan?.['base-iface'] || iface['mac-vlan']?.['base-iface'];
            if (baseIface) addEdge(baseIface, iface.name); // Correct direction: Base -> VLAN
        });

        // 2. Bridge Mappings (Bridge -> OVN Localnet)
        bridgeMappings.forEach((mapping: OvnBridgeMapping) => {
            const ovnNodeId = `ovn-${mapping.localnet}`;
            if (mapping.bridge) addEdge(mapping.bridge, ovnNodeId);
        });

        // 3. CUDNs (OVN Localnet -> CUDN)
        cudns.forEach((cudn: ClusterUserDefinedNetwork) => {
            const cudnNodeId = `cudn-${cudn.metadata?.name}`;
            const physicalNetworkName = cudn.spec?.network?.localNet?.physicalNetworkName || cudn.spec?.network?.localnet?.physicalNetworkName;
            if (physicalNetworkName) {
                const ovnNodeId = `ovn-${physicalNetworkName}`;
                addEdge(ovnNodeId, cudnNodeId); // Flow: OVN -> CUDN
            }
        });

        // 4. Attachments (CUDN -> Attachment)
        attachmentNodes.forEach((node: AttachmentNode) => {
            const attachmentNodeId = `attachment-${node.cudn}`;
            const cudnNodeId = `cudn-${node.cudn}`;
            addEdge(cudnNodeId, attachmentNodeId); // Flow: CUDN -> Attachment
        });

        // 5. NADs (optional CUDN -> NAD)
        if (showNads) {
            nads.forEach((nad: NetworkAttachmentDefinition) => {
                const nadNodeId = getNadNodeId(nad);
                addNode(nadNodeId);
                const cudnName = findCudnNameForNad(nad);
                if (cudnName) {
                    addEdge(`cudn-${cudnName}`, nadNodeId);
                }
            });
        }

        return g;
    }, [interfaces, bridgeMappings, cudns, attachmentNodes, nads, showNads]);

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
    attachmentNodes.forEach((node: AttachmentNode) => {
        const height = getAttachmentHeight(node);
        nodePositions[`attachment-${node.cudn}`] = { x: padding + (attachmentColOffset * colSpacing), y: currentAttachmentY };
        currentAttachmentY += height + 20; // Add gap
    });

    const nadColOffset = attachmentColOffset + 1; // NADs render to the right of Attachments
    if (showNads && (showHiddenColumns || nads.length > 0)) {
        nads.forEach((nad: NetworkAttachmentDefinition, index: number) => {
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
        cudns.length,
        showNads ? nads.length : 0,
        Math.ceil(otherInterfaces.length / 4) + 2
    );
    // Use currentAttachmentY for attachment column height
    const calculatedHeight = Math.max(600, padding + (maxRows * (itemHeight + 20)) + 200, currentAttachmentY + 100);

    const getIcon = (type: string) => {
        switch (type) {
            case 'ethernet': return <ResourcePoolIcon />;
            case 'bond': return <PficonVcenterIcon />;
            case 'linux-bridge': return <LinuxIcon />;
            case 'ovs-bridge': return <InfrastructureIcon />;
            case 'ovs-interface': return <NetworkIcon />; // Logical
            case 'ovn-mapping': return <RouteIcon />;
            case 'cudn': return <NetworkIcon />;
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

    // State for Popover
    const [activeNode, setActiveNode] = React.useState<NodeViewModel | null>(null);
    const [anchorElement, setAnchorElement] = React.useState<HTMLElement | null>(null);
    const [activePopoverTab, setActivePopoverTab] = React.useState<string | number>('summary');

    const handleNodeClick = (event: React.MouseEvent, node: NodeViewModel) => {
        event.stopPropagation(); // Prevent clearing highlight when clicking a node
        setAnchorElement(event.currentTarget as HTMLElement);
        setActiveNode(node);

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

    React.useEffect(() => {
        if (activeNode) {
            setActivePopoverTab('summary');
        }
    }, [activeNode?.id]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolveNodeId = (iface: any, type: string) => {
        if (type === 'ovn-mapping') return `ovn-${iface.localnet}`;
        if (type === 'cudn') return `cudn-${iface.metadata?.name}`;
        if (type === 'attachment') return `attachment-${iface.cudn}`;
        if (type === 'nad') return getNadNodeId(iface);
        return iface.name;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buildNodeViewModel = (iface: any, type: string): NodeViewModel => {
        const nodeId = resolveNodeId(iface, type);
        const kind: NodeKind = type === 'ovn-mapping'
            ? 'ovn-mapping'
            : type === 'cudn'
                ? 'cudn'
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
        let state = iface.state;
        let namespaces: string[] | undefined;
        let resourceRef: ResourceRef | undefined;
        let isSynthetic = false;

        if (type === 'ovn-mapping') {
            label = iface.localnet;
            title = iface.localnet;
            subtitle = 'OVN Localnet';
            state = iface.bridge ? `Bridge: ${iface.bridge}` : undefined;
        } else if (type === 'cudn') {
            label = iface.metadata?.name || '';
            title = iface.metadata?.name || '';
            subtitle = 'CUDN';
            state = iface.spec?.network?.topology || 'Unknown';
            if (iface.spec?.network?.topology === 'Localnet') {
                const vlan = iface.spec?.network?.localnet?.vlan?.access?.id;
                if (vlan) {
                    state += ` VLAN ${vlan}`;
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
        } else if (type === 'attachment') {
            label = iface.name;
            title = iface.name;
            subtitle = 'NAD';
            state = 'Namespaces:';
            namespaces = iface.namespaces || [];
            isSynthetic = true;
        } else if (type === 'nad') {
            label = iface.metadata?.name || '';
            title = iface.metadata?.name || '';
            subtitle = 'NAD';
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
            state,
            namespaces,
            resourceRef,
            isSynthetic,
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const renderInterfaceNode = (iface: any, x: number, y: number, color: string, typeOverride?: string, heightOverride?: number) => {
        const type = typeOverride || iface.type;
        const Icon = getIcon(type);
        const viewNode = buildNodeViewModel(iface, type);
        let displayName = viewNode.label;
        let displayType = viewNode.subtitle;
        let displayState = viewNode.state;
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
                {type !== 'ovn-mapping' && type !== 'cudn' && type !== 'attachment' && (
                    <circle cx={itemWidth - 15} cy={15} r={5} fill={iface.state === 'up' ? '#4CAF50' : '#F44336'} />
                )}
            </g>
        );
    };

    if (interfaces.length === 0) {
        return (
            <Card isFullHeight>
                <CardTitle>Network Topology Visualization</CardTitle>
                <CardBody>
                    No interfaces found in NodeNetworkState status.
                </CardBody>
            </Card>
        );
    }

    return (
        <Card isFullHeight>
            <CardTitle>Network Topology Visualization</CardTitle>
            <CardBody>
                <div style={{ marginBottom: '16px' }}>
                    <Switch
                        id="show-hidden-columns-toggle"
                        label="Show hidden columns"
                        isChecked={showHiddenColumns}
                        onChange={(event, checked) => setShowHiddenColumns(checked)}
                    />
                </div>
                <div style={{ marginBottom: '16px' }}>
                    <Switch
                        id="show-nads-toggle"
                        label="Show Net Attach Defs"
                        isChecked={showNads}
                        onChange={(event, checked) => setShowNads(checked)}
                    />
                </div>
                <svg width="100%" height={calculatedHeight} viewBox={`0 0 ${width} ${calculatedHeight}`} style={{ border: '1px solid var(--pf-global--BorderColor--100)', background: 'var(--pf-global--BackgroundColor--200)', color: 'var(--pf-global--Color--100)' }} onClick={handleBackgroundClick}>

                    {/* Connectors */}
                    {interfaces.map((iface: Interface) => {
                        const master = iface.controller || iface.master;
                        if (master && nodePositions[master]) {
                            return renderConnector(iface.name, master);
                        }
                        return null;
                    })}
                    {/* VLAN and MAC-VLAN to base-iface connectors */}
                    {vlanInterfaces.map((iface: Interface) => {
                        const baseIface = iface.vlan?.['base-iface'] || iface['mac-vlan']?.['base-iface'];
                        if (baseIface && nodePositions[baseIface]) {
                            return renderConnector(baseIface, iface.name);
                        }
                        return null;
                    })}
                    {bridgeMappings.map((mapping: OvnBridgeMapping) => {
                        if (mapping.bridge && nodePositions[mapping.bridge]) {
                            return renderConnector(mapping.bridge, `ovn-${mapping.localnet}`);
                        }
                        return null;
                    })}
                    {cudns.map((cudn: ClusterUserDefinedNetwork) => {
                        // Connect CUDN to OVN Mapping
                        const physicalNetworkName = cudn.spec?.network?.localNet?.physicalNetworkName || cudn.spec?.network?.localnet?.physicalNetworkName;
                        if (physicalNetworkName && nodePositions[`ovn-${physicalNetworkName}`]) {
                            // Draw FROM OVN Mapping TO CUDN (Left to Right)
                            return renderConnector(`ovn-${physicalNetworkName}`, `cudn-${cudn.metadata?.name}`);
                        }
                        return null;
                    })}
                    {attachmentNodes.map((node: AttachmentNode) => {
                        // Connect CUDN to Attachment (Left to Right)
                        if (nodePositions[`cudn-${node.cudn}`]) {
                            // Draw FROM CUDN TO Attachment
                            return renderConnector(`cudn-${node.cudn}`, `attachment-${node.cudn}`);
                        }
                        return null;
                    })}
                    {showNads && nads.map((nad: NetworkAttachmentDefinition) => {
                        const cudnName = findCudnNameForNad(nad);
                        if (cudnName && nodePositions[`cudn-${cudnName}`]) {
                            return renderConnector(`cudn-${cudnName}`, getNadNodeId(nad));
                        }
                        return null;
                    })}

                    {/* Render visible columns dynamically */}
                    {visibleColumns.map((col, idx) => {
                        const xPos = padding + (idx * colSpacing);
                        return (
                            <React.Fragment key={col.key}>
                                <text x={xPos} y={padding - 10} fontWeight="bold" fill="currentColor">{col.name}</text>
                                {col.key === 'eth' && ethInterfaces.map((iface: Interface) =>
                                    nodePositions[iface.name] && renderInterfaceNode(iface, nodePositions[iface.name].x, nodePositions[iface.name].y, '#0066CC')
                                )}
                                {col.key === 'bond' && bondInterfaces.map((iface: Interface) =>
                                    nodePositions[iface.name] && renderInterfaceNode(iface, nodePositions[iface.name].x, nodePositions[iface.name].y, '#663399')
                                )}
                                {col.key === 'vlan' && vlanInterfaces.map((iface: Interface) =>
                                    nodePositions[iface.name] && renderInterfaceNode(iface, nodePositions[iface.name].x, nodePositions[iface.name].y, '#9933CC')
                                )}
                                {col.key === 'bridge' && bridgeInterfaces.map((iface: Interface) =>
                                    nodePositions[iface.name] && renderInterfaceNode(iface, nodePositions[iface.name].x, nodePositions[iface.name].y, '#FF6600')
                                )}
                                {col.key === 'logical' && logicalInterfaces.map((iface: Interface) =>
                                    nodePositions[iface.name] && renderInterfaceNode(iface, nodePositions[iface.name].x, nodePositions[iface.name].y, '#0099CC')
                                )}
                                {col.key === 'ovn' && bridgeMappings.map((mapping: OvnBridgeMapping) =>
                                    nodePositions[`ovn-${mapping.localnet}`] && renderInterfaceNode(mapping, nodePositions[`ovn-${mapping.localnet}`].x, nodePositions[`ovn-${mapping.localnet}`].y, '#009900', 'ovn-mapping')
                                )}
                                {col.key === 'cudn' && cudns.map((cudn: ClusterUserDefinedNetwork) =>
                                    nodePositions[`cudn-${cudn.metadata?.name}`] && renderInterfaceNode(cudn, nodePositions[`cudn-${cudn.metadata?.name}`].x, nodePositions[`cudn-${cudn.metadata?.name}`].y, '#CC0099', 'cudn')
                                )}
                            </React.Fragment>
                        );
                    })}

                    {/* Layer 7: Attachments (from CUDN status) */}
                    <text x={padding + (attachmentColOffset * colSpacing)} y={padding - 10} fontWeight="bold" fill="currentColor">Attachments</text>
                    {attachmentNodes.map((node: AttachmentNode) =>
                        nodePositions[`attachment-${node.cudn}`] && renderInterfaceNode(node, nodePositions[`attachment-${node.cudn}`].x, nodePositions[`attachment-${node.cudn}`].y, 'var(--pf-global--palette--gold-400)', 'attachment', getAttachmentHeight(node))
                    )}

                    {showNads && (
                        <>
                            <text x={padding + (nadColOffset * colSpacing)} y={padding - 10} fontWeight="bold" fill="currentColor">NADs</text>
                            {nads.map((nad: NetworkAttachmentDefinition) =>
                                nodePositions[getNadNodeId(nad)] && renderInterfaceNode(nad, nodePositions[getNadNodeId(nad)].x, nodePositions[getNadNodeId(nad)].y, '#CC9900', 'nad')
                            )}
                        </>
                    )}

                    {/* Layer 8: Others */}
                    <text x={padding} y={calculatedHeight - 150} fontWeight="bold" fill="currentColor">Other Interfaces</text>
                    <g transform={`translate(${padding}, ${calculatedHeight - 140})`}>
                        {otherInterfaces.map((iface: Interface, index: number) => {
                            const col = index % 4;
                            const row = Math.floor(index / 4);
                            return renderInterfaceNode(iface, col * (itemWidth + 20), row * (itemHeight + 20), '#666');
                        })}
                    </g>
                </svg>

                <Popover
                    triggerRef={() => anchorElement as HTMLElement}
                    isVisible={!!activeNode}
                    shouldClose={handlePopoverClose}
                    headerContent={<div>{activeNode?.title}</div>}
                    bodyContent={
                        activeNode
                            ? (
                                <Tabs
                                    activeKey={activePopoverTab}
                                    onSelect={(_event, key) => setActivePopoverTab(key)}
                                >
                                    <Tab eventKey="summary" title={<TabTitleText>Summary</TabTitleText>}>
                                        <DescriptionList isCompact>
                                            <DescriptionListGroup>
                                                <DescriptionListTerm>Type</DescriptionListTerm>
                                                <DescriptionListDescription>{activeNode.subtitle}</DescriptionListDescription>
                                            </DescriptionListGroup>
                                            {activeNode.state && (
                                                <DescriptionListGroup>
                                                    <DescriptionListTerm>State</DescriptionListTerm>
                                                    <DescriptionListDescription>{activeNode.state}</DescriptionListDescription>
                                                </DescriptionListGroup>
                                            )}
                                            {activeNode.namespaces && (
                                                <DescriptionListGroup>
                                                    <DescriptionListTerm>Namespaces</DescriptionListTerm>
                                                    <DescriptionListDescription>{activeNode.namespaces.join(', ')}</DescriptionListDescription>
                                                </DescriptionListGroup>
                                            )}
                                            {activeNode.resourceRef && (
                                                <DescriptionListGroup>
                                                    <DescriptionListTerm>Resource</DescriptionListTerm>
                                                    <DescriptionListDescription>
                                                        {activeNode.resourceRef.kind} {activeNode.resourceRef.namespace ? `${activeNode.resourceRef.namespace}/` : ''}{activeNode.resourceRef.name}
                                                    </DescriptionListDescription>
                                                </DescriptionListGroup>
                                            )}
                                            {activeNode.badges && activeNode.badges.length > 0 && (
                                                <DescriptionListGroup>
                                                    <DescriptionListTerm>Badges</DescriptionListTerm>
                                                    <DescriptionListDescription>{activeNode.badges.join(', ')}</DescriptionListDescription>
                                                </DescriptionListGroup>
                                            )}
                                        </DescriptionList>
                                    </Tab>
                                    <Tab eventKey="details" title={<TabTitleText>Details</TabTitleText>}>
                                        {nodeKindRegistry[activeNode.kind]?.renderDetails?.(activeNode) || (
                                            <DescriptionList isCompact>
                                                <DescriptionListGroup>
                                                    <DescriptionListTerm>Details</DescriptionListTerm>
                                                    <DescriptionListDescription>No extra details.</DescriptionListDescription>
                                                </DescriptionListGroup>
                                            </DescriptionList>
                                        )}
                                    </Tab>
                                    <Tab eventKey="links" title={<TabTitleText>Links</TabTitleText>}>
                                        {activeNode.links && activeNode.links.length > 0 ? (
                                            <DescriptionList isCompact>
                                                <DescriptionListGroup>
                                                    <DescriptionListTerm>Links</DescriptionListTerm>
                                                    <DescriptionListDescription>
                                                        {activeNode.links.map((link) => (
                                                            <div key={link.href}><a href={link.href}>{link.label}</a></div>
                                                        ))}
                                                    </DescriptionListDescription>
                                                </DescriptionListGroup>
                                            </DescriptionList>
                                        ) : (
                                            <DescriptionList isCompact>
                                                <DescriptionListGroup>
                                                    <DescriptionListTerm>Links</DescriptionListTerm>
                                                    <DescriptionListDescription>No links available.</DescriptionListDescription>
                                                </DescriptionListGroup>
                                            </DescriptionList>
                                        )}
                                    </Tab>
                                    <Tab eventKey="yaml" title={<TabTitleText>YAML</TabTitleText>}>
                                        {activeNode.links && activeNode.links.length > 0 ? (
                                            <DescriptionList isCompact>
                                                <DescriptionListGroup>
                                                    <DescriptionListTerm>YAML</DescriptionListTerm>
                                                    <DescriptionListDescription>
                                                        {activeNode.links.filter((link) => link.label === 'YAML').map((link) => (
                                                            <div key={link.href}><a href={link.href}>Open YAML</a></div>
                                                        ))}
                                                    </DescriptionListDescription>
                                                </DescriptionListGroup>
                                            </DescriptionList>
                                        ) : (
                                            <DescriptionList isCompact>
                                                <DescriptionListGroup>
                                                    <DescriptionListTerm>YAML</DescriptionListTerm>
                                                    <DescriptionListDescription>No YAML link available.</DescriptionListDescription>
                                                </DescriptionListGroup>
                                            </DescriptionList>
                                        )}
                                    </Tab>
                                </Tabs>
                            )
                            : null
                    }
                >
                    <div style={{ display: 'none' }} />
                </Popover>
            </CardBody>
        </Card>
    );
};

export default NodeVisualization;
