import * as React from 'react';
import { Card, CardBody, CardTitle, Drawer, DrawerPanelContent, DrawerContent, DrawerContentBody, DrawerHead, DrawerActions, DrawerCloseButton, Title, Switch, Tabs, Tab, TabTitleText, Flex, FlexItem, Button, FormSelect, FormSelectOption } from '@patternfly/react-core';
import { useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';


import { NodeNetworkState, ClusterUserDefinedNetwork, UserDefinedNetwork, Interface, OvnBridgeMapping, NetworkAttachmentDefinition, RouteAdvertisements } from '../types';
import {
    extractLldpNeighbors,
    getCudnAssociatedNamespaces,
    hasLldpNeighbors,
    LldpNeighborNode
} from './nodeVisualizationSelectors';
import { buildTopologyEdges, TopologyEdge } from './nodeVisualizationModel';
import { buildGraphContext, GraphContext } from '../topology/context';
import { interfacesWithRole, roleOf } from '../topology/classify';
import { buildDrawerTabs, getDrawerTabsForNode } from '../topology/drawerTabs';
import { getIcon } from '../topology/icons';
import {
    attachmentNodeId as getAttachmentNodeId,
    bridgeMappingNodeId,
    edgeKey,
    findDuplicateIds,
    nadNodeId as getNadNodeId,
    networkNodeId as getNetworkNodeId,
    resolveNodeId as resolveId
} from '../topology/ids';
import {
    AttachmentNode, DrawerTabId, Graph, NetworkColumnItem, NodeViewModel
} from '../topology/types';
import { buildNodeViewModel } from '../topology/viewModel';
import { computeNodeOrder, sortByRank, LayoutLane } from './nodeVisualizationLayout';

interface NodeVisualizationProps {
    nns: NodeNetworkState;
    cudns?: ClusterUserDefinedNetwork[];
    udns?: UserDefinedNetwork[];
    nads?: NetworkAttachmentDefinition[];
    routeAdvertisements?: RouteAdvertisements[];
}

const NodeVisualization: React.FC<NodeVisualizationProps> = ({ nns, cudns = [], udns = [], nads = [], routeAdvertisements = [] }) => {
    const CUDN_NODE_COLOR = '#CC0099';
    const UDN_NODE_COLOR = '#0084A8';



    const navigateToPath = (path: string) => {
        window.history.pushState(null, '', path);
        window.dispatchEvent(new PopStateEvent('popstate'));
    };

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
            navigateToPath(`/ovn-recon/node-network-state/${value}`);
        }
    };

    const getSwitchChecked = (
        first: React.FormEvent<HTMLInputElement> | boolean,
        second?: React.FormEvent<HTMLInputElement> | boolean
    ): boolean => {
        if (typeof first === 'boolean') {
            return first;
        }
        if (typeof second === 'boolean') {
            return second;
        }
        const target = first.target as HTMLInputElement | null;
        return Boolean(target?.checked);
    };

    const ctx: GraphContext = React.useMemo(
        () => buildGraphContext({ nns, cudns, udns, nads, routeAdvertisements }),
        [nns, cudns, udns, nads, routeAdvertisements]
    );
    const { interfaces, bridgeMappings } = ctx;
    const lldpNeighbors = extractLldpNeighbors(interfaces);
    const hasLldpData = hasLldpNeighbors(interfaces);

    // State for toggle
    const [showHiddenColumns, setShowHiddenColumns] = React.useState<boolean>(false);
    const [showNads, setShowNads] = React.useState<boolean>(false);
    const [showLldpNeighbors, setShowLldpNeighbors] = React.useState<boolean>(false);
    const showLldpColumn = hasLldpData && showLldpNeighbors;

    // Pan/Zoom state
    const [viewBox, setViewBox] = React.useState<{ x: number; y: number; width: number; height: number } | null>(null);
    const [isPanning, setIsPanning] = React.useState<boolean>(false);
    const [panStart, setPanStart] = React.useState<{ x: number; y: number } | null>(null);
    const [zoomLevel, setZoomLevel] = React.useState<number>(1);
    const svgContainerRef = React.useRef<SVGSVGElement | null>(null);

    // Simple layout logic
    const width = 1600; // Increased width for new columns
    // const height = 800; // Unused
    const padding = 20; // Keep headers visible while remaining top-left aligned
    const itemHeight = 80;
    const itemWidth = 160;
    const colSpacing = 220;

    // Identify controllers

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolveNodeId = (iface: any, type: string) => resolveId(iface, type, ctx);

    // Lanes are populated by topology ROLE, not by nmstate type. See topology/classify.
    const ethInterfaces = interfacesWithRole(ctx, 'physical');
    const bondInterfaces = interfacesWithRole(ctx, 'bond');
    const vrfInterfaces = interfacesWithRole(ctx, 'vrf');
    const vlanInterfaces = interfacesWithRole(ctx, 'vlan');
    const bridgeInterfaces = interfacesWithRole(ctx, 'bridge');
    const logicalInterfaces = interfacesWithRole(ctx, 'bridge-port');
    // The catch-all grid at the foot of the canvas. 'unclassified' landing here is a
    // prompt to add a rule, not a resting place.
    const otherInterfaces = ctx.interfaces.filter((iface) =>
        ['host-local', 'unclassified'].includes(roleOf(iface, ctx)));

    // Define columns with their data
    const networkItems: NetworkColumnItem[] = [...cudns.map((c): NetworkColumnItem => ({ kind: 'cudn', item: c })), ...udns.map((u): NetworkColumnItem => ({ kind: 'udn', item: u }))];
    const columns = [
        ...(showLldpColumn ? [{ name: 'LLDP Neighbors', data: lldpNeighbors, key: 'lldp' }] : []),
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
                udn: { namespace: ns, name }
            });
        }
    });

    const { edges: topologyEdges, unresolved } = buildTopologyEdges({
        ctx,
        vrfInterfaces,
        lldpNeighbors,
        attachmentNodes,
        showNads,
        showLldpNeighbors: showLldpColumn
    });

    // Lanes fed to the ordering pass. Left-to-right order must match `columns` plus
    // the two trailing pseudo-columns, since a node's barycenter is the average
    // position of its neighbours in adjacent lanes.
    // Note the l3 lane holds two stacked groups (bridge mappings above VRFs) and the
    // networks lane holds CUDNs above UDNs; both are expressed as group ranks below
    // rather than as ordering hacks inside the layout module.
    const layoutLanes: LayoutLane[] = [
        { id: 'lldp', nodeIds: lldpNeighbors.map((neighbor) => neighbor.id) },
        { id: 'eth', nodeIds: ethInterfaces.map((iface) => resolveNodeId(iface, iface.type)) },
        { id: 'bond', nodeIds: bondInterfaces.map((iface) => resolveNodeId(iface, iface.type)) },
        { id: 'vlan', nodeIds: vlanInterfaces.map((iface) => resolveNodeId(iface, iface.type)) },
        { id: 'bridge', nodeIds: bridgeInterfaces.map((iface) => resolveNodeId(iface, iface.type)) },
        { id: 'logical', nodeIds: logicalInterfaces.map((iface) => resolveNodeId(iface, iface.type)) },
        {
            id: 'l3',
            nodeIds: [
                ...bridgeMappings.map((mapping) => bridgeMappingNodeId(mapping.localnet)),
                ...vrfInterfaces.map((iface) => resolveNodeId(iface, iface.type))
            ]
        },
        { id: 'networks', nodeIds: networkItems.map(getNetworkNodeId) },
        { id: 'attachments', nodeIds: attachmentNodes.map(getAttachmentNodeId) },
        { id: 'nads', nodeIds: nads.map(getNadNodeId) }
    ];

    // Sub-group ordering within a lane: bridge mappings above VRFs, CUDNs above UDNs.
    const groupRankById: Record<string, number> = {};
    vrfInterfaces.forEach((iface) => {
        groupRankById[resolveNodeId(iface, iface.type)] = 1;
    });
    networkItems.forEach((item) => {
        if (item.kind === 'udn') groupRankById[getNetworkNodeId(item)] = 1;
    });

    const rankById = computeNodeOrder({ lanes: layoutLanes, edges: topologyEdges, groupRankById });

    const rankOfIface = (iface: Interface) => resolveNodeId(iface, iface.type);
    const sortedEthInterfaces = sortByRank(ethInterfaces, rankOfIface, rankById);
    const sortedLldpNeighbors = sortByRank(lldpNeighbors, (neighbor) => neighbor.id, rankById);
    const sortedBondInterfaces = sortByRank(bondInterfaces, rankOfIface, rankById);
    const sortedVrfInterfaces = sortByRank(vrfInterfaces, rankOfIface, rankById);
    const sortedVlanInterfaces = sortByRank(vlanInterfaces, rankOfIface, rankById);
    const sortedBridgeInterfaces = sortByRank(bridgeInterfaces, rankOfIface, rankById);
    const sortedLogicalInterfaces = sortByRank(logicalInterfaces, rankOfIface, rankById);
    const sortedBridgeMappings = sortByRank(bridgeMappings, (mapping) => bridgeMappingNodeId(mapping.localnet), rankById);
    const sortedNetworkItems = sortByRank(networkItems, getNetworkNodeId, rankById);
    const sortedAttachmentNodes = sortByRank(attachmentNodes, getAttachmentNodeId, rankById);
    const sortedNads = sortByRank(nads, (nad) => getNadNodeId(nad), rankById);
    // Not laned: rendered in a grid at the foot of the canvas, so plain alphabetical.
    const sortedOtherInterfaces = otherInterfaces.slice().sort((a, b) => a.name.localeCompare(b.name));

    /**
     * Two classes of problem that used to be invisible.
     *
     * A reference naming something not on this node -- a controller, a bridge mapping's
     * bridge -- used to be dropped in silence, so a dangling reference looked exactly
     * like a node with no edges. And a duplicated id makes React draw one node on top of
     * another and log a duplicate-key warning, which reads as missing data.
     *
     * Reported to the console for now. ovn-recon-s3t.15 surfaces them in the UI.
     */
    React.useEffect(() => {
        unresolved.forEach(({ rule, reference, from }) => {
             
            console.warn(`[ovn-recon] ${from} names "${reference}" via ${rule}, which is not an interface on this node.`);
        });
    }, [unresolved]);

    React.useEffect(() => {
        const duplicates = findDuplicateIds([
            ...interfaces.map((iface) => resolveNodeId(iface, iface.type)),
            ...bridgeMappings.map((mapping) => bridgeMappingNodeId(mapping.localnet)),
            ...networkItems.map(getNetworkNodeId),
            ...attachmentNodes.map(getAttachmentNodeId),
            ...nads.map(getNadNodeId)
        ]);
        if (duplicates.length > 0) {
             
            console.warn(`[ovn-recon] duplicate node ids, which will draw on top of each other: ${duplicates.join(', ')}`);
        }
    }, [interfaces, bridgeMappings, networkItems, attachmentNodes, nads]);

    // Calculate positions with dynamic column visibility
    const nodePositions: { [name: string]: { x: number, y: number } } = {};

    // Position nodes based on visible columns
    // const currentColIndex = 0; // Unused

    if (showLldpColumn && lldpNeighbors.length > 0) {
        const colOffset = visibleColumns.findIndex(col => col.key === 'lldp');
        if (colOffset >= 0) {
            const baseYByInterface = new Map<string, number>();
            sortedEthInterfaces.forEach((iface: Interface, index: number) => {
                baseYByInterface.set(iface.name, padding + (index * (itemHeight + 20)));
            });
            const stackByInterface = new Map<string, number>();

            sortedLldpNeighbors.forEach((neighbor: LldpNeighborNode, index: number) => {
                const stackIndex = stackByInterface.get(neighbor.localInterface) || 0;
                const baseY = baseYByInterface.get(neighbor.localInterface);
                const fallbackY = padding + (index * (itemHeight + 20));
                nodePositions[neighbor.id] = {
                    x: padding + (colOffset * colSpacing),
                    y: baseY != null ? baseY + (stackIndex * 24) : fallbackY
                };
                stackByInterface.set(neighbor.localInterface, stackIndex + 1);
            });
        }
    }

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
                nodePositions[bridgeMappingNodeId(mapping.localnet)] = { x: padding + (colOffset * colSpacing), y: currentY };
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
                // One key per edge: edgeKey normalises direction, so the reverse
                // spelling this used to add "for safety" is no longer needed.
                path.add(edgeKey(nodeId, nextId));
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
        showLldpColumn ? lldpNeighbors.length : 0,
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
                stroke={isHighlightActive ? (highlightedPath.has(edgeKey(startNode, endNode)) ? '#0066CC' : '#ccc') : 'currentColor'}
                strokeWidth={isHighlightActive ? (highlightedPath.has(edgeKey(startNode, endNode)) ? 4 : 1) : 2}
                opacity={isHighlightActive ? (highlightedPath.has(edgeKey(startNode, endNode)) ? 1 : 0.1) : 1}
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

    const drawerTabsById = React.useMemo(() => buildDrawerTabs(ctx), [ctx]);

    // Drawer selection state
    const [activeNode, setActiveNode] = React.useState<NodeViewModel | null>(null);
    const [activePopoverTab, setActivePopoverTab] = React.useState<DrawerTabId>('summary');

    const handleNodeClick = (event: React.MouseEvent, node: NodeViewModel) => {
        event.stopPropagation(); // Prevent clearing highlight when clicking a node

        const wasDrawerOpen = activeNode !== null;

        setActiveNode(node);

        if (!wasDrawerOpen) {
            setActivePopoverTab(getDrawerTabsForNode(node, drawerTabsById)[0]?.id || 'summary');
        }

        // Highlight Path
        const path = getFlowPath(node.id);
        setHighlightedPath(path);
        setIsHighlightActive(true);
    };

    const handleBackgroundClick = () => {
        handlePopoverClose();
    };

    /**
     * Clearing the selection must clear the highlight with it. The drawer's close
     * button used to drop only activeNode, leaving the graph dimmed with nothing
     * selected and no way to tell why short of clicking the background.
     */
    const handlePopoverClose = () => {
        setActiveNode(null);
        setIsHighlightActive(false);
        setHighlightedPath(new Set());
    };






    const activeNodeTabs = React.useMemo(
        () => (activeNode ? getDrawerTabsForNode(activeNode, drawerTabsById) : []),
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
        const viewNode = buildNodeViewModel(iface, type, ctx);
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
                <rect width={itemWidth} height={nodeHeight} rx={5} fill={color} stroke="var(--pf-t--global--border--color--default)" strokeWidth={1} />
                <foreignObject x={10} y={10} width={20} height={20}>
                    <div style={{ color: '#fff' }}>{Icon}</div>
                </foreignObject>
                <text x={35} y={25} fontSize="12" fontWeight="bold" fill="#fff">{displayName}</text>
                <text x={10} y={45} fontSize="10" fill="#eee">{displayType}</text>
                {type !== 'attachment' && displayState && <text x={10} y={60} fontSize="10" fill="#eee">{displayState}</text>}
                {extraInfo}
                {type !== 'ovn-mapping' && type !== 'cudn' && type !== 'udn' && type !== 'attachment' && type !== 'lldp-neighbor' && (
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
                        <Flex alignItems={{ default: 'alignItemsCenter' }} spaceItems={{ default: 'spaceItemsSm' }}>
                            <FlexItem>
                                <span style={{ display: 'inline-flex' }}>
                                    {activeNode ? getIcon(activeNode.iconType) : null}
                                </span>
                            </FlexItem>
                            <FlexItem>
                                <Title headingLevel="h2" size="xl">
                                    {activeNode?.title}
                                </Title>
                            </FlexItem>
                        </Flex>
                    </FlexItem>
                    <FlexItem>
                        {activeNode?.subtitle && <span style={{ color: 'var(--pf-t--global--text--color--subtle)', fontSize: '0.9em' }}>{activeNode.subtitle}</span>}
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
                                        onChange={(first, second) => setShowNads(getSwitchChecked(first, second))}
                                    />
                                </FlexItem>
                                {hasLldpData && (
                                    <FlexItem>
                                        <Switch
                                            id="show-lldp-neighbors-toggle"
                                            label="Show LLDP neighbors"
                                            isChecked={showLldpNeighbors}
                                            onChange={(first, second) => setShowLldpNeighbors(getSwitchChecked(first, second))}
                                        />
                                    </FlexItem>
                                )}
                                <FlexItem>
                                    <Switch
                                        id="show-hidden-columns-toggle"
                                        label="Show hidden columns"
                                        isChecked={showHiddenColumns}
                                        onChange={(first, second) => setShowHiddenColumns(getSwitchChecked(first, second))}
                                    />
                                </FlexItem>
                            </Flex>
                            <svg
                                ref={svgContainerRef}
                                width="100%"
                                height={calculatedHeight}
                                viewBox={viewBox ? `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}` : `0 0 ${width} ${calculatedHeight}`}
                                preserveAspectRatio="xMinYMin meet"
                                style={{
                                    border: '1px solid var(--pf-t--global--border--color--default)',
                                    background: 'var(--pf-t--global--background--color--secondary--default)',
                                    color: 'var(--pf-t--global--text--color--regular)',
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
                                {topologyEdges.map((edge: TopologyEdge) => (
                                    <React.Fragment key={`edge-${edge.source}-${edge.target}`}>
                                        {renderConnector(edge.source, edge.target)}
                                    </React.Fragment>
                                ))}

                                {/* Render visible columns dynamically */}
                                {visibleColumns.map((col, idx) => {
                                    const xPos = padding + (idx * colSpacing);
                                    return (
                                        <React.Fragment key={col.key}>
                                            {col.key !== 'l3' && <text x={xPos} y={padding - 10} fontWeight="bold" fill="currentColor">{col.name}</text>}
                                            {col.key === 'lldp' && sortedLldpNeighbors
                                                .filter((neighbor: LldpNeighborNode) => nodePositions[neighbor.id])
                                                .map((neighbor: LldpNeighborNode) => {
                                                    const pos = nodePositions[neighbor.id];
                                                    return (
                                                        <React.Fragment key={neighbor.id}>
                                                            {renderInterfaceNode(neighbor, pos.x, pos.y, '#2E7D32', 'lldp-neighbor')}
                                                        </React.Fragment>
                                                    );
                                                })}
                                            {col.key === 'eth' && sortedEthInterfaces
                                                .filter((iface: Interface) => nodePositions[resolveNodeId(iface, iface.type)])
                                                .map((iface: Interface) => {
                                                    const pos = nodePositions[resolveNodeId(iface, iface.type)];
                                                    return (
                                                        <React.Fragment key={resolveNodeId(iface, iface.type)}>
                                                            {renderInterfaceNode(iface, pos.x, pos.y, '#0066CC')}
                                                        </React.Fragment>
                                                    );
                                                })}
                                            {col.key === 'bond' && sortedBondInterfaces
                                                .filter((iface: Interface) => nodePositions[resolveNodeId(iface, iface.type)])
                                                .map((iface: Interface) => {
                                                    const pos = nodePositions[resolveNodeId(iface, iface.type)];
                                                    return (
                                                        <React.Fragment key={resolveNodeId(iface, iface.type)}>
                                                            {renderInterfaceNode(iface, pos.x, pos.y, '#663399')}
                                                        </React.Fragment>
                                                    );
                                                })}
                                            {col.key === 'vlan' && sortedVlanInterfaces
                                                .filter((iface: Interface) => nodePositions[resolveNodeId(iface, iface.type)])
                                                .map((iface: Interface) => {
                                                    const pos = nodePositions[resolveNodeId(iface, iface.type)];
                                                    return (
                                                        <React.Fragment key={resolveNodeId(iface, iface.type)}>
                                                            {renderInterfaceNode(iface, pos.x, pos.y, '#9933CC')}
                                                        </React.Fragment>
                                                    );
                                                })}
                                            {col.key === 'bridge' && sortedBridgeInterfaces
                                                .filter((iface: Interface) => nodePositions[resolveNodeId(iface, iface.type)])
                                                .map((iface: Interface) => {
                                                    const pos = nodePositions[resolveNodeId(iface, iface.type)];
                                                    return (
                                                        <React.Fragment key={resolveNodeId(iface, iface.type)}>
                                                            {renderInterfaceNode(iface, pos.x, pos.y, '#FF6600')}
                                                        </React.Fragment>
                                                    );
                                                })}
                                            {col.key === 'logical' && sortedLogicalInterfaces
                                                .filter((iface: Interface) => nodePositions[resolveNodeId(iface, iface.type)])
                                                .map((iface: Interface) => {
                                                    const pos = nodePositions[resolveNodeId(iface, iface.type)];
                                                    return (
                                                        <React.Fragment key={resolveNodeId(iface, iface.type)}>
                                                            {renderInterfaceNode(iface, pos.x, pos.y, '#0099CC')}
                                                        </React.Fragment>
                                                    );
                                                })}
                                            {col.key === 'l3' && (
                                                <>
                                                    {/* Bridge Mappings Section */}
                                                    <text x={xPos} y={padding - 10} fontWeight="bold" fill="currentColor">Bridge Mappings</text>
                                                    {sortedBridgeMappings
                                                        .filter((mapping: OvnBridgeMapping) => nodePositions[bridgeMappingNodeId(mapping.localnet)])
                                                        .map((mapping: OvnBridgeMapping) => {
                                                            // Bridge mappings and VRFs share this lane as two stacked
                                                            // sub-groups, kept apart by their group rank in computeNodeOrder.
                                                            const pos = nodePositions[bridgeMappingNodeId(mapping.localnet)];
                                                            return (
                                                                <React.Fragment key={bridgeMappingNodeId(mapping.localnet)}>
                                                                    {renderInterfaceNode(mapping, pos.x, pos.y, '#009900', 'ovn-mapping')}
                                                                </React.Fragment>
                                                            );
                                                        })}

                                                    {/* VRFs Section Header - Position it above the first VRF node */}
                                                    {(() => {
                                                        const firstVrf = sortedVrfInterfaces.find(iface => nodePositions[resolveNodeId(iface, iface.type)]);
                                                        if (firstVrf) {
                                                            const pos = nodePositions[resolveNodeId(firstVrf, firstVrf.type)];
                                                            // Draw header slightly above the first VRF node
                                                            return <text x={xPos} y={pos.y - 15} fontWeight="bold" fill="currentColor">VRFs</text>;
                                                        }
                                                        return null;
                                                    })()}

                                                    {sortedVrfInterfaces
                                                        .filter((iface: Interface) => nodePositions[resolveNodeId(iface, iface.type)])
                                                        .map((iface: Interface) => {
                                                            const pos = nodePositions[resolveNodeId(iface, iface.type)];
                                                            return (
                                                                <React.Fragment key={iface.name}>
                                                                    {renderInterfaceNode(iface, pos.x, pos.y, '#CC6600', 'vrf')}
                                                                </React.Fragment>
                                                            );
                                                        })}
                                                </>
                                            )}
                                            {col.key === 'cudn' && sortedNetworkItems
                                                .filter((n: NetworkColumnItem) => nodePositions[getNetworkNodeId(n)])
                                                .map((n: NetworkColumnItem) => {
                                                    const pos = nodePositions[getNetworkNodeId(n)];
                                                    const color = n.kind === 'cudn' ? CUDN_NODE_COLOR : UDN_NODE_COLOR;
                                                    return (
                                                        <React.Fragment key={getNetworkNodeId(n)}>
                                                            {renderInterfaceNode(n.item, pos.x, pos.y, color, n.kind)}
                                                        </React.Fragment>
                                                    );
                                                })}
                                        </React.Fragment>
                                    );
                                })}

                                {/* Layer 7: Attachments (from CUDN status) */}
                                <text x={padding + (attachmentColOffset * colSpacing)} y={padding - 10} fontWeight="bold" fill="currentColor">Attachments</text>
                                {sortedAttachmentNodes.map((node: AttachmentNode) => {
                                    const pos = nodePositions[getAttachmentNodeId(node)];
                                    return (
                                        <React.Fragment key={getAttachmentNodeId(node)}>
                                            {pos && renderInterfaceNode(node, pos.x, pos.y, '#F0AB00', 'attachment', getAttachmentHeight(node))}
                                        </React.Fragment>
                                    );
                                })}

                                {showNads && (
                                    <>
                                        <text x={padding + (nadColOffset * colSpacing)} y={padding - 10} fontWeight="bold" fill="currentColor">NADs</text>
                                        {sortedNads.map((nad: NetworkAttachmentDefinition) => (
                                            <React.Fragment key={getNadNodeId(nad)}>
                                                {nodePositions[getNadNodeId(nad)] && renderInterfaceNode(nad, nodePositions[getNadNodeId(nad)].x, nodePositions[getNadNodeId(nad)].y, '#CC9900', 'nad')}
                                            </React.Fragment>
                                        ))}
                                    </>
                                )}

                                {/* Layer 8: Others */}
                                <text x={padding} y={calculatedHeight - 150} fontWeight="bold" fill="currentColor">Other Interfaces</text>
                                <g transform={`translate(${padding}, ${calculatedHeight - 140})`}>
                                    {sortedOtherInterfaces.map((iface: Interface, index: number) => {
                                        const col = index % 4;
                                        const row = Math.floor(index / 4);
                                        return (
                                            <React.Fragment key={resolveNodeId(iface, iface.type)}>
                                                {renderInterfaceNode(iface, col * (itemWidth + 20), row * (itemHeight + 20), '#666')}
                                            </React.Fragment>
                                        );
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
                                    <span style={{ fontSize: '0.9em', color: 'var(--pf-t--global--text--color--subtle)' }}>
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
