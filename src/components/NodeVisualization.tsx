import * as React from 'react';
import { Card, CardBody, CardTitle, Drawer, DrawerPanelContent, DrawerContent, DrawerContentBody, DrawerHead, DrawerActions, DrawerCloseButton, Title, Switch, Tabs, Tab, TabTitleText, Flex, FlexItem, Button, FormSelect, FormSelectOption } from '@patternfly/react-core';
import { useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';


import { NodeNetworkState, ClusterUserDefinedNetwork, UserDefinedNetwork, NetworkAttachmentDefinition, NodeNetworkConfigurationEnactment, RouteAdvertisements } from '../types';
import { hasLldpNeighbors } from './nodeVisualizationSelectors';
import { buildTopologyEdges, TopologyEdge } from './nodeVisualizationModel';
import { buildGraphContext, GraphContext } from '../topology/context';
import { interfacesWithRole, roleOf } from '../topology/classify';
import { buildDrawerTabs, getDrawerTabs } from '../topology/drawerTabs';
import { edgeKey, findDuplicateIds, resolveNodeId as resolveId } from '../topology/ids';
import {
    DrawerTabId, Graph, NodeViewModel
} from '../topology/types';
import { buildNodeViewModel } from '../topology/viewModel';
import { computeEdgeBow, computeNodeOrder, sortByRank } from './nodeVisualizationLayout';
import { laneOrderingInput, layoutLanes, LaneViewState, PlacedNode } from '../topology/lanes';
import { descriptorFor, iconFor, NodeTypeId, NODE_TYPES } from '../topology/descriptors';

interface NodeVisualizationProps {
    nns: NodeNetworkState;
    cudns?: ClusterUserDefinedNetwork[];
    udns?: UserDefinedNetwork[];
    nads?: NetworkAttachmentDefinition[];
    routeAdvertisements?: RouteAdvertisements[];
    enactments?: NodeNetworkConfigurationEnactment[];
}

/** Pointer travel, in CSS pixels, before a press on the background counts as a pan rather than a click. */
const PAN_DRAG_THRESHOLD_PX = 3;

const NodeVisualization: React.FC<NodeVisualizationProps> = ({ nns, cudns = [], udns = [], nads = [], routeAdvertisements = [], enactments = [] }) => {



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
        () => buildGraphContext({ nns, cudns, udns, nads, routeAdvertisements, enactments }),
        [nns, cudns, udns, nads, routeAdvertisements, enactments]
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
    /**
     * Where the current press began. A press that never travels further than
     * PAN_DRAG_THRESHOLD_PX from here is a click, not a pan: the view stays put
     * and the click still reaches handleBackgroundClick to close the drawer.
     */
    const panOrigin = React.useRef<{ x: number; y: number } | null>(null);
    const [zoomLevel, setZoomLevel] = React.useState<number>(1);
    const svgContainerRef = React.useRef<SVGSVGElement | null>(null);

    // Simple layout logic
    const baseWidth = 1600;
    // const height = 800; // Unused
    // Room above the lane headers: they draw at padding - 10, and used to sit
    // 10px from the viewport edge (ovn-recon-s3t.45).
    const padding = 40;
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
        (laneId, x) => (laneId === 'lldp' ? placeLldpNeighbors(x) : null),
        topologyEdges
    );
    const nodePositions = laneLayout.positions;

    // The catch-all grid, placed here rather than inline in the JSX so selection can
    // look these nodes up the same way it looks up laned ones.
    const otherGridNodes: PlacedNode[] = sortedOtherInterfaces.map((iface, index) => ({
        id: resolveNodeId(iface, iface.type),
        item: iface,
        descriptor: otherDescriptor,
        laneId: 'other',
        x: (index % 4) * (itemWidth + 20),
        y: Math.floor(index / 4) * (itemHeight + 20),
        height: itemHeight,
        color: otherDescriptor.color
    }));

    /**
     * Every node the canvas is currently drawing, by id. This is what the drawer
     * selection resolves against, so the drawer can only ever describe something
     * that is on screen, built from the resources of this render.
     */
    const placedNodeById = new Map<string, PlacedNode>();
    laneLayout.lanes.forEach(({ groups }) =>
        groups.forEach((group) => group.nodes.forEach((node) => placedNodeById.set(node.id, node))));
    otherGridNodes.forEach((node) => placedNodeById.set(node.id, node));

    // The default view must hold every visible lane: with the OVN lane added,
    // a fixed 1600 clipped the right-hand lanes (ovn-recon-s3t.46).
    const width = Math.max(
        baseWidth,
        Math.max(0, ...laneLayout.lanes.map((lane) => lane.x)) + itemWidth + padding
    );

    // The catch-all grid sits below every lane, four across.
    const otherGridRows = Math.ceil(otherInterfaces.length / 4) + 2;
    const calculatedHeight = Math.max(
        600,
        laneLayout.maxY + 100,
        padding + otherGridRows * (itemHeight + 20) + 200
    );

    /**
     * True once the user has panned, zoomed, or been centered by drawer
     * navigation. Until then the viewBox tracks the canvas size, so toggling a
     * column that GROWS the canvas (NADs, LLDP) does not clip the new content
     * -- previously only the Reset button recovered from that.
     */
    const userAdjustedView = React.useRef<boolean>(false);
    React.useEffect(() => {
        if (!userAdjustedView.current && calculatedHeight > 0) {
            setViewBox({ x: 0, y: 0, width, height: calculatedHeight });
            setZoomLevel(1);
        }
    }, [calculatedHeight, width]);


    /**
     * Draw one connector, styled by what the relationship MEANS.
     *
     * A reference edge is dashed and undirected: a bridge mapping is the name OVN uses
     * for a bridge, and nothing flows through it. Drawing it identically to a NIC
     * enslaved to that bridge is what made the graph read as a traffic path it is not.
     * Membership, layering and peer edges are all real links and stay solid.
     *
     * Provenance is a second axis (ovn-recon-s3t.30): the dash says what the edge
     * IS, the fade says how much to trust it. An inferred edge -- a name match, a
     * subnet containment -- draws fainter than an observed one of the same kind,
     * and its tooltip is the rationale rather than the bare rule.
     */
    const renderConnector = (edge: TopologyEdge) => {
        const start = nodePositions[edge.source];
        const end = nodePositions[edge.target];
        if (!start || !end) return null;

        const highlighted = highlightedPath.has(edgeKey(edge.source, edge.target));
        const isReference = edge.kind === 'reference';
        const isInferred = edge.provenance === 'inferred';
        const stroke = isHighlightActive ? (highlighted ? '#0066CC' : '#ccc') : 'currentColor';
        const strokeWidth = isHighlightActive ? (highlighted ? 4 : 1) : 2;
        const dashArray = isReference ? '6 4' : undefined;
        const opacity = isHighlightActive
            ? (highlighted ? 1 : 0.1)
            : (isInferred ? 0.4 : isReference ? 0.65 : 1);
        const appearance = {
            stroke,
            strokeWidth,
            strokeDasharray: dashArray,
            opacity,
            'data-provenance': edge.provenance,
            'data-rule': edge.rule
        };

        // Two nodes in ONE lane -- br-ex and br-int, cabled by their patch pair --
        // connect by an arc bulging into the gutter beside the lane, since a
        // straight line would run vertically through the lane (ovn-recon-s3t.48).
        if (start.x === end.x) {
            const x = start.x + itemWidth;
            const y1 = start.y + itemHeight / 2;
            const y2 = end.y + itemHeight / 2;
            return (
                <path
                    key={`${edge.source}-${edge.target}`}
                    d={`M ${x} ${y1} Q ${x + 45} ${(y1 + y2) / 2} ${x} ${y2}`}
                    fill="none"
                    {...appearance}
                >
                    <title>{edge.rationale}</title>
                </path>
            );
        }

        const from = { x: start.x + itemWidth, y: start.y + itemHeight / 2 };
        const to = { x: end.x, y: end.y + itemHeight / 2 };

        // A lane-skipping edge must not run THROUGH a node in a lane it crosses:
        // aligned children sit exactly on their parent's sight-line, and a straight
        // segment behind one reads as a chain that does not exist (s3t.49).
        const obstacles = Array.from(placedNodeById.values())
            .filter((node) => node.id !== edge.source && node.id !== edge.target)
            .map((node) => ({ x: node.x, y: node.y, width: itemWidth, height: node.height }));
        const bow = computeEdgeBow(from, to, obstacles);
        if (bow) {
            return (
                <path
                    key={`${edge.source}-${edge.target}`}
                    d={`M ${from.x} ${from.y} Q ${bow.controlX} ${bow.controlY} ${to.x} ${to.y}`}
                    fill="none"
                    {...appearance}
                >
                    <title>{edge.rationale}</title>
                </path>
            );
        }

        return (
            <line
                key={`${edge.source}-${edge.target}`}
                x1={from.x} y1={from.y}
                x2={to.x} y2={to.y}
                {...appearance}
            >
                <title>{edge.rationale}</title>
            </line>
        );
    };


    // Pan/Zoom handlers
    const handleZoom = (delta: number, clientX?: number, clientY?: number) => {
        if (!viewBox || !svgContainerRef.current) return;
        userAdjustedView.current = true;

        const svgRect = svgContainerRef.current.getBoundingClientRect();
        const zoomFactor = delta > 0 ? 1.1 : 0.9;
        const newZoom = Math.max(0.1, Math.min(5, zoomLevel * zoomFactor));

        if (clientX !== undefined && clientY !== undefined && svgRect.width > 0 && svgRect.height > 0) {
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

    /**
     * Ctrl/Cmd + wheel zooms; a plain wheel scrolls the page normally.
     *
     * This must be a NATIVE listener registered non-passive: React attaches
     * wheel at the root as passive, so calling preventDefault on the synthetic
     * event logged an error and did nothing -- and it tried to preventDefault
     * even for plain scrolling, which was the wrong intent anyway.
     */
    const wheelZoomRef = React.useRef<(event: WheelEvent) => void>(() => undefined);
    wheelZoomRef.current = (event: WheelEvent) => {
        if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            handleZoom(-event.deltaY, event.clientX, event.clientY);
        }
    };
    React.useEffect(() => {
        const svg = svgContainerRef.current;
        if (!svg) return undefined;
        const listener = (event: WheelEvent) => wheelZoomRef.current(event);
        svg.addEventListener('wheel', listener, { passive: false });
        return () => svg.removeEventListener('wheel', listener);
    }, []);

    const handleMouseDown = (event: React.MouseEvent<SVGSVGElement>) => {
        // Don't pan if clicking on a node (g element)
        const target = event.target as HTMLElement;
        if (target && (target.tagName === 'g' || target.closest('g'))) {
            return; // Let node click handler deal with it
        }

        // A plain left drag pans, matching the logical topology view. Shift used
        // to be required here and nowhere else, which read as the view being
        // stuck (ovn-recon-4mq). Middle button pans too.
        if (event.button === 0 || event.button === 1) {
            event.preventDefault();
            setIsPanning(true);
            setPanStart({ x: event.clientX, y: event.clientY });
            panOrigin.current = { x: event.clientX, y: event.clientY };
        }
    };

    /**
     * A pan drag that ends over the background must not read as a background
     * CLICK -- it used to close the drawer. The flag is set by any pan movement
     * and consumed by the click handler that follows the mouseup.
     */
    const suppressBackgroundClick = React.useRef<boolean>(false);

    const handleMouseMove = (event: React.MouseEvent<SVGSVGElement>) => {
        if (isPanning && panStart && viewBox) {
            // Now that every left press starts a pan, a click with a pixel of
            // jitter must not become a pan that swallows the deselect. The
            // gesture is a click until it has clearly travelled.
            if (!suppressBackgroundClick.current && panOrigin.current) {
                const travelled = Math.hypot(
                    event.clientX - panOrigin.current.x,
                    event.clientY - panOrigin.current.y
                );
                if (travelled < PAN_DRAG_THRESHOLD_PX) return;
            }
            userAdjustedView.current = true;
            suppressBackgroundClick.current = true;
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
        panOrigin.current = null;
    };

    const handleZoomIn = () => handleZoom(1);
    const handleZoomOut = () => handleZoom(-1);
    const handleResetZoom = () => {
        // Back to the untouched state: the viewBox resumes tracking canvas growth.
        userAdjustedView.current = false;
        setViewBox({ x: 0, y: 0, width, height: calculatedHeight });
        setZoomLevel(1);
    };

    /**
     * The drawer stores WHICH node is selected, never what it looked like. The view
     * model is rebuilt from the current watch data on every render, so an edit to a
     * watched resource reaches an open drawer without reselecting the node -- the
     * snapshot it used to hold is the staleness this replaces (ovn-recon-s3t.4).
     */
    const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null);
    const [activePopoverTab, setActivePopoverTab] = React.useState<DrawerTabId>('overview');
    // Keyboard focus, drawn as a ring on the node rect. Tab order is the render
    // order -- lane by lane, top to bottom -- which matches visual reading order.
    const [focusedNodeId, setFocusedNodeId] = React.useState<string | null>(null);

    const selectedPlacedNode = selectedNodeId ? placedNodeById.get(selectedNodeId) : undefined;
    const activeNode: NodeViewModel | null = selectedPlacedNode
        ? buildNodeViewModel(selectedPlacedNode.item, selectedPlacedNode.descriptor, ctx)
        : null;

    /** Select a node and light its flow path -- shared by canvas clicks and the
     * Relationships tab, so navigating from the drawer behaves like clicking. */
    const selectNode = (id: string) => {
        setSelectedNodeId(id);
        setHighlightedPath(getFlowPath(id));
        setIsHighlightActive(true);
    };

    /** A node's absolute canvas position: laned nodes come off the layout, the
     * catch-all grid nodes carry grid-relative coordinates and need its origin. */
    const absolutePositionOf = (id: string): { x: number; y: number } | undefined => {
        if (nodePositions[id]) return nodePositions[id];
        const placed = placedNodeById.get(id);
        if (placed?.laneId === 'other') {
            return { x: padding + placed.x, y: calculatedHeight - 140 + placed.y };
        }
        return undefined;
    };

    /**
     * Pan the view to center a node, keeping the zoom. Only drawer navigation
     * does this: a hyperlink changes the node under review invisibly -- often to
     * one hidden behind the drawer -- while a canvas click is on something the
     * user can already see, and yanking the view then would be disorienting.
     */
    const centerViewOn = (id: string) => {
        const position = absolutePositionOf(id);
        if (!position) return;
        userAdjustedView.current = true;
        const viewWidth = viewBox?.width ?? width;
        const viewHeight = viewBox?.height ?? calculatedHeight;
        setViewBox({
            x: position.x + itemWidth / 2 - viewWidth / 2,
            y: position.y + itemHeight / 2 - viewHeight / 2,
            width: viewWidth,
            height: viewHeight
        });
    };

    // Rebuilt each render: the Relationships tab must see the edges of the
    // CURRENT view (lane toggles change them), and closures capture live state.
    // Only edges with both endpoints drawn: the canvas skips the others too, and
    // navigating to an undrawn node would just clear the selection.
    const drawerTabsById = buildDrawerTabs(ctx, {
        edges: topologyEdges.filter(
            (edge) => placedNodeById.has(edge.source) && placedNodeById.has(edge.target)),
        labelFor: (id) => {
            const placed = placedNodeById.get(id);
            return placed ? placed.descriptor.present(placed.item, ctx).label : id;
        },
        onSelectNode: (id) => {
            selectNode(id);
            centerViewOn(id);
        }
    });

    const handleNodeClick = (event: React.SyntheticEvent, id: string) => {
        event.stopPropagation(); // Prevent clearing highlight when clicking a node

        const wasDrawerOpen = selectedNodeId !== null;
        selectNode(id);
        if (!wasDrawerOpen) {
            setActivePopoverTab('overview');
        }
    };

    const handleBackgroundClick = () => {
        // The click after a pan drag is the drag ending, not a deselection.
        if (suppressBackgroundClick.current) {
            suppressBackgroundClick.current = false;
            return;
        }
        handlePopoverClose();
    };

    /**
     * Clearing the selection must clear the highlight with it. The drawer's close
     * button used to drop only activeNode, leaving the graph dimmed with nothing
     * selected and no way to tell why short of clicking the background.
     */
    const handlePopoverClose = () => {
        setSelectedNodeId(null);
        setIsHighlightActive(false);
        setHighlightedPath(new Set());
    };

    /**
     * A selected node can stop being rendered out from under the selection: its
     * resource is deleted, or a toggle hides its lane. Clear the whole selection so
     * the graph is not left dimmed against a drawer that has already closed.
     */
    const selectionVanished = selectedNodeId !== null && !selectedPlacedNode;
    React.useEffect(() => {
        if (selectionVanished) {
            setSelectedNodeId(null);
            setIsHighlightActive(false);
            setHighlightedPath(new Set());
        }
    }, [selectionVanished]);






    // Every kind shows the same three tabs, so moving between nodes keeps the
    // active tab -- the per-kind reset (and its flicker) is gone with the knob.
    const activeNodeTabs = activeNode ? getDrawerTabs(drawerTabsById) : [];

     
    /**
     * Draw one placed node. Every per-type decision -- icon, colour, label, status dot,
     * extra content -- comes off its descriptor, so this has no knowledge of what it is
     * drawing.
     */
    const renderNode = (node: PlacedNode) => {
        const { descriptor, item } = node;
        // The canvas needs only the descriptor's presentation strings. The full view
        // model -- badges, links, drawer data -- is built for the selected node alone.
        const presentation = descriptor.present(item, ctx);
        const displayType = presentation.graphLabel || presentation.subtitle;
        const status = descriptor.status?.(item);
        const isFocused = focusedNodeId === node.id;

        return (
            <g
                transform={`translate(${node.x}, ${node.y})`}
                // A focused node must stay visible through the highlight dimming.
                style={{
                    cursor: 'pointer',
                    outline: 'none',
                    opacity: isHighlightActive && !isFocused
                        ? (highlightedPath.has(node.id) ? 1 : 0.3) : 1
                }}
                role="button"
                tabIndex={0}
                aria-label={`${presentation.label} (${displayType})`}
                onClick={(e) => handleNodeClick(e, node.id)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleNodeClick(e, node.id);
                    }
                }}
                onFocus={() => setFocusedNodeId(node.id)}
                onBlur={() => setFocusedNodeId((current) => (current === node.id ? null : current))}
            >
                <title>{presentation.label} ({displayType})</title>
                <rect
                    width={itemWidth}
                    height={node.height}
                    rx={5}
                    fill={descriptor.color}
                    stroke={isFocused ? 'var(--pf-t--global--border--color--clicked, #0066CC)' : 'var(--pf-t--global--border--color--default)'}
                    strokeWidth={isFocused ? 3 : 1}
                />
                <foreignObject x={10} y={10} width={20} height={20}>
                    <div style={{ color: '#fff' }}>{iconFor(descriptor, item)}</div>
                </foreignObject>
                <text x={35} y={25} fontSize="12" fontWeight="bold" fill="#fff">{presentation.label}</text>
                <text x={10} y={45} fontSize="10" fill="#eee">{displayType}</text>
                {!descriptor.detail && presentation.state && (
                    <text x={10} y={60} fontSize="10" fill="#eee">{presentation.state}</text>
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
                                onMouseDown={handleMouseDown}
                                onMouseMove={handleMouseMove}
                                onMouseUp={handleMouseUp}
                                onMouseLeave={handleMouseUp}
                                onClick={handleBackgroundClick}
                            >
                                {/* Connectors */}
                                {topologyEdges.map((edge: TopologyEdge) => (
                                    <React.Fragment key={`edge-${edge.source}-${edge.target}`}>
                                        {renderConnector(edge)}
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
                                    {otherGridNodes.map((node) => (
                                        <React.Fragment key={node.id}>
                                            {renderNode(node)}
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
                                        Zoom: {Math.round(zoomLevel * 100)}% | Use Ctrl/Cmd + Scroll to zoom | Drag to pan
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
