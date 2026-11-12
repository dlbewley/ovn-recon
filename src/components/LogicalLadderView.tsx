import * as React from 'react';
import { SearchInput } from '@patternfly/react-core';
import {
    InfrastructureIcon,
    MigrationIcon,
    PluggedIcon,
    ResourcePoolIcon,
    RouteIcon,
} from '@patternfly/react-icons';

import { ConstructRole, DEFAULT_NETWORK, LogicalTier, networkResourceRef } from './logicalClassification';
import { LadderConstruct, LadderEdgeKind, LadderModel } from './logicalLadderModel';
import {
    CONSTRUCT_HEIGHT,
    CONSTRUCT_WIDTH,
    LadderLayout,
    layoutLadder,
    TIER_ORDER,
} from './logicalLadderLayout';
import {
    EDGE_LABEL_FONT_SIZE,
    EDGE_LABEL_LINE_HEIGHT,
    edgeLabel,
    layoutEdgeLabels,
    shortenName,
} from './logicalLadderLabels';
import { ViewportBox } from './canvasViewport';
import { CATEGORICAL, CategoricalColor, SURFACE } from '../topology/palette';
import type { Finding } from '../insights/types';
import { FindingsBadge, findingsBadgeWidth } from '../insights/ui/FindingsViews';

// The label text lives with its fitting logic; the drawer imports it from here.
export { EDGE_ROLE_LABELS, edgeLabel } from './logicalLadderLabels';

/**
 * Presentational SVG for the ladder view: tinted network bands left-to-right,
 * fixed north-south tiers, constructs as cards, edges labelled with the
 * addresses of the router port that creates them. Pure rendering — geometry
 * comes from layoutLadder, label fitting from logicalLadderLabels, semantics
 * from buildLadderModel.
 */

export interface LogicalLadderViewProps {
    model: LadderModel;
    selectedUuid: string | null;
    onSelect: (uuid: string | null) => void;
    /** 'all' or one network identity from the model. */
    networkFilter?: string;
    /** Dim constructs not matching this query. Empty string disables. */
    search?: string;
    /** Aggregate chips currently expanded into individual constructs. */
    expandedGroupIds?: ReadonlySet<string>;
    /** Invoked when an aggregate chip is clicked (expand/collapse). */
    onAggregateToggle?: (aggregateId: string) => void;
    /** Invoked when a band header is clicked (filter to that network). */
    onNetworkSelect?: (network: string) => void;
    /**
     * Drawer navigation: ask the view to report where this construct sits so
     * the page can pan it into view. The nonce distinguishes repeat requests
     * for the same uuid; only the view knows the laid-out position, since it
     * filters and lays out the model internally.
     */
    revealRequest?: { uuid: string; nonce: number };
    /**
     * Answers a reveal request with the construct's card box, in the svg's
     * own coordinates (pre-pan/zoom): the tier-label gutter and band header
     * are included, so the box is exactly where the card is drawn.
     */
    onRevealBox?: (uuid: string, box: ViewportBox) => void;
    /**
     * Reports the selected construct's card box whenever the selection or
     * the layout changes (null while it is not drawn, e.g. collapsed into an
     * aggregate), so the page can keep it visible as the canvas resizes.
     */
    onSelectedBox?: (box: ViewportBox | null) => void;
    /**
     * The findings to badge on a construct (ovn-recon-7i6.3). A construct folded into
     * an aggregate chip lends its findings to the chip. Unset draws no badges.
     */
    findingsFor?: (construct: LadderConstruct) => Finding[];
}

/**
 * Band colours, by palette slot; slot 0 is the default network's neutral gray.
 *
 * A slot is chosen from the network's NAME (networkColorIndex), never its position, so
 * a network keeps its colour under any filter. Slots 4 and 6 were PatternFly's warning
 * gold and danger red, which made a healthy network read as an error, and slot 5 was
 * PatternFly 5's success green; they are now magenta, cyan and violet, from the
 * categorical palette that keeps clear of every status colour (ovn-recon-nt4.1). The
 * slot count is NETWORK_PALETTE_SIZE in logicalLadderLayout, unchanged, so no network
 * moves to a different slot.
 */
