import { LadderEdge } from './logicalLadderModel';
import { LadderBand, LadderLayout } from './logicalLadderLayout';

/**
 * Text fitting for the ladder view: how a construct name shortens to fit its
 * card, and how an edge label wraps to stay inside its network band.
 *
 * Pure functions, like the layout. Widths are estimated from character
 * counts, because SVG text cannot be measured without a browser; the
 * estimate is deliberately on the wide side so the computed box bounds the
 * rendered one.
 */

const ELLIPSIS = '…';

/** Share of a shortened name's budget its suffix may take. */
const SUFFIX_SHARE = 0.6;

/**
 * Shorten a long OVN name with a middle ellipsis.
 *
 * OVN-Kubernetes names end in what tells constructs of one network apart:
 * the role ('…_ovn_layer2_switch', '…_transit_router') or the node
 * ('GR_…_<node>'). Cutting the end, as a plain truncation does, leaves a
 * network's switch and its router reading the same. The suffix kept here is
 * the longest one that starts at an underscore and fits its share of the
 * budget, so it reads as whole words; a name with no such boundary splits
 * evenly around the ellipsis.
 */
export const shortenName = (name: string, max: number): string => {
    if (name.length <= max) return name;
    const budget = Math.max(max - ELLIPSIS.length, 0);

    const suffixCap = Math.floor(budget * SUFFIX_SHARE);
    const boundary = name.indexOf('_', name.length - suffixCap);
    const suffix = boundary !== -1 && boundary < name.length - 1
        ? name.slice(boundary)
        : name.slice(name.length - Math.floor(budget / 2));

    // A separator left dangling before the ellipsis is noise.
    const head = name.slice(0, budget - suffix.length).replace(/[._-]+$/, '');
    return `${head}${ELLIPSIS}${suffix}`;
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
const annotateInterconnectAddress = (address: string): string =>
    /\/(31|127)$/.test(address) ? `p2p ${address}` : `router ${address}`;

/**
 * An edge label as the pieces that must stay whole when it wraps: the role,
 * then one piece per address, the far end's first address carrying the ⇄.
 * Joined with spaces they are the label as one line.
 */
export const edgeLabelSegments = (edge: LadderEdge): string[] => {
    const annotate = edge.role === 'interconnect'
        ? annotateInterconnectAddress
        : (address: string) => address;
    const near = edge.networks.map(annotate);
    const far = (edge.peerNetworks ?? []).map(annotate);
    if (near.length > 0 && far.length > 0) far[0] = `⇄ ${far[0]}`;
    const addresses = [...near, ...far];

    const role = EDGE_ROLE_LABELS[edge.role];
    if (!role) return addresses;
    return addresses.length > 0 ? [`${role} ·`, ...addresses] : [role];
};

/** The whole label on one line, for the drawer and the label's tooltip. */
export const edgeLabel = (edge: LadderEdge): string => edgeLabelSegments(edge).join(' ');

/**
 * Greedy line fill: a line takes segments while it stays within maxChars.
 * A single segment longer than a line is shortened to fit, so no line ever
 * exceeds maxChars.
 */
export const wrapSegments = (segments: string[], maxChars: number): string[] => {
    const limit = Math.max(maxChars, 1);
    const lines: string[] = [];
    for (const segment of segments) {
        const piece = shortenName(segment, limit);
        const last = lines.length - 1;
        if (last >= 0 && lines[last].length + 1 + piece.length <= limit) {
            lines[last] = `${lines[last]} ${piece}`;
        } else {
            lines.push(piece);
        }
    }
    return lines;
};

/** Edge label typography, in pixels. */
export const EDGE_LABEL_FONT_SIZE = 9;
export const EDGE_LABEL_LINE_HEIGHT = 11;
/**
 * Estimated advance per character at the label font size. The labels are
 * mostly digits, dots and slashes, which average under half an em; 5px at a
 * 9px font leaves headroom, so an estimated width is an upper bound.
 */
export const EDGE_LABEL_CHAR_WIDTH = 5;
/** Clear space kept between a label and its band's border. */
const BAND_INSET = 8;
/** A one-line label's baseline sits this far above the edge midpoint. */
const BASELINE_LIFT = 4;

export interface EdgeLabelBox {
    edgeId: string;
    /** Network of the band the label is confined to. */
    network: string;
    /** The label, wrapped to the band. */
    lines: string[];
    /**
     * Estimated bounding box, in layout coordinates. Lines are centered on
     * x + width / 2.
     */
    x: number;
    y: number;
    width: number;
    height: number;
    /** Baseline of the first line; each next one is a line height lower. */
    firstBaseline: number;
}

/** The band a point belongs to: the one containing x, else the nearest. */
const bandAt = (bands: LadderBand[], x: number): LadderBand | undefined => {
    let nearest: LadderBand | undefined;
    let nearestDistance = Infinity;
    for (const band of bands) {
        const distance = Math.max(band.x - x, x - (band.x + band.width), 0);
        if (distance < nearestDistance) {
            nearest = band;
            nearestDistance = distance;
        }
    }
    return nearest;
};

/**
 * Place every edge label inside its own network band.
 *
 * A label is anchored at its edge's midpoint. Bands sit side by side and
 * labels of neighbouring bands share a row, so a label wider than its band
 * runs into the next band's label. Each label therefore wraps to its band's
 * inner width, and a box that would still cross the border slides sideways
 * until it is inside. Edges with no label, or with an endpoint the layout
 * did not place (an aggregated member), get no box.
 */
export const layoutEdgeLabels = (edges: LadderEdge[], layout: LadderLayout): Map<string, EdgeLabelBox> => {
    const boxes = new Map<string, EdgeLabelBox>();
    for (const edge of edges) {
        const source = layout.positions[edge.source];
        const target = layout.positions[edge.target];
        if (!source || !target) continue;
        const segments = edgeLabelSegments(edge);
        if (segments.length === 0) continue;

        const midX = (source.x + target.x) / 2;
        const midY = (source.y + target.y) / 2;
        const band = bandAt(layout.bands, midX);
        if (!band) continue;

        const left = band.x + BAND_INSET;
        const innerWidth = band.width - BAND_INSET * 2;
        const lines = wrapSegments(segments, Math.floor(innerWidth / EDGE_LABEL_CHAR_WIDTH));
        const width = Math.max(...lines.map((line) => line.length)) * EDGE_LABEL_CHAR_WIDTH;
        const x = Math.min(Math.max(midX - width / 2, left), left + innerWidth - width);

        // Center the block where a one-line label has always sat.
        const firstBaseline = midY - BASELINE_LIFT - ((lines.length - 1) * EDGE_LABEL_LINE_HEIGHT) / 2;
        boxes.set(edge.id, {
            edgeId: edge.id,
            network: band.network,
            lines,
            x,
            y: firstBaseline - EDGE_LABEL_FONT_SIZE,
            width,
            height: lines.length * EDGE_LABEL_LINE_HEIGHT,
            firstBaseline,
        });
    }
    return boxes;
};
