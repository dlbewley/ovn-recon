import * as React from 'react';

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
    | 'attachment' | 'nad' | 'vrf' | 'lldp-neighbor' | 'integration-bridge' | 'other';

/**
 * The OVS integration bridge, synthesized from its ports: nmstate holds no
 * interface entry for br-int itself -- only ports declaring it as controller,
 * all state: ignore (ovn-recon-s3t.46).
 */
export interface IntegrationBridgeNode {
    name: string;
    /** Every interface declaring this bridge as its controller. */
    ports: import('../types').Interface[];
}

/** A synthetic node standing for the namespaces attached to a CUDN or UDN. */
export interface AttachmentNode {
    name: string;
    type: string;
    namespaces: string[];
    /** Name of the backing CUDN, when CUDN-backed. */
    cudn?: string;
    /**
     * Identity of the backing UDN, when UDN-backed. Held as its parts rather than a
     * joined string: namespaces and names both contain dashes, so a join cannot be
     * reliably undone to build the UDN's own node id.
     */
    udn?: { namespace: string; name: string };
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
    resourceRef?: ResourceRef;
    isSynthetic?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw?: any;
}

/**
 * How much a displayed value should be trusted, and why (ovn-recon-s3t.12).
 *
 * This is a recon tool: much of what it shows is worked out rather than read.
 * observed  -- read directly from reported state (NNS status, LLDP TLVs).
 * declared  -- read from a resource's spec or status field that asserts it.
 * inferred  -- produced by a heuristic; the fact's hint names the rule, so an
 *              operator debugging a mismatch knows which claims to distrust.
 */
export type Provenance = 'observed' | 'declared' | 'inferred';

/** One entry of a list-valued fact. `ref` links to a resource, `href` anywhere else. */
export interface FactItem {
    text: string;
    ref?: ResourceRef;
    href?: string;
}

export interface Fact {
    label: string;
    value: string | FactItem[];
    /** Renders the whole value as a link to this resource. */
    ref?: ResourceRef;
    provenance: Provenance;
    /** Why we believe this. Required in practice for anything inferred. */
    hint?: string;
    /** Rendered when a list value is empty; an empty list without one is omitted. */
    emptyText?: string;
}

export type DrawerTabId = 'overview' | 'relationships' | 'config';

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
    /**
     * The kind's drawer content as data: a pure, testable list of facts. One
     * shared renderer (FactList) handles presentation for every kind.
     */
    facts?: (node: NodeViewModel, ctx: GraphContextLike) => Fact[];
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