export const NETWORK_SLOTS: CategoricalColor[] = [
    CATEGORICAL.gray,
    CATEGORICAL.jade,
    CATEGORICAL.blue,
    CATEGORICAL.purple,
    CATEGORICAL.magenta,
    CATEGORICAL.cyan,
    CATEGORICAL.violet,
];

export const NETWORK_PALETTE: string[] = NETWORK_SLOTS.map((slot) => slot.css);

/**
 * How each ladder edge kind is drawn and what the legend calls it (ovn-recon-nt4.2).
 * The renderer and the legend read this one table; keyed by the model's union, so a
 * new edge kind without an entry is a compile error.
 */
export const LADDER_EDGE_STYLES: Record<LadderEdgeKind, { label: string; description: string; dashArray?: string }> = {
    'router-link': {
        label: 'Router port',
        description: 'A switch attached to a router through a router port. The label names the port\'s purpose and addresses.',
    },
    'router-peer': {
        label: 'Router peering',
        description: 'Two routers joined port to port, with no switch between them. The label gives both ends.',
        dashArray: '6 4',
    },
    'localnet-link': {
        label: 'Localnet',
        description: 'A switch\'s localnet port, out to the physical network through a bridge mapping.',
    },
};

const TIER_LABELS: Record<LogicalTier, string> = {
    physical: 'Physical network',
    external: 'External',
    gateway: 'Gateway routers',
    waist: 'Join / Transit',
    'cluster-routing': 'Cluster routing',
    'workload-switch': 'Workload switches',
    'workload-port': 'Workloads',
};

const ROLE_LABELS: Record<ConstructRole, string> = {
    'bridge-mapping': 'Bridge mapping',
    'cluster-router': 'Cluster router',
    'gateway-router': 'Gateway router',
    'transit-router': 'Transit router',
    'join-switch': 'Join switch',
    'transit-switch': 'Transit switch',
    'node-switch': 'Node switch',
    'layer2-switch': 'Layer 2 switch',
    'localnet-switch': 'Localnet switch',
    'external-switch': 'External switch',
    'other-router': 'Router',
    'other-switch': 'Switch',
};

export const roleLabel = (role: ConstructRole): string => ROLE_LABELS[role];

/** One line per role, for the legend. */
export const ROLE_DESCRIPTIONS: Record<ConstructRole, string> = {
    'bridge-mapping': 'Where a localnet leaves OVN: the localnet name and the OVS bridge the node maps it to.',
    'external-switch': 'Joins a gateway router to the node\'s physical network.',
    'localnet-switch': 'A switch with a localnet port, bridged to a provider network.',
    'gateway-router': 'A node\'s gateway router: north-south traffic, with its SNAT and DNAT rules.',
    'join-switch': 'Joins the gateway routers to the cluster router.',
    'transit-switch': 'Spans node zones: traffic between nodes crosses it over the tunnel.',
    'transit-router': 'A router spanning node zones, peered with each node\'s gateway router.',
    'cluster-router': 'The network\'s distributed router, routing between node subnets.',
    'node-switch': 'One node\'s switch on a Layer 3 network, holding that node\'s pod subnet.',
    'layer2-switch': 'A Layer 2 network\'s one switch, shared by every node.',
    'other-router': 'A router no rule here classifies.',
    'other-switch': 'A switch no rule here classifies.',
};

/** Routers draw as pills, switches as rounded boxes. */
export const constructCornerRadius = (kind: LadderConstruct['kind']): number =>
    (kind === 'router' ? CONSTRUCT_HEIGHT / 2 : 8);

