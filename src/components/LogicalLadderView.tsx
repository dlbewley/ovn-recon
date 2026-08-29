import * as React from 'react';
import {
    InfrastructureIcon,
    MigrationIcon,
    PluggedIcon,
    ResourcePoolIcon,
    RouteIcon,
} from '@patternfly/react-icons';

import { ConstructRole, DEFAULT_NETWORK, LogicalTier } from './logicalClassification';
import { LadderConstruct, LadderEdge, LadderModel } from './logicalLadderModel';
import {
    CONSTRUCT_HEIGHT,
    CONSTRUCT_WIDTH,
    LadderLayout,
    layoutLadder,
    TIER_ORDER,
} from './logicalLadderLayout';

/**
 * Presentational SVG for the ladder view: tinted network bands left-to-right,
 * fixed north-south tiers, constructs as cards, edges labelled with the
 * addresses of the router port that creates them. Pure rendering — geometry
 * comes from layoutLadder, semantics from buildLadderModel.
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
}

/** Band palette; index 0 is the default network's neutral slot. */
export const NETWORK_PALETTE = [
    '#6A6E73', // neutral gray - default network
    '#009596', // teal
    '#0066CC', // blue
    '#5752D1', // purple
    '#B98412', // gold
    '#3E8635', // green
    '#A30000', // red
];

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
const BAND_HEADER_HEIGHT = 34;

const truncate = (value: string, max: number): string =>
    value.length <= max ? value : `${value.slice(0, max - 1)}…`;

const constructMatches = (construct: LadderConstruct, query: string): boolean => {
    const haystack = [
        construct.name,
        construct.role,
        construct.network,
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

export const EDGE_ROLE_LABELS: Record<LadderEdge['role'], string> = {
    localnet: 'localnet',
    join: 'join',
    external: 'external',
    gateway: 'gateway',
    tunnel: 'tunnel',
    interconnect: 'interconnect',
    link: '',
};

// An interconnect leg mixes two address kinds: the router's address on the
// network's join subnet, and the /31 (or /127) point-to-point pair carrying
// the tunnel. Annotate each so the mix reads as function, not just numbers.
const annotateInterconnectAddresses = (addresses: string[]): string =>
    addresses
        .map((address) => (/\/(31|127)$/.test(address) ? `p2p ${address}` : `router ${address}`))
        .join(' ');

export const edgeLabel = (edge: LadderEdge): string => {
    const annotate = edge.role === 'interconnect'
        ? annotateInterconnectAddresses
        : (addresses: string[]) => addresses.join(' ');
    const left = annotate(edge.networks);
    const right = annotate(edge.peerNetworks ?? []);
    const addresses = left && right ? `${left} ⇄ ${right}` : left || right;
    const role = EDGE_ROLE_LABELS[edge.role];
    if (!addresses) return role;
    return role ? `${role} · ${addresses}` : addresses;
};

interface ConstructCardProps {
    construct: LadderConstruct;
    x: number;
    y: number;
    color: string;
    isSelected: boolean;
    isDimmed: boolean;
    onSelect: (uuid: string) => void;
}

const ConstructCard: React.FC<ConstructCardProps> = ({
    construct,
    x,
    y,
    color,
    isSelected,
    isDimmed,
    onSelect,
}) => {
    const statParts: string[] = [];
    if (construct.bridge) statParts.push(`→ ${construct.bridge}`);
    if (construct.subnet) statParts.push(construct.subnet);
    if (construct.podPortCount > 0) statParts.push(`${construct.podPortCount} pods`);
    if (construct.natCount > 0) statParts.push(`${construct.natCount} NAT`);
    if (construct.remotePeers.length > 0) statParts.push(`⇄ ${construct.remotePeers.length} nodes`);
    if (construct.localnetPorts.length > 0) statParts.push('physnet');

    const isRouter = construct.kind === 'router';

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
            <rect
                width={CONSTRUCT_WIDTH}
                height={CONSTRUCT_HEIGHT}
                rx={isRouter ? CONSTRUCT_HEIGHT / 2 : 8}
                fill="var(--pf-t--global--background--color--primary--default, #fff)"
                stroke={isSelected ? 'var(--pf-t--global--border--color--clicked, #0066CC)' : color}
                strokeWidth={isSelected ? 3 : 1.5}
            />
            {/* The header renders as HTML so the role icon sits inline with
                the title instead of floating over the name/stat lines. */}
            <foreignObject x={0} y={4} width={CONSTRUCT_WIDTH} height={20}>
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 4,
                        color,
                        fontSize: 12,
                        fontWeight: 700,
                        lineHeight: 1,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                    }}
                >
                    {roleIcon(construct.role)}
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
                fill="var(--pf-t--global--text--color--regular, #151515)"
            >
                {truncate(construct.name, 30)}
            </text>
            {statParts.length > 0 && (
                <text
                    x={CONSTRUCT_WIDTH / 2}
                    y={50}
                    textAnchor="middle"
                    fontSize="10"
                    fill="var(--pf-t--global--text--color--subtle, #6A6E73)"
                >
                    {truncate(statParts.join(' · '), 34)}
                </text>
            )}
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
}) => {
    const model = React.useMemo(() => filterModel(fullModel, networkFilter), [fullModel, networkFilter]);
    const layout: LadderLayout = React.useMemo(
        () => layoutLadder(model, { expandedGroupIds }),
        [model, expandedGroupIds],
    );

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
                            <text
                                x={band.x + band.width / 2}
                                y={-10}
                                textAnchor="middle"
                                fontSize="13"
                                fontWeight={700}
                                fill={color}
                                style={onNetworkSelect ? { cursor: 'pointer' } : undefined}
                                onClick={(event) => {
                                    if (!onNetworkSelect) return;
                                    event.stopPropagation();
                                    onNetworkSelect(band.network);
                                }}
                            >
                                {networkDisplayName(band.network)}
                            </text>
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
                        fill="var(--pf-t--global--text--color--subtle, #6A6E73)"
                    >
                        {TIER_LABELS[tier]}
                    </text>
                ))}

                {model.edges.map((edge) => {
                    const source = layout.positions[edge.source];
                    const target = layout.positions[edge.target];
                    if (!source || !target) return null;
                    const midX = (source.x + target.x) / 2;
                    const midY = (source.y + target.y) / 2;
                    const label = edgeLabel(edge);
                    return (
                        <g key={edge.id}>
                            <line
                                x1={source.x}
                                y1={source.y}
                                x2={target.x}
                                y2={target.y}
                                stroke="var(--pf-t--global--border--color--default, #6A6E73)"
                                strokeWidth={1.5}
                                strokeDasharray={edge.kind === 'router-peer' ? '6 4' : undefined}
                            />
                            {label && (
                                <text
                                    x={midX}
                                    y={midY - 4}
                                    textAnchor="middle"
                                    fontSize="9"
                                    fill="var(--pf-t--global--text--color--subtle, #6A6E73)"
                                    stroke="var(--pf-t--global--background--color--primary--default, #fff)"
                                    strokeWidth={3}
                                    paintOrder="stroke"
                                >
                                    {label}
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
                            fill="var(--pf-t--global--background--color--primary--default, #fff)"
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
                            fill="var(--pf-t--global--text--color--regular, #151515)"
                        >
                            {aggregate.count} × {roleLabel(aggregate.role)}
                        </text>
                    </g>
                ))}
            </g>
        </svg>
    );
};

export default LogicalLadderView;
