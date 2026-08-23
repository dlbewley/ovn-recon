import * as React from 'react';
import { Card, CardBody, CardTitle, Drawer, DrawerPanelContent, DrawerContent, DrawerContentBody, DrawerHead, DrawerActions, DrawerCloseButton, Title, Switch, Tabs, Tab, TabTitleText, Flex, FlexItem, Button, FormSelect, FormSelectOption } from '@patternfly/react-core';
import { useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';


import { NodeNetworkState, ClusterUserDefinedNetwork, UserDefinedNetwork, Interface, NetworkAttachmentDefinition, RouteAdvertisements } from '../types';
import { hasLldpNeighbors } from './nodeVisualizationSelectors';
import { buildTopologyEdges, TopologyEdge } from './nodeVisualizationModel';
import { buildGraphContext, GraphContext } from '../topology/context';
import { interfacesWithRole, roleOf } from '../topology/classify';
import { buildDrawerTabs, getDrawerTabsForNode } from '../topology/drawerTabs';
import { edgeKey, findDuplicateIds, resolveNodeId as resolveId } from '../topology/ids';
import {
    DrawerTabId, Graph, NodeViewModel
} from '../topology/types';
import { buildNodeViewModel } from '../topology/viewModel';
import { computeNodeOrder, sortByRank } from './nodeVisualizationLayout';
import { laneOrderingInput, layoutLanes, LaneViewState, PlacedNode } from '../topology/lanes';
import { descriptorFor, iconFor, NodeTypeId, NODE_TYPES } from '../topology/descriptors';

interface NodeVisualizationProps {
    nns: NodeNetworkState;
    cudns?: ClusterUserDefinedNetwork[];
    udns?: UserDefinedNetwork[];
    nads?: NetworkAttachmentDefinition[];
    routeAdvertisements?: RouteAdvertisements[];
}

const NodeVisualization: React.FC<NodeVisualizationProps> = ({ nns, cudns = [], udns = [], nads = [], routeAdvertisements = [] }) => {



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
    const { interfaces } = ctx;
    const { lldpNeighbors } = ctx;
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
    // The catch-all grid at the foot of the canvas. 'unclassified' landing here is a
    // prompt to add a rule, not a resting place.
    const otherInterfaces = ctx.interfaces.filter((iface) =>
        ['host-local', 'unclassified'].includes(roleOf(iface, ctx)));

    const laneView: LaneViewState = { showHiddenColumns, showNads, showLldp: showLldpColumn };

    const { edges: topologyEdges, unresolved } = buildTopologyEdges(ctx, laneView);

    // Lanes fed to the ordering pass. Left-to-right order must match `columns` plus
    // the two trailing pseudo-columns, since a node's barycenter is the average
    // position of its neighbours in adjacent lanes.
    // Note the l3 lane holds two stacked groups (bridge mappings above VRFs) and the
    // networks lane holds CUDNs above UDNs; both are expressed as group ranks below
    // rather than as ordering hacks inside the layout module.
    // Ordering input comes from the same table the layout uses, so the two cannot drift.
    // Group order within a lane supplies the group rank -- bridge mappings above VRFs,
    // CUDNs above UDNs -- which used to be written out longhand, by name.
    const ordering = laneOrderingInput(ctx, laneView);
    const rankById = computeNodeOrder({
        lanes: ordering.lanes,
        edges: topologyEdges,
        groupRankById: ordering.groupRankById
    });

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
        // Every id the graph can draw, gathered from the descriptor table so a new node
        // type is covered without touching this.
        const duplicates = findDuplicateIds(
            NODE_TYPES.flatMap((descriptor) =>
                descriptor.items(ctx).map((item: unknown) => descriptor.id(item, ctx)))
        );
        if (duplicates.length > 0) {
             
            console.warn(`[ovn-recon] duplicate node ids, which will draw on top of each other: ${duplicates.join(', ')}`);
        }
    }, [ctx]);

    /**
     * LLDP neighbours do not stack from the top of their lane: each aligns with the
     * physical interface it was seen on, and several on one interface fan downwards.
     * The lane table marks this a custom layout rather than pretending it is a stack.
     */
    const lldpDescriptor = descriptorFor('lldp-neighbor')!;
    const otherDescriptor = descriptorFor('other')!;

    /**
     * Icon for the drawer header. Comes off the same descriptor the canvas uses, so the
     * panel and the node can never show different pictures for the same thing.
     */
    const drawerIcon = (node: NodeViewModel) => {
        const descriptor = descriptorFor(node.iconType as NodeTypeId);
        return descriptor ? iconFor(descriptor, node.raw) : null;
    };
    const placeLldpNeighbors = (x: number): PlacedNode[] => {
        const anchorY = new Map<string, number>();
        sortByRank(interfacesWithRole(ctx, 'physical'), (i) => resolveNodeId(i, i.type), rankById)
            .forEach((iface, index) => anchorY.set(iface.name, padding + index * (itemHeight + 20)));

        const depthByInterface = new Map<string, number>();
        return sortByRank(lldpNeighbors, (n) => n.id, rankById).map((neighbor, index) => {
            const depth = depthByInterface.get(neighbor.localInterface) ?? 0;
            const anchor = anchorY.get(neighbor.localInterface);
            depthByInterface.set(neighbor.localInterface, depth + 1);
            return {
                id: neighbor.id, item: neighbor, descriptor: lldpDescriptor, laneId: 'lldp', x,
                y: anchor != null ? anchor + depth * 24 : padding + index * (itemHeight + 20),
                height: itemHeight, color: lldpDescriptor.color
            };
        });
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

    const laneLayout = layoutLanes(
        ctx, laneView,
        { padding, itemHeight, itemGap: 20, colSpacing },
        rankById,
        (laneId, x) => (laneId === 'lldp' ? placeLldpNeighbors(x) : null)
    );
    const nodePositions = laneLayout.positions;

    // The catch-all grid sits below every lane, four across.
    const otherGridRows = Math.ceil(otherInterfaces.length / 4) + 2;
    const calculatedHeight = Math.max(
        600,
        laneLayout.maxY + 100,
        padding + otherGridRows * (itemHeight + 20) + 200
    );

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

     
    /**
     * Draw one placed node. Every per-type decision -- icon, colour, label, status dot,
     * extra content -- comes off its descriptor, so this has no knowledge of what it is
     * drawing.
     */
    const renderNode = (node: PlacedNode) => {
        const { descriptor, item } = node;
        const viewNode = buildNodeViewModel(item, descriptor, ctx);
        const displayType = viewNode.graphDisplayLabel || viewNode.subtitle;
        const status = descriptor.status?.(item);

        return (
            <g
                transform={`translate(${node.x}, ${node.y})`}
                style={{ cursor: 'pointer', opacity: isHighlightActive ? (highlightedPath.has(viewNode.id) ? 1 : 0.3) : 1 }}
                onClick={(e) => handleNodeClick(e, viewNode)}
            >
                <title>{viewNode.label} ({displayType})</title>
                <rect
                    width={itemWidth}
                    height={node.height}
                    rx={5}
                    fill={descriptor.color}
                    stroke="var(--pf-t--global--border--color--default)"
                    strokeWidth={1}
                />
                <foreignObject x={10} y={10} width={20} height={20}>
                    <div style={{ color: '#fff' }}>{iconFor(descriptor, item)}</div>
                </foreignObject>
                <text x={35} y={25} fontSize="12" fontWeight="bold" fill="#fff">{viewNode.label}</text>
                <text x={10} y={45} fontSize="10" fill="#eee">{displayType}</text>
                {!descriptor.detail && viewNode.state && (
                    <text x={10} y={60} fontSize="10" fill="#eee">{viewNode.state}</text>
                )}
                {descriptor.detail?.(item, { width: itemWidth, height: node.height })}
                {status && (
                    <circle cx={itemWidth - 15} cy={15} r={5} fill={status === 'up' ? '#4CAF50' : '#F44336'} />
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
                                    {activeNode ? drawerIcon(activeNode) : null}
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

                                {/*
                                  * One pass over the placed lanes. This replaced sixteen
                                  * branches keyed on a column name, each of which had to
                                  * repeat the filter, the position lookup and the colour.
                                  */}
                                {laneLayout.lanes.map(({ lane, x, groups }) => (
                                    <React.Fragment key={lane.id}>
                                        {lane.title && (
                                            <text x={x} y={padding - 10} fontWeight="bold" fill="currentColor">
                                                {lane.title}
                                            </text>
                                        )}
                                        {groups.map((group, groupIndex) => (
                                            <React.Fragment key={group.title ?? groupIndex}>
                                                {group.title && group.nodes.length > 0 && (
                                                    <text x={x} y={group.nodes[0].y - 15} fontWeight="bold" fill="currentColor">
                                                        {group.title}
                                                    </text>
                                                )}
                                                {group.nodes.map((node) => (
                                                    <React.Fragment key={node.id}>
                                                        {renderNode(node)}
                                                    </React.Fragment>
                                                ))}
                                            </React.Fragment>
                                        ))}
                                    </React.Fragment>
                                ))}

                                {/* Layer 8: Others */}
                                <text x={padding} y={calculatedHeight - 150} fontWeight="bold" fill="currentColor">Other Interfaces</text>
                                <g transform={`translate(${padding}, ${calculatedHeight - 140})`}>
                                    {sortedOtherInterfaces.map((iface: Interface, index: number) => (
                                        <React.Fragment key={resolveNodeId(iface, iface.type)}>
                                            {renderNode({
                                                id: resolveNodeId(iface, iface.type),
                                                item: iface,
                                                descriptor: otherDescriptor,
                                                laneId: 'other',
                                                x: (index % 4) * (itemWidth + 20),
                                                y: Math.floor(index / 4) * (itemHeight + 20),
                                                height: itemHeight,
                                                color: otherDescriptor.color
                                            })}
                                        </React.Fragment>
                                    ))}
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