// Same icon language as the node visualization: RouteIcon for anything that
// routes, PluggedIcon for the seam to the physical network, MigrationIcon
// for the tunnel fabric, InfrastructureIcon for plain switching.
const ROLE_ICONS: Record<ConstructRole, React.ReactNode> = {
    // ResourcePoolIcon matches the node view's physical-interface icon.
    'bridge-mapping': <ResourcePoolIcon />,
    'cluster-router': <RouteIcon />,
    'gateway-router': <RouteIcon />,
    'transit-router': <RouteIcon />,
    'other-router': <RouteIcon />,
    'external-switch': <PluggedIcon />,
    'localnet-switch': <PluggedIcon />,
    'transit-switch': <MigrationIcon />,
    'join-switch': <InfrastructureIcon />,
    'node-switch': <InfrastructureIcon />,
    'layer2-switch': <InfrastructureIcon />,
    'other-switch': <InfrastructureIcon />,
};

export const roleIcon = (role: ConstructRole): React.ReactNode => ROLE_ICONS[role];

/** Short kind chip for a band header: CUDN, UDN, or none for the default network. */
export const networkKindBadge = (network: string): 'CUDN' | 'UDN' | undefined => {
    const ref = networkResourceRef(network);
    if (ref?.kind === 'ClusterUserDefinedNetwork') return 'CUDN';
    if (ref?.kind === 'UserDefinedNetwork') return 'UDN';
    return undefined;
};

/**
 * Human name for a network identity: CUDNs drop their OVN name prefix;
 * namespaced UDNs ('<ns>_<name>') render as ns/name.
 */
export const networkDisplayName = (network: string): string => {
    if (network === DEFAULT_NETWORK) return 'Default cluster network';
    if (network.startsWith('cluster_udn_')) return network.slice('cluster_udn_'.length);
    const separator = network.indexOf('_');
    if (separator > 0) {
        return `${network.slice(0, separator)}/${network.slice(separator + 1)}`;
    }
    return network;
};

const TIER_LABEL_WIDTH = 130;
/** Gap between a selected card and its halo. Drawn outside the card; moves nothing. */
const SELECTION_HALO = 4;
const BAND_HEADER_HEIGHT = 34;

/**
 * A construct's card box in the svg's coordinates, or null when the layout
 * does not place it. Layout positions are card centres inside the group that
 * is shifted right by the tier-label gutter and down by the band header; a
 * reveal that used the bare position landed 130px off (ovn-recon-dp7.7).
 */
export const ladderCardBox = (layout: LadderLayout, uuid: string): ViewportBox | null => {
    const position = layout.positions[uuid];
    if (!position) return null;
    return {
        x: TIER_LABEL_WIDTH + position.x - CONSTRUCT_WIDTH / 2,
        y: BAND_HEADER_HEIGHT + position.y - CONSTRUCT_HEIGHT / 2,
        width: CONSTRUCT_WIDTH,
        height: CONSTRUCT_HEIGHT,
    };
};

/** Characters of a construct name that fit a card at the name's font size. */
const NAME_MAX_CHARS = 30;

/** End truncation, for the stat line, whose leading parts matter most. */
const truncate = (value: string, max: number): string =>
    value.length <= max ? value : `${value.slice(0, max - 1)}…`;

/**
 * Whether a construct matches a lowercased search query. The haystack holds
 * what the card shows as well as the raw identities behind it: the role label
 * ("Node switch") next to the role id ("node-switch"), and the network's
 * display name ("ns1/blue") next to its OVN identity ("ns1_blue").
 */
export const constructMatches = (construct: LadderConstruct, query: string): boolean => {
    const haystack = [
        construct.name,
        construct.role,
        roleLabel(construct.role),
        construct.network,
        networkDisplayName(construct.network),
        construct.node ?? '',
        construct.subnet ?? '',
    ]
        .join(' ')
        .toLowerCase();
    return haystack.includes(query);
};

const filterModel = (model: LadderModel, networkFilter: string): LadderModel => {
    if (networkFilter === 'all') return model;
    const constructs = model.constructs.filter((construct) => construct.network === networkFilter);
    const kept = new Set(constructs.map((construct) => construct.uuid));
    return {
        constructs,
        constructByUuid: new Map(constructs.map((construct) => [construct.uuid, construct])),
        edges: model.edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target)),
        networks: model.networks.filter((network) => network === networkFilter),
    };
};

