import type { EdgeKind } from '../components/nodeVisualizationModel';
import type { Provenance } from './types';

/**
 * How the physical graph draws each kind of edge, and what to call it in the legend
 * (ovn-recon-nt4.2). The connector renderer and the legend both read this table, so
 * the legend cannot describe a stroke the canvas does not draw. Both records are
 * keyed by their union types, so a new edge kind or provenance that is not described
 * here is a compile error.
 */
export interface EdgeKindStyle {
    label: string;
    /** One sentence for the legend. */
    description: string;
    /** SVG stroke-dasharray, or none for a solid line. */
    dashArray?: string;
    /** Opacity at rest, before provenance or a highlight changes it. */
    opacity: number;
}

export const EDGE_KIND_STYLES: Record<EdgeKind, EdgeKindStyle> = {
    layering: {
        label: 'Flow',
        description: 'Traffic flows through: a VLAN on its base interface, a VF cut from its PF, a VRF out its egress interface.',
        opacity: 1
    },
    membership: {
        label: 'Membership',
        description: 'A port of its controller: a NIC in a bond or bridge, a management port in br-int and a VRF.',
        opacity: 1
    },
    reference: {
        label: 'Reference',
        description: 'A name for the same thing, or a declaration about it. Nothing flows through a dashed line.',
        dashArray: '6 4',
        opacity: 0.65
    },
    peer: {
        label: 'Peer',
        description: 'Two ends of one link: an LLDP neighbour on the far end of a cable, or a patch-port pair between bridges.',
        opacity: 1
    }
};

export interface ProvenanceStyle {
    label: string;
    description: string;
    /** Replaces the kind's opacity: an inferred edge draws faint whatever its kind. */
    opacity?: number;
}

export const PROVENANCE_STYLES: Record<Provenance, ProvenanceStyle> = {
    observed: {
        label: 'Observed',
        description: 'Read from state the node reports, such as NodeNetworkState status. Drawn at full strength, unmarked.'
    },
    declared: {
        label: 'Declared',
        description: 'Asserted by a resource\'s spec, such as a CUDN\'s physicalNetworkName. Drawn at full strength, unmarked.'
    },
    inferred: {
        label: 'Inferred',
        description: 'Deduced from a naming convention or an address match. Drawn faint, and flagged in the drawer with the rule that produced it.',
        opacity: 0.4
    }
};

/** Dash and opacity for an edge at rest (no highlight active). */
export const edgeAppearance = (
    kind: EdgeKind,
    provenance: Provenance
): { dashArray?: string; opacity: number } => ({
    dashArray: EDGE_KIND_STYLES[kind].dashArray,
    opacity: PROVENANCE_STYLES[provenance].opacity ?? EDGE_KIND_STYLES[kind].opacity
});
