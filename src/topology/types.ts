import * as React from 'react';

import { VrfAssociatedRoute } from '../components/nodeVisualizationSelectors';
import type { GraphContext as GraphContextLike } from './context';
import {
    ClusterUserDefinedNetwork,
    UserDefinedNetwork
} from '../types';

/**
 * The kinds of thing the physical topology graph can draw.
 *
 * Note that `other` is currently unreachable: buildNodeViewModel's ladder maps any
 * unrecognised interface type to `interface`, so nothing ever resolves to it. Left
 * in place because ovn-recon-s3t.8 gives unknown types an explicit home, which is
 * where this should either gain a use or be removed.
 */
export type NodeKind =
    | 'interface' | 'ovn-mapping' | 'cudn' | 'udn'
    | 'attachment' | 'nad' | 'vrf' | 'lldp-neighbor' | 'other';

/** A synthetic node standing for the namespaces attached to a CUDN or UDN. */
export interface AttachmentNode {
    name: string;
    type: string;
    namespaces: string[];
    cudn?: string;
    /** 'namespace-name' for UDN-backed attachments. */
    udnId?: string;
}

/** CUDNs and UDNs share the Networks lane but are different resources. */
export type NetworkColumnItem =
    | { kind: 'cudn'; item: ClusterUserDefinedNetwork }
    | { kind: 'udn'; item: UserDefinedNetwork };

export interface ResourceRef {
    apiVersion: string;
    kind: string;
    name: string;
    namespace?: string;
}

export interface NodeLink {
    label: string;
    href: string;
}

export interface NodeViewModel {
    id: string;
    kind: NodeKind;
    iconType: string;
    label: string;
    title: string;
    subtitle: string;
    /** Abbreviation used on the canvas, e.g. 'CUDN'; the subtitle is used in the drawer. */
    graphDisplayLabel?: string;
    state?: string;
    namespaces?: string[];
    badges?: string[];
    links?: NodeLink[];
    resourceRef?: ResourceRef;
    isSynthetic?: boolean;
    vrfRoutes?: VrfAssociatedRoute[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw?: any;
}

export type DrawerTabId = 'summary' | 'details' | 'links' | 'yaml';

export interface DrawerTabDefinition {
    id: DrawerTabId;
    title: string;
    render: (node: NodeViewModel) => React.ReactNode;
}

/**
 * Everything a node kind knows how to do. Widened by ovn-recon-s3t.9 into a full
 * descriptor that also owns the kind's lane, icon, colour and edges; today it
 * covers only the drawer.
 */
export interface NodeKindDefinition {
    label: string;
    buildBadges?: (node: NodeViewModel) => string[];
    buildLinks?: (node: NodeViewModel, ctx: GraphContextLike) => NodeLink[];
    renderSummary?: (node: NodeViewModel, ctx: GraphContextLike) => React.ReactNode;
    renderDetails?: (node: NodeViewModel, ctx: GraphContextLike) => React.ReactNode;
    /** Currently populated by no kind, so every kind gets DEFAULT_DRAWER_TABS. */
    tabs?: DrawerTabId[];
}

/** Adjacency used for path highlighting. */
export interface GraphNode {
    id: string;
    upstream: string[];
    downstream: string[];
}

export interface Graph {
    nodes: { [id: string]: GraphNode };
}