/**
 * The constructs a search matches under a network filter, in reading order:
 * tier by tier from the top, band by band from the left, then by name. Empty
 * for an empty query. The ladder search steps through this list.
 */
export const ladderSearchMatches = (
    model: LadderModel,
    networkFilter: string,
    search: string,
): LadderConstruct[] => {
    const query = search.trim().toLowerCase();
    if (query === '') return [];
    const tierIndex = new Map(TIER_ORDER.map((tier, index) => [tier, index]));
    const networkIndex = new Map(model.networks.map((network, index) => [network, index]));
    return filterModel(model, networkFilter)
        .constructs.filter((construct) => constructMatches(construct, query))
        .sort((a, b) =>
            (tierIndex.get(a.tier) ?? 0) - (tierIndex.get(b.tier) ?? 0)
            || (networkIndex.get(a.network) ?? 0) - (networkIndex.get(b.network) ?? 0)
            || a.name.localeCompare(b.name));
};

export interface LadderSearchProps {
    value: string;
    onChange: (value: string) => void;
    /** ladderSearchMatches for the current value. */
    matches: LadderConstruct[];
    selectedUuid: string | null;
    /** Select and reveal a match: the page's drawer-navigation path. */
    onReveal: (uuid: string) => void;
}

/**
 * The ladder pages' search box. Typing dims what does not match; Enter selects
 * and reveals the first match (the next one when a match is already selected),
 * and the arrows step through the matches with a count beside them.
 */
export const LadderSearch: React.FC<LadderSearchProps> = ({ value, onChange, matches, selectedUuid, onReveal }) => {
    const index = matches.findIndex((construct) => construct.uuid === selectedUuid);
    const step = (delta: 1 | -1) => {
        if (matches.length === 0) return;
        const next = index < 0
            ? (delta > 0 ? 0 : matches.length - 1)
            : (index + delta + matches.length) % matches.length;
        onReveal(matches[next].uuid);
    };
    const hasQuery = value.trim() !== '';
    let resultsCount: string | undefined;
    if (hasQuery) {
        resultsCount = index >= 0 ? `${index + 1} / ${matches.length}` : String(matches.length);
    }
    return (
        <SearchInput
            aria-label="Search constructs"
            placeholder="Search by name, role, node, or subnet"
            value={value}
            onChange={(_event, next) => onChange(next)}
            onSearch={() => step(1)}
            onClear={() => onChange('')}
            resultsCount={resultsCount}
            resultsCountContext={matches.length === 1 ? ' match' : ' matches'}
            onNextClick={() => step(1)}
            onPreviousClick={() => step(-1)}
            isNextNavigationButtonDisabled={matches.length === 0}
            isPreviousNavigationButtonDisabled={matches.length === 0}
            nextNavigationButtonAriaLabel="Next match"
            previousNavigationButtonAriaLabel="Previous match"
            submitSearchButtonLabel="Reveal match"
        />
    );
};

interface ConstructCardProps {
    construct: LadderConstruct;
    x: number;
    y: number;
    color: string;
    isSelected: boolean;
    isDimmed: boolean;
    onSelect: (uuid: string) => void;
    findings?: Finding[];
}

/** The findings pill straddling a card's top edge, right-aligned as on the physical graph. */
const CardFindingsBadge: React.FC<{ findings?: Finding[] }> = ({ findings }) =>
    (findings && findings.length > 0
        ? <FindingsBadge findings={findings} x={CONSTRUCT_WIDTH - 6 - findingsBadgeWidth(findings)} y={-9} />
        : null);

