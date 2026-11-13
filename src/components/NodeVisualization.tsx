import * as React from 'react';
import { Card, CardBody, CardTitle, Drawer, DrawerPanelContent, DrawerContent, DrawerContentBody, DrawerHead, DrawerActions, DrawerCloseButton, Switch, Flex, FlexItem, Button, FormSelect, FormSelectOption } from '@patternfly/react-core';
import { useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import { useNavigate } from 'react-router';


import { NodeNetworkState, ClusterUserDefinedNetwork, UserDefinedNetwork, NetworkAttachmentDefinition, NodeNetworkConfigurationEnactment, RouteAdvertisements, SriovNetworkNodeState, Vtep } from '../types';
import { hasLldpNeighbors } from './nodeVisualizationSelectors';
import { buildTopologyEdges, TopologyEdge } from './nodeVisualizationModel';
import { buildGraphContext, GraphContext } from '../topology/context';
import { FOOT_GRID_ROLES, interfacesWithRole, roleOf } from '../topology/classify';
import { buildDrawerTabs, getDrawerTabs } from '../topology/drawerTabs';
import DrawerTabStrip from './DrawerTabStrip';
import { DrawerIdentity } from './drawerKit';
import { physicalIdentity } from '../topology/drawerIdentity';
import {
    edgeKey, findDuplicateIds, parseNodeId, resolveInterfaceLinkRef, resolveNodeId as resolveId
} from '../topology/ids';
import {
    DrawerTabId, NodeViewModel
} from '../topology/types';
import { buildNodeViewModel } from '../topology/viewModel';
import { computeEdgeBow, computeNodeOrder, sortByRank } from './nodeVisualizationLayout';
import { laneOrderingInput, laneViewRevealing, layoutLanes, LaneViewState, PlacedNode } from '../topology/lanes';
import { descriptorFor, iconFor, NodeTypeId, NODE_TYPES, opaqueNodeIds } from '../topology/descriptors';
import { edgeAppearance } from '../topology/edgeStyles';
import { STATUS_STYLE, SURFACE } from '../topology/palette';
import { NodeStatusIcon } from '../topology/statusIcon';
import { LegendButton, PhysicalLegend } from './GraphLegend';
import { buildFlowGraph, flowPath } from '../topology/flowPath';
import { useSelectionDeepLink } from './useSelectParam';
import {
    narrowedViewBox, pannedViewBox, shiftIfNeeded, svgMeetRegion, svgMeetScale, useKeepSelectionVisible, ViewportBox
} from './canvasViewport';
import { countBySeverity, findingsForGraphNode } from '../insights/selectors';
import type { Finding } from '../insights/types';
import { describeCounts, FindingsBadge, findingsBadgeWidth, HideInfoSwitch } from '../insights/ui/FindingsViews';
import { useHideInfoFindings, useNodeFindings, visibleFindings } from '../insights/ui/useFindings';
import { nodePhysicalPath } from '../routes';

interface NodeVisualizationProps {
    nns: NodeNetworkState;
    cudns?: ClusterUserDefinedNetwork[];
    udns?: UserDefinedNetwork[];
    nads?: NetworkAttachmentDefinition[];
    routeAdvertisements?: RouteAdvertisements[];
    enactments?: NodeNetworkConfigurationEnactment[];
    vteps?: Vtep[];
    /** The raw k8s.ovn.org/vteps annotation off this node's Node object, when readable. */
    nodeVtepsAnnotation?: string;
    /** This node's SriovNetworkNodeState, when the SR-IOV Network Operator is present. */
    sriovNodeState?: SriovNetworkNodeState;
    /** Leave the host select out of the toolbar, for a host that has its own way to change node. */
    hideHostSelect?: boolean;
}

/** A stable default: a fresh `[]` per render would rebuild the graph context every time. */
const NO_VTEPS: Vtep[] = [];

/** Pointer travel, in CSS pixels, before a press on the background counts as a pan rather than a click. */
const PAN_DRAG_THRESHOLD_PX = 3;

/**
 * Marks the drawer content that holds the canvas, so the canvas can measure
 * how much width the inline drawer panel beside it has taken (ovn-recon-dp7.10).
 */
const CANVAS_FRAME_ATTRIBUTE = 'data-canvas-frame'; // written on <DrawerContent> below

/**
 * The svg's size now and the width it has with the drawer closed: its own
 * width plus whatever the drawer panel takes from the drawer main beside the
 * content. Outside a drawer (or unlaid out) the two widths are the same.
 */
const measureCanvas = (svg: SVGSVGElement): { size: { width: number; height: number }; fullWidth: number } => {
    const { width, height } = svg.getBoundingClientRect();
    const content = svg.closest(`[${CANVAS_FRAME_ATTRIBUTE}]`);
    const main = content?.parentElement;
    const panelWidth = content && main
        ? Math.max(0, main.getBoundingClientRect().width - content.getBoundingClientRect().width)
        : 0;
    return { size: { width, height }, fullWidth: width + panelWidth };
};

/** Corner radius of a node card. */
const CARD_RADIUS = 6;
/** Width of the accent stripe down a card's left edge. */
const ACCENT_WIDTH = 4;

/**
 * The accent stripe: the card's left edge, ACCENT_WIDTH wide, following its rounded
 * corners so nothing pokes past them.
 *
 * Written with no space after the leading M on purpose: the snapshot test collects
 * `path[d^="M "]` as same-lane edge arcs, and a stripe must not read as an edge.
 */
const accentStripePath = (height: number): string => {
    const r = CARD_RADIUS;
    const w = ACCENT_WIDTH;
    // Where the corner arc crosses x = w.
    const inset = r - Math.sqrt(r * r - (r - w) * (r - w));
    const top = Number(inset.toFixed(3));
    const bottom = Number((height - inset).toFixed(3));
    return `M${w},${top}V${bottom}A${r},${r} 0 0 1 0,${height - r}V${r}A${r},${r} 0 0 1 ${w},${top}Z`;
};

const NodeVisualization: React.FC<NodeVisualizationProps> = ({
    nns, cudns = [], udns = [], nads = [], routeAdvertisements = [], enactments = [], vteps = NO_VTEPS, nodeVtepsAnnotation,
    sriovNodeState, hideHostSelect = false
}) => {



    // Every NodeNetworkState: the host select's options, and the cluster half of the findings.
    const [allNodeNetworkStates, allNodeNetworkStatesLoaded] = useK8sWatchResource<NodeNetworkState[]>({
        groupVersionKind: {
            group: 'nmstate.io',
            version: 'v1beta1',
            kind: 'NodeNetworkState',
        },
        isList: true,
    });

    const navigate = useNavigate();
    const handleHostSelect = (event: React.FormEvent<HTMLSelectElement>) => {
        const value = (event.target as HTMLSelectElement).value;
        if (value) {
            navigate(nodePhysicalPath(value));
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
        () => buildGraphContext({
            nns, cudns, udns, nads, routeAdvertisements, enactments, vteps, nodeVtepsAnnotation, sriovNodeState
        }),
        [nns, cudns, udns, nads, routeAdvertisements, enactments, vteps, nodeVtepsAnnotation, sriovNodeState]
    );
    const { interfaces } = ctx;
    const { lldpNeighbors } = ctx;

    // Findings (ovn-recon-7i6.1). Evaluated here, off the same context, and never in
    // the layout below: the badge reads them, the layout does not.
    const allFindings = useNodeFindings(ctx, allNodeNetworkStates, allNodeNetworkStatesLoaded);
    const [hideInfo, setHideInfo] = useHideInfoFindings();
    const findings = React.useMemo(() => visibleFindings(allFindings, hideInfo), [allFindings, hideInfo]);
    const nodeName = nns?.metadata?.name || '';
    const findingsFor = React.useCallback(
        (id: string): Finding[] => (findings.length === 0 ? [] : findingsForGraphNode(findings, nodeName, id)),
        [findings, nodeName]
    );
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
    // The grid at the foot of the canvas; classify decides which roles land in it.
    const otherInterfaces = ctx.interfaces.filter((iface) =>
        FOOT_GRID_ROLES.includes(roleOf(iface, ctx)));

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
    const graph = React.useMemo(() => buildFlowGraph(topologyEdges), [topologyEdges]);
    // Nodes the highlight walk lights but does not pass through (br-int).
    const opaqueIds = React.useMemo(() => opaqueNodeIds(ctx), [ctx]);

    // Path Traversal
    const [highlightedPath, setHighlightedPath] = React.useState<Set<string>>(new Set());
    const [isHighlightActive, setIsHighlightActive] = React.useState<boolean>(false);

    const getFlowPath = (startNodeId: string) => flowPath(graph, startNodeId, opaqueIds);

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
     * True once the user has panned or zoomed, or a selection panned the view
     * to show its node. Until then the viewBox tracks the canvas size, so
     * toggling a column that GROWS the canvas (NADs, LLDP) does not clip the
     * new content -- previously only the Reset button recovered from that.
     */
    const userAdjustedView = React.useRef<boolean>(false);
    React.useEffect(() => {
        if (!userAdjustedView.current && calculatedHeight > 0) {
            setViewBox({ x: 0, y: 0, width, height: calculatedHeight });
            setZoomLevel(1);
        }
    }, [calculatedHeight, width]);

    /**
     * The viewBox state is the view at the canvas's FULL width, the width it
     * has with the drawer closed. The inline drawer narrows the svg; drawing
     * the full viewBox into it would "meet"-fit the whole graph into what is
     * left and shrink it (ovn-recon-dp7.10). It is drawn instead through
     * narrowedViewBox: same corner, same scale, cut to the narrower width.
     */
    const [canvasWidths, setCanvasWidths] = React.useState<{ width: number; fullWidth: number }>(
        { width: 0, fullWidth: 0 });
    const displayedViewBoxOf = (state: ViewportBox): ViewportBox =>
        narrowedViewBox(state, canvasWidths.width, canvasWidths.fullWidth);

    /**
     * Where the view was when the drawer opened, so closing it can put back a
     * pan that only the selection made. Dropped the moment the user pans,
     * zooms or resets: from then on the view is theirs and closing keeps it.
     */
    const viewBeforeSelection = React.useRef<{ x: number; y: number; userAdjusted: boolean } | null>(null);
    /** True once keeping the selection visible has moved the view since the drawer opened. */
    const selectionMovedView = React.useRef<boolean>(false);


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
        // Dash and resting opacity come off the table the legend reads (ovn-recon-nt4.2).
        const rest = edgeAppearance(edge.kind, edge.provenance);
        // The lit path is brand blue, which the dark theme lightens; a fixed #0066CC
        // all but vanished on the dark canvas.
        const stroke = isHighlightActive ? (highlighted ? SURFACE.flow : SURFACE.border) : 'currentColor';
        const strokeWidth = isHighlightActive ? (highlighted ? 4 : 1) : 2;
        const opacity = isHighlightActive
            ? (highlighted ? 1 : 0.1)
            : rest.opacity;
        const appearance = {
            stroke,
            strokeWidth,
            strokeDasharray: rest.dashArray,
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
        //
        // Only laned nodes are obstacles. The foot grid sits below every lane and
        // draws no edges, and its nodes carry GRID-relative coordinates starting at
        // 0,0 -- fed in as they are they read as boxes in the top-left of the canvas
        // and bowed unrelated lane edges there (s3t.54).
        const obstacles = Array.from(placedNodeById.values())
            .filter((node) => node.laneId !== 'other')
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


    /** The user panned or zoomed: the view is theirs, and closing the drawer keeps it. */
    const userTookTheView = () => {
        userAdjustedView.current = true;
        viewBeforeSelection.current = null;
    };

    // Pan/Zoom handlers. Zoom matches the logical ladder views: additive
    // 0.1 steps clamped to [0.3, 2.5], applied about the viewport center —
    // one consistent feel across the physical and logical topology pages.
    const handleZoom = (direction: 1 | -1) => {
        if (!viewBox) return;
        userTookTheView();

        const newZoom = direction > 0
            ? Math.min(2.5, Number((zoomLevel + 0.1).toFixed(2)))
            : Math.max(0.3, Number((zoomLevel - 0.1).toFixed(2)));

        const newWidth = width / newZoom;
        const newHeight = calculatedHeight / newZoom;
        // About the centre of what is drawn, which beside the drawer is
        // narrower than the full-width viewBox by the same factor.
        const narrowing = displayedViewBoxOf(viewBox).width / viewBox.width;
        const newX = viewBox.x + ((viewBox.width - newWidth) * narrowing) / 2;
        const newY = viewBox.y + (viewBox.height - newHeight) / 2;

        setViewBox({ x: newX, y: newY, width: newWidth, height: newHeight });
        setZoomLevel(newZoom);
    };

    /**
     * A plain wheel over the canvas zooms one step, matching the logical
     * ladder views.
     *
     * This must be a NATIVE listener registered non-passive: React attaches
     * wheel at the root as passive, so calling preventDefault on the synthetic
     * event logged an error and did nothing.
     */
    const wheelZoomRef = React.useRef<(event: WheelEvent) => void>(() => undefined);
    wheelZoomRef.current = (event: WheelEvent) => {
        event.preventDefault();
        handleZoom(event.deltaY < 0 ? 1 : -1);
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
            userTookTheView();
            suppressBackgroundClick.current = true;
            const deltaX = event.clientX - panStart.x;
            const deltaY = event.clientY - panStart.y;

            if (svgContainerRef.current) {
                const svgRect = svgContainerRef.current.getBoundingClientRect();
                const displayed = displayedViewBoxOf(viewBox);
                setViewBox(pannedViewBox(viewBox, displayed, svgRect, deltaX, deltaY));
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
        // With the drawer open this is the default scale and corner too, the
        // view drawn narrower beside it; there is no earlier pan left to restore.
        userAdjustedView.current = false;
        viewBeforeSelection.current = null;
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

    /** A drawn node's box in canvas coordinates. */
    const nodeBoxOf = (id: string): ViewportBox | null => {
        const position = absolutePositionOf(id);
        const placed = placedNodeById.get(id);
        if (!position || !placed) return null;
        return { x: position.x, y: position.y, width: itemWidth, height: placed.height };
    };

    /**
     * Snapshot the view as the drawer opens, and on close put back a pan that
     * only the selection made (ovn-recon-dp7.10). Declared before the
     * keep-visible hook so the snapshot is taken before its pan lands.
     */
    const drawerOpen = selectedPlacedNode !== undefined;
    const drawerWasOpen = React.useRef<boolean>(false);
    React.useEffect(() => {
        if (drawerOpen === drawerWasOpen.current) return;
        drawerWasOpen.current = drawerOpen;
        if (drawerOpen) {
            const current = viewBox ?? { x: 0, y: 0, width, height: calculatedHeight };
            viewBeforeSelection.current = { x: current.x, y: current.y, userAdjusted: userAdjustedView.current };
            selectionMovedView.current = false;
            return;
        }
        const before = viewBeforeSelection.current;
        const moved = selectionMovedView.current;
        viewBeforeSelection.current = null;
        selectionMovedView.current = false;
        if (!before || !moved) return;
        userAdjustedView.current = before.userAdjusted;
        // A view nobody had touched goes back to the default, which also
        // picks up any growth of the canvas while the drawer was open.
        setViewBox((previous) => (before.userAdjusted && previous
            ? { ...previous, x: before.x, y: before.y }
            : { x: 0, y: 0, width, height: calculatedHeight }));
    }, [drawerOpen]);

    /**
     * Keep the selection visible beside the inline drawer (ovn-recon-dp7.7,
     * ovn-recon-dp7.10). Every selection -- a canvas click, a Relationships
     * link, a deep link -- and every later resize of the canvas pans only when
     * the node is not wholly visible, and then only as far as needed; the scale
     * never changes. The visible region is what the svg actually shows: the
     * narrowed viewBox fitted "meet" into its current size, which shows more
     * than the viewBox along the roomier axis.
     *
     * The flow path is not fitted. Any pan that keeps the node visible is at
     * least as long as the minimal one on each axis, so showing more of the
     * path always costs extra movement, which the user asked us not to make.
     */
    const { setCanvas } = useKeepSelectionVisible({
        selectionKey: selectedPlacedNode ? selectedNodeId : null,
        getSelectionBox: () => (selectedNodeId ? nodeBoxOf(selectedNodeId) : null),
        adjustView: (compute) => {
            const svg = svgContainerRef.current;
            if (!svg) return;
            // An svg not laid out yet (or in jsdom) reports no size; the
            // region helpers then treat the viewBox itself as what shows.
            const { size, fullWidth } = measureCanvas(svg);
            setViewBox((previous) => {
                const current = previous ?? { x: 0, y: 0, width, height: calculatedHeight };
                const shown = narrowedViewBox(current, size.width, fullWidth);
                const shift = compute(svgMeetRegion(shown, size), 1 / svgMeetScale(shown, size));
                return shiftIfNeeded(current, shift, (state, { dx, dy }) => {
                    userAdjustedView.current = true;
                    selectionMovedView.current = true;
                    return { ...state, x: state.x + dx, y: state.y + dy };
                });
            });
        },
    });

    /**
     * Track the canvas width against its full width. Measured synchronously
     * when the drawer opens or closes, so the first frame beside the drawer
     * is already at the right scale, and on every later resize (the drawer's
     * splitter, the window).
     */
    const [svgElement, setSvgElement] = React.useState<SVGSVGElement | null>(null);
    const syncCanvasWidths = React.useRef<() => void>(() => undefined);
    syncCanvasWidths.current = () => {
        const svg = svgContainerRef.current;
        if (!svg) return;
        const { size, fullWidth } = measureCanvas(svg);
        setCanvasWidths((previous) => (previous.width === size.width && previous.fullWidth === fullWidth
            ? previous
            : { width: size.width, fullWidth }));
    };
    React.useLayoutEffect(() => syncCanvasWidths.current(), [drawerOpen]);
    React.useEffect(() => {
        if (!svgElement || typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(() => syncCanvasWidths.current());
        observer.observe(svgElement);
        return () => observer.disconnect();
    }, [svgElement]);

    const svgRef = React.useCallback((element: SVGSVGElement | null) => {
        svgContainerRef.current = element;
        setSvgElement(element);
        setCanvas(element);
    }, [setCanvas]);

    // Rebuilt each render: the Relationships tab must see the edges of the
    // CURRENT view (lane toggles change them), and closures capture live state.
    // Only edges with both endpoints drawn: the canvas skips the others too, and
    // navigating to an undrawn node would just clear the selection.
    const drawerTabsById = buildDrawerTabs(ctx, {
        edges: topologyEdges.filter(
            (edge) => placedNodeById.has(edge.source) && placedNodeById.has(edge.target)),
        isDrawn: (id) => placedNodeById.has(id),
        labelFor: (id) => {
            const placed = placedNodeById.get(id);
            return placed ? placed.descriptor.present(placed.item, ctx).label : id;
        },
        onSelectNode: selectNode,
        findingsFor
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

    /**
     * select=<canonical node id> in the URL (ovn-recon-s3t.16). A link restores
     * through the same path as a click -- select, light the flow path, pan only
     * if the node would be hidden (ovn-recon-dp7.10) -- once the canvas draws
     * that node. An id in a lane that is toggled off (an OVS internal port in
     * Logical Interfaces, ovn-recon-tpp.7) turns that lane on first and resolves
     * on the next render, once the node is drawn with its edges; an id no view
     * draws (a stale link) is ignored.
     */
    useSelectionDeepLink<string>({
        selected: selectedPlacedNode ? selectedNodeId : null,
        encode: (id) => id,
        resolve: (id) => {
            if (placedNodeById.has(id)) return id;
            const reveal = laneViewRevealing(ctx, laneView, id);
            if (reveal) {
                setShowHiddenColumns(reveal.showHiddenColumns);
                setShowNads(reveal.showNads);
                return null;
            }
            // A management port is not a node: an older link naming one lands on
            // the VRF or integration bridge that owns it.
            const parsed = parseNodeId(id);
            const owner = parsed?.kind === 'iface' ? resolveInterfaceLinkRef(parsed.key, ctx) : undefined;
            if (owner && owner !== id && placedNodeById.has(owner)) return owner;
            return null;
        },
        apply: (id) => {
            selectNode(id);
            setActivePopoverTab('overview');
        },
    });






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
        // Selection draws the same ring as focus, so a node selected from the drawer,
        // a search result or a deep link is marked even while focus is elsewhere.
        const isSelected = selectedNodeId === node.id;
        const isOutlined = isFocused || isSelected;
        const nodeFindings = findingsFor(node.id);
        const findingsText = nodeFindings.length > 0 ? `, ${describeCounts(countBySeverity(nodeFindings))}` : '';
        // The state line is coloured only when it IS the state word ("down"), not when
        // a kind uses it for something else (a VRF's ports and table).
        const stateColor = status && presentation.state?.toLowerCase() === status
            ? STATUS_STYLE[status].text
            : SURFACE.subtleText;
        const frame = {
            stroke: isOutlined ? SURFACE.selected : SURFACE.border,
            strokeWidth: isOutlined ? 3 : 1
        };

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
                aria-label={`${presentation.label} (${displayType})${findingsText}`}
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
                {/*
                  * A neutral card (ovn-recon-nt4.1): the surface and text are the console's
                  * own tokens, the kind is the icon plus a stripe in its accent, and the
                  * state is a status icon. Colour on the card is then either "which kind"
                  * (the accent, never a status hue) or "how it is" (status tokens only),
                  * and the findings badge stays the loudest thing on it.
                  *
                  * This rect stays first: tests and the reveal read the node's box and
                  * its ring off the first rect in the group.
                  */}
                <rect
                    width={itemWidth}
                    height={node.height}
                    rx={CARD_RADIUS}
                    fill={SURFACE.card}
                    {...frame}
                />
                <path d={accentStripePath(node.height)} fill={descriptor.color} data-accent={descriptor.type} />
                {/* The ring again over the stripe, so focus and selection read all round. */}
                {isOutlined && (
                    <rect width={itemWidth} height={node.height} rx={CARD_RADIUS} fill="none" pointerEvents="none" {...frame} />
                )}
                <foreignObject x={12} y={10} width={20} height={20}>
                    <div style={{ color: descriptor.color, fontSize: 16, lineHeight: 1 }}>{iconFor(descriptor, item)}</div>
                </foreignObject>
                <text x={36} y={24} fontSize="12" fontWeight="bold" fill={SURFACE.text}>{presentation.label}</text>
                <text x={12} y={45} fontSize="10" fill={SURFACE.subtleText}>{displayType}</text>
                {!descriptor.detail && presentation.state && (
                    <text x={12} y={60} fontSize="10" fill={stateColor}>{presentation.state}</text>
                )}
                {descriptor.detail?.(item, { width: itemWidth, height: node.height })}
                {status && (
                    // Where the dot was and about its size, below the findings badge's reach
                    // (it ends at y=9) and smaller than it: the badge stays the loudest mark.
                    <foreignObject x={itemWidth - 22} y={10} width={14} height={14} data-testid="node-status">
                        <NodeStatusIcon status={status} />
                    </foreignObject>
                )}
                {/* Decorator only: straddles the top edge, right-aligned, and moves nothing. */}
                <FindingsBadge findings={nodeFindings} x={itemWidth - 6 - findingsBadgeWidth(nodeFindings)} y={-9} />
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
                {activeNode && (
                    <DrawerIdentity icon={drawerIcon(activeNode)} {...physicalIdentity(activeNode, ctx)} />
                )}
                <DrawerActions>
                    <DrawerCloseButton onClick={handlePopoverClose} />
                </DrawerActions>
            </DrawerHead>
            {activeNode && (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
                    <DrawerTabStrip<DrawerTabId>
                        tabs={activeNodeTabs}
                        activeKey={activePopoverTab}
                        onSelect={setActivePopoverTab}
                        aria-label="Node details"
                    />
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
                <Drawer isExpanded={!!activeNode} isInline>
                    <DrawerContent
                        panelContent={activeNode ? panelContent : null}
                        data-canvas-frame=""
                    >
                        <DrawerContentBody style={{ padding: '12px 24px', overflow: 'auto' }}>
                            <Flex style={{ marginBottom: '16px', alignItems: 'center', gap: '16px' }}>
                                {!hideHostSelect && (
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
                                )}
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
                                {allFindings.some((finding) => finding.severity === 'info') && (
                                    <FlexItem>
                                        <HideInfoSwitch
                                            id="hide-info-findings-toggle"
                                            findings={allFindings}
                                            hideInfo={hideInfo}
                                            onChange={setHideInfo}
                                        />
                                    </FlexItem>
                                )}
                                <FlexItem><Button variant="secondary" onClick={handleZoomOut} aria-label="Zoom out">-</Button></FlexItem>
                                <FlexItem><Button variant="secondary" onClick={handleZoomIn} aria-label="Zoom in">+</Button></FlexItem>
                                <FlexItem><Button variant="link" onClick={handleResetZoom}>Reset view</Button></FlexItem>
                                <FlexItem><LegendButton><PhysicalLegend /></LegendButton></FlexItem>
                            </Flex>
                            <svg
                                ref={svgRef}
                                width="100%"
                                height={calculatedHeight}
                                viewBox={(({ x, y, width: w, height: h }) => `${x} ${y} ${w} ${h}`)(
                                    displayedViewBoxOf(viewBox ?? { x: 0, y: 0, width, height: calculatedHeight }))}
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
                            <Flex style={{ marginTop: '8px' }}>
                                <FlexItem>
                                    <span style={{ fontSize: '0.9em', color: 'var(--pf-t--global--text--color--subtle)' }}>
                                        Scroll to zoom · Drag to pan
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
