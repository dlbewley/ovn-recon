import { LadderEdge } from './logicalLadderModel';
import { CONSTRUCT_HEIGHT, CONSTRUCT_WIDTH, LadderBand, LadderLayout } from './logicalLadderLayout';

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
/** Clear space kept between two labels of one band, and between a label and a card. */
const LABEL_GAP = 6;
/**
 * Where along its edge a label may sit when its midpoint is taken, as a share of
 * the edge from source to target: the midpoint first, then alternately nearer each
 * end. Fanning edges spread apart toward their replicated end.
 */
const ANCHOR_STEPS = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82];

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

interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

const overlaps = (a: Rect, b: Rect, gap = 0): boolean =>
    a.x < b.x + b.width + gap && b.x < a.x + a.width + gap
    && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;

/** One label's fixed facts: what it says, where its edge runs, and its band. */
interface LabelPlan {
    edge: LadderEdge;
    segments: string[];
    band: LadderBand;
    source: { x: number; y: number };
    target: { x: number; y: number };
    /** The narrowest the label can wrap without shortening a piece. */
    minWidth: number;
    innerLeft: number;
    innerWidth: number;
}

/** The label wrapped to maxWidth and anchored `along` its edge (0.5 is the midpoint). */
const boxAt = (plan: LabelPlan, along: number, maxWidth: number): EdgeLabelBox => {
    const { band, source, target, innerLeft, innerWidth } = plan;
    const anchorX = source.x + (target.x - source.x) * along;
    const anchorY = source.y + (target.y - source.y) * along;
    const lines = wrapSegments(plan.segments, Math.floor(Math.min(maxWidth, innerWidth) / EDGE_LABEL_CHAR_WIDTH));
    const width = Math.max(...lines.map((line) => line.length)) * EDGE_LABEL_CHAR_WIDTH;
    const x = Math.min(Math.max(anchorX - width / 2, innerLeft), innerLeft + innerWidth - width);

    // Center the block where a one-line label has always sat.
    const firstBaseline = anchorY - BASELINE_LIFT - ((lines.length - 1) * EDGE_LABEL_LINE_HEIGHT) / 2;
    return {
        edgeId: plan.edge.id,
        network: band.network,
        lines,
        x,
        y: firstBaseline - EDGE_LABEL_FONT_SIZE,
        width,
        height: lines.length * EDGE_LABEL_LINE_HEIGHT,
        firstBaseline,
    };
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
 *
 * Labels of one band can still meet (ovn-recon-nt4.10): node-replicated
 * constructs fanning into one construct (the cluster view, an expanded role
 * group) put their edge midpoints half a card pitch apart on one row. A label
 * that meets another wraps to the room between their anchors, never narrower
 * than its longest piece; one that still meets a label placed before it, or a
 * card, slides along its own edge, where fanning edges spread apart, and wraps
 * narrower there if it must. A label that meets nothing is left as it was.
 */
export const layoutEdgeLabels = (edges: LadderEdge[], layout: LadderLayout): Map<string, EdgeLabelBox> => {
    const plans: LabelPlan[] = [];
    for (const edge of edges) {
        const source = layout.positions[edge.source];
        const target = layout.positions[edge.target];
        if (!source || !target) continue;
        const segments = edgeLabelSegments(edge);
        if (segments.length === 0) continue;

        const band = bandAt(layout.bands, (source.x + target.x) / 2);
        if (!band) continue;

        const innerWidth = band.width - BAND_INSET * 2;
        const longest = Math.max(...segments.map((segment) => segment.length)) * EDGE_LABEL_CHAR_WIDTH;
        plans.push({
            edge, segments, band, source, target,
            minWidth: Math.min(longest, innerWidth),
            innerLeft: band.x + BAND_INSET,
            innerWidth,
        });
    }

    // As every label has always been placed: at its midpoint, as wide as its band allows.
    const initial = plans.map((plan) => boxAt(plan, 0.5, plan.innerWidth));

    // A label meeting another of its band wraps to the room between their anchors.
    const anchorX = (plan: LabelPlan) => (plan.source.x + plan.target.x) / 2;
    const widths = plans.map((plan, i) => {
        let room = plan.innerWidth;
        plans.forEach((other, j) => {
            if (i === j || other.band !== plan.band || !overlaps(initial[i], initial[j])) return;
            room = Math.min(room, Math.abs(anchorX(plan) - anchorX(other)) - LABEL_GAP);
        });
        return Math.max(room, plan.minWidth);
    });

    const cards: Rect[] = [
        ...Object.values(layout.positions),
        ...layout.aggregates,
    ].map(({ x, y }) => ({
        x: x - CONSTRUCT_WIDTH / 2, y: y - CONSTRUCT_HEIGHT / 2, width: CONSTRUCT_WIDTH, height: CONSTRUCT_HEIGHT,
    }));

    // Then, in edge order, each keeps its place unless it meets a label placed
    // before it or a card, in which case it takes the first clear spot along its edge.
    const boxes = new Map<string, EdgeLabelBox>();
    const placedByBand = new Map<LadderBand, EdgeLabelBox[]>();
    plans.forEach((plan, i) => {
        const placed = placedByBand.get(plan.band) ?? [];
        // Moving takes a clear gap; staying only needs not to overlap, so a label
        // that sits close to another but clear of it stays where it always was.
        const clear = (box: EdgeLabelBox, gap: number) =>
            placed.every((other) => !overlaps(box, other, gap))
            && cards.every((card) => !overlaps(box, card));

        let chosen = boxAt(plan, 0.5, widths[i]);
        if (!clear(chosen, 0)) {
            const tryWidths = [widths[i], plan.minWidth].filter((width, index, all) => all.indexOf(width) === index);
            search: for (const width of tryWidths) {
                for (const along of ANCHOR_STEPS) {
                    const candidate = boxAt(plan, along, width);
                    if (clear(candidate, LABEL_GAP)) {
                        chosen = candidate;
                        break search;
                    }
                }
            }
        }
        placed.push(chosen);
        placedByBand.set(plan.band, placed);
        boxes.set(plan.edge.id, chosen);
    });
    return boxes;
};