const ConstructCard: React.FC<ConstructCardProps> = ({
    construct,
    x,
    y,
    color,
    isSelected,
    isDimmed,
    onSelect,
    findings,
}) => {
    const statParts: string[] = [];
    if (construct.bridge) statParts.push(`→ ${construct.bridge}`);
    if (construct.subnet) statParts.push(construct.subnet);
    if (construct.podPortCount > 0) statParts.push(`${construct.podPortCount} pods`);
    if (construct.natCount > 0) statParts.push(`${construct.natCount} NAT`);
    if (construct.remotePeers.length > 0) statParts.push(`⇄ ${construct.remotePeers.length} nodes`);
    if (construct.localnetPorts.length > 0) statParts.push('physnet');

    return (
        <g
            transform={`translate(${x - CONSTRUCT_WIDTH / 2}, ${y - CONSTRUCT_HEIGHT / 2})`}
            onClick={(event) => {
                event.stopPropagation();
                onSelect(construct.uuid);
            }}
            style={{ cursor: 'pointer' }}
            opacity={isDimmed ? 0.25 : 1}
            data-testid={`construct-${construct.name}`}
        >
            {/* The card shows a shortened name; hover and assistive tech get all of it. */}
            <title>{construct.name}</title>
            {/* First rect: tests read the selection ring off it. */}
            <rect
                width={CONSTRUCT_WIDTH}
                height={CONSTRUCT_HEIGHT}
                rx={constructCornerRadius(construct.kind)}
                fill={SURFACE.card}
                stroke={isSelected ? SURFACE.selected : color}
                strokeWidth={isSelected ? 3 : 1.5}
            />
            {/* A halo outside the ring: blue is one of the band colours, so a thicker
                stroke alone did not set a selected card apart in a blue band. */}
            {isSelected && (
                <rect
                    x={-SELECTION_HALO}
                    y={-SELECTION_HALO}
                    width={CONSTRUCT_WIDTH + SELECTION_HALO * 2}
                    height={CONSTRUCT_HEIGHT + SELECTION_HALO * 2}
                    rx={constructCornerRadius(construct.kind) + SELECTION_HALO}
                    fill="none"
                    stroke={SURFACE.selected}
                    strokeWidth={1.5}
                    strokeOpacity={0.6}
                    pointerEvents="none"
                />
            )}
            {/* The header renders as HTML so the role icon sits inline with
                the title instead of floating over the name/stat lines. The band
                colour is on the icon only: as text it failed contrast in one theme
                or the other (ovn-recon-nt4.1). */}
            <foreignObject x={0} y={4} width={CONSTRUCT_WIDTH} height={20}>
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 4,
                        color: SURFACE.text,
                        fontSize: 12,
                        fontWeight: 700,
                        lineHeight: 1,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                    }}
                >
                    <span style={{ display: 'inline-flex', color }}>{roleIcon(construct.role)}</span>
                    <span>
                        {roleLabel(construct.role)}
                        {construct.node ? ` · ${construct.node}` : ''}
                    </span>
                </div>
            </foreignObject>
            <text
                x={CONSTRUCT_WIDTH / 2}
                y={34}
                textAnchor="middle"
                fontSize="10"
                fill={SURFACE.text}
            >
                {shortenName(construct.name, NAME_MAX_CHARS)}
            </text>
            {statParts.length > 0 && (
                <text
                    x={CONSTRUCT_WIDTH / 2}
                    y={50}
                    textAnchor="middle"
                    fontSize="10"
                    fill={SURFACE.subtleText}
                >
                    {truncate(statParts.join(' · '), 34)}
                </text>
            )}
            <CardFindingsBadge findings={findings} />
        </g>
    );
};

const LogicalLadderView: React.FC<LogicalLadderViewProps> = ({
    model: fullModel,
    selectedUuid,
    onSelect,
    networkFilter = 'all',
    search = '',
    expandedGroupIds,
    onAggregateToggle,
    onNetworkSelect,
    revealRequest,
    onRevealBox,
    onSelectedBox,
    findingsFor,
}) => {
    const model = React.useMemo(() => filterModel(fullModel, networkFilter), [fullModel, networkFilter]);
    const layout: LadderLayout = React.useMemo(
        () => layoutLadder(model, { expandedGroupIds }),
        [model, expandedGroupIds],
    );

    // Answer a reveal request once per nonce, but only when the layout can
    // actually place the construct — a request may arrive one render before
    // the expansion or filter change that makes the target placeable.
    const answeredRevealNonce = React.useRef(0);
    React.useEffect(() => {
        if (!revealRequest || !onRevealBox) return;
        if (revealRequest.nonce === answeredRevealNonce.current) return;
        const box = ladderCardBox(layout, revealRequest.uuid);
        if (!box) return;
        answeredRevealNonce.current = revealRequest.nonce;
        onRevealBox(revealRequest.uuid, box);
    }, [revealRequest, onRevealBox, layout]);

    React.useEffect(() => {
        if (!onSelectedBox) return;
        onSelectedBox(selectedUuid ? ladderCardBox(layout, selectedUuid) : null);
    }, [selectedUuid, onSelectedBox, layout]);

    const edgeLabels = React.useMemo(() => layoutEdgeLabels(model.edges, layout), [model, layout]);

    const query = search.trim().toLowerCase();
    const colorByNetwork = React.useMemo(() => {
        const colors = new Map<string, string>();
        for (const band of layout.bands) {
            colors.set(band.network, NETWORK_PALETTE[band.colorIndex % NETWORK_PALETTE.length]);
        }
        return colors;
    }, [layout]);

    const width = TIER_LABEL_WIDTH + layout.width + 20;
    const height = BAND_HEADER_HEIGHT + layout.height;

    return (
        <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label="Logical OVN ladder"
            onClick={() => onSelect(null)}
        >
            <g transform={`translate(${TIER_LABEL_WIDTH}, ${BAND_HEADER_HEIGHT})`}>
                {layout.bands.map((band) => {
                    const color = colorByNetwork.get(band.network) ?? NETWORK_PALETTE[0];
                    return (
                        <g key={band.network}>
                            <rect
                                x={band.x}
                                y={0}
                                width={band.width}
                                height={layout.height}
                                rx={10}
                                fill={color}
                                fillOpacity={0.07}
                                stroke={color}
                                strokeOpacity={0.35}
                            />
                            {/* HTML header so the kind chip sits inline left of the name. */}
                            <foreignObject x={band.x} y={-28} width={band.width} height={24}>
                                <div
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        gap: 6,
                                        height: '100%',
                                        cursor: onNetworkSelect ? 'pointer' : undefined,
                                        whiteSpace: 'nowrap',
                                        overflow: 'hidden',
                                    }}
                                    onClick={(event) => {
                                        if (!onNetworkSelect) return;
                                        event.stopPropagation();
                                        onNetworkSelect(band.network);
                                    }}
                                >
                                    {/* The band's colour as a swatch and the chip's outline;
                                        the words in text colours, which pass contrast in both
                                        themes where a band colour as text did not. */}
                                    <span
                                        aria-hidden="true"
                                        data-testid={`network-swatch-${band.network}`}
                                        style={{
                                            width: 10,
                                            height: 10,
                                            borderRadius: 2,
                                            background: color,
                                            flex: 'none',
                                        }}
                                    />
                                    {networkKindBadge(band.network) && (
                                        <span
                                            data-testid={`network-kind-${band.network}`}
                                            style={{
                                                border: `1px solid ${color}`,
                                                color: SURFACE.subtleText,
                                                borderRadius: 4,
                                                fontSize: 10,
                                                fontWeight: 700,
                                                lineHeight: '14px',
                                                padding: '0 4px',
                                            }}
                                        >
                                            {networkKindBadge(band.network)}
                                        </span>
                                    )}
                                    <span style={{ color: SURFACE.text, fontSize: 13, fontWeight: 700 }}>
                                        {networkDisplayName(band.network)}
                                    </span>
                                </div>
                            </foreignObject>
                        </g>
                    );
                })}

                {TIER_ORDER.map((tier) => (
                    <text
                        key={tier}
                        x={-12}
                        y={layout.tierY[tier]}
                        textAnchor="end"
                        dominantBaseline="middle"
                        fontSize="11"
                        fill={SURFACE.subtleText}
                    >
                        {TIER_LABELS[tier]}
                    </text>
                ))}

                {model.edges.map((edge) => {
                    const source = layout.positions[edge.source];
                    const target = layout.positions[edge.target];
                    if (!source || !target) return null;
                    const label = edgeLabels.get(edge.id);
                    return (
                        <g key={edge.id}>
                            <line
                                x1={source.x}
                                y1={source.y}
                                x2={target.x}
                                y2={target.y}
                                stroke="var(--pf-t--global--border--color--default, #6A6E73)"
                                strokeWidth={1.5}
                                strokeDasharray={LADDER_EDGE_STYLES[edge.kind].dashArray}
                                data-edge-kind={edge.kind}
                            />
                            {label && (
                                <text
                                    textAnchor="middle"
                                    fontSize={EDGE_LABEL_FONT_SIZE}
                                    fill="var(--pf-t--global--text--color--subtle, #6A6E73)"
                                    stroke="var(--pf-t--global--background--color--primary--default, #fff)"
                                    strokeWidth={3}
                                    paintOrder="stroke"
                                    data-testid={`edge-label-${edge.id}`}
                                >
                                    {/* Wrapped to stay inside the band; the title keeps it whole. */}
                                    <title>{edgeLabel(edge)}</title>
                                    {label.lines.map((line, index) => (
                                        <tspan
                                            // Lines are positional: a label never reorders its own lines.
                                            key={index}
                                            x={label.x + label.width / 2}
                                            y={label.firstBaseline + index * EDGE_LABEL_LINE_HEIGHT}
                                        >
                                            {line}
                                        </tspan>
                                    ))}
                                </text>
                            )}
                        </g>
                    );
                })}

                {model.constructs.map((construct) => {
                    const position = layout.positions[construct.uuid];
                    if (!position) return null;
                    return (
                        <ConstructCard
                            key={construct.uuid}
                            construct={construct}
                            x={position.x}
                            y={position.y}
                            color={colorByNetwork.get(construct.network) ?? NETWORK_PALETTE[0]}
                            isSelected={selectedUuid === construct.uuid}
                            isDimmed={query !== '' && !constructMatches(construct, query)}
                            onSelect={onSelect}
                            findings={findingsFor?.(construct)}
                        />
                    );
                })}

                {layout.aggregates.map((aggregate) => (
                    <g
                        key={aggregate.id}
                        transform={`translate(${aggregate.x - CONSTRUCT_WIDTH / 2}, ${aggregate.y - CONSTRUCT_HEIGHT / 2})`}
                        data-testid={aggregate.id}
                        style={onAggregateToggle ? { cursor: 'pointer' } : undefined}
                        onClick={(event) => {
                            if (!onAggregateToggle) return;
                            event.stopPropagation();
                            onAggregateToggle(aggregate.id);
                        }}
                    >
                        <rect
                            width={CONSTRUCT_WIDTH}
                            height={CONSTRUCT_HEIGHT}
                            rx={8}
                            fill={SURFACE.card}
                            stroke={colorByNetwork.get(aggregate.network) ?? NETWORK_PALETTE[0]}
                            strokeWidth={1.5}
                            strokeDasharray="4 3"
                        />
                        <text
                            x={CONSTRUCT_WIDTH / 2}
                            y={CONSTRUCT_HEIGHT / 2 + 4}
                            textAnchor="middle"
                            fontSize="12"
                            fontWeight={700}
                            fill={SURFACE.text}
                        >
                            {aggregate.count} × {roleLabel(aggregate.role)}
                        </text>
                        <CardFindingsBadge
                            findings={findingsFor && aggregate.memberUuids.flatMap((uuid) => {
                                const member = model.constructByUuid.get(uuid);
                                return member ? findingsFor(member) : [];
                            })}
                        />
                    </g>
                ))}
            </g>
        </svg>
    );
};

export default LogicalLadderView;
