import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import {
    Interface,
    LogicalTopologyWarning,
    LookupConstructKind,
    LookupField,
    LookupHit,
    LookupKind,
    LookupMatchType,
    LookupResponse,
    LookupTable,
    NodeNetworkState,
} from '../types';
import { resolveInterfaceLinkRef } from '../topology/ids';
import { getResourcePath } from '../topology/links';
import { networkCidr, ParsedPrefix, parsePrefix, prefixContains } from './ipPrefix';
import { buildKernelRouteTables, kernelTableLabel, KernelRouteRow, KernelRouteTableGroup } from './kernelRoutes';
import { networkResourceRef } from './logicalClassification';
import { getRunningRoutes } from './nodeVisualizationSelectors';
import { clusterLogicalPath, nodeLogicalPath, nodePhysicalPath, overviewSearchPath, SEARCH_PARAM } from '../routes';
import { encodeSelectValue } from './useSelectParam';

/**
 * The cluster-wide search behind the overview's search box (ovn-recon-tpp.2):
 * "where is this IP, MAC, pod or network?".
 *
 * Pure. One answer is assembled from two sources:
 *
 *   collector  the lookup endpoint over every cached zone snapshot
 *              (ovn-recon-tpp.1): switch and router ports, NAT rules, static
 *              routes, switch subnets, load balancer VIPs
 *   cluster    what the overview already watches: each node's
 *              NodeNetworkState (interface addresses, MACs and names, kernel
 *              routes) and the Node addresses
 *
 * Three rules shape the result:
 *
 * - A hit that IS the searched thing and a hit that merely COVERS it are
 *   never mixed. A route or subnet containing the address is a covering hit;
 *   one pod address has about three per zone, so they are folded into one
 *   group per router, switch or node and kept apart from the results.
 * - The same row seen from several zones (or the same interface on several
 *   nodes) is one result that lists every place. Zones are folded; networks
 *   never are: user-defined network subnets may overlap, so the same address
 *   in two networks is two results, and none is "the" answer.
 * - Nothing is hidden silently. What was not searched (collector off or
 *   unreachable, a zone with no cached snapshot, hits cut by the limit) is
 *   reported next to the results.
 *
 * And the answer comes first (ovn-recon-tpp.8). OVN-Kubernetes writes many
 * rows per object: a Service is a load balancer per protocol per node
 * (`Service_<ns>/<name>_TCP_node_router_<node>`), a node bridge is a
 * localnet port per node (`br-ex_<node>`). Those are folded into one row
 * that keeps every underlying row as a member, with its own place and links:
 * a Service VIP by Service, network and address, with its ports and the
 * zones that program it; any other row whose name differs from zone to zone
 * only by that zone's node name, by its name with the node left out. A name
 * search ranks exact names first, then names that start with the text, then
 * names that merely contain it, and so do the groups.
 */

/* ------------------------------------------------------------------ */
/* Reading the input                                                   */
/* ------------------------------------------------------------------ */

export interface SearchQuery {
    kind: LookupKind;
    /** The input as typed, trimmed. */
    text: string;
    /**
     * The input as it was read, and as it is sent to the collector: an
     * address in canonical spelling, a CIDR masked to its network, a MAC in
     * lower-case colon form, a name as typed.
     */
    value: string;
    /** The parsed address or prefix of an `ip` or `cidr` query. */
    prefix?: ParsedPrefix;
}

// The spellings Go's net.ParseMAC reads for a 48-bit address, which is what
// the collector accepts: colons, dashes, or three dotted groups.
const MAC_SPELLINGS = [
    /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i,
    /^[0-9a-f]{2}(-[0-9a-f]{2}){5}$/i,
    /^[0-9a-f]{4}(\.[0-9a-f]{4}){2}$/i,
];

/** A MAC in lower-case colon form, or null when the text is not one. */
export const normalizeMac = (text: string | undefined): string | null => {
    const trimmed = (text ?? '').trim();
    if (!MAC_SPELLINGS.some((spelling) => spelling.test(trimmed))) return null;
    const digits = trimmed.replace(/[^0-9a-f]/gi, '').toLowerCase();
    return (digits.match(/.{2}/g) ?? []).join(':');
};

/**
 * Read the search box: a MAC, an IPv4 or IPv6 address, a CIDR, and anything
 * else a name. Null for an empty box. A MAC is tried first; its colon form is
 * six groups, which is never a valid IPv6 address, so the two cannot be
 * confused.
 */
export const detectSearchQuery = (input: string): SearchQuery | null => {
    const text = input.trim();
    if (text === '') return null;
    const mac = normalizeMac(text);
    if (mac) return { kind: 'mac', text, value: mac };
    const prefix = parsePrefix(text);
    if (prefix) {
        if (text.includes('/')) return { kind: 'cidr', text, value: networkCidr(prefix), prefix };
        // networkCidr on a host prefix is the canonical address plus its
        // full-length mask.
        return { kind: 'ip', text, value: networkCidr(prefix).split('/')[0], prefix };
    }
    return { kind: 'name', text, value: text };
};

/** How the input was read, for "Searching for …": `IP 10.1.2.3`, `name "blue"`. */
export const describeSearchQuery = (query: SearchQuery): string => {
    if (query.kind === 'ip') return `IP ${query.value}`;
    if (query.kind === 'cidr') return `CIDR ${query.value}`;
    if (query.kind === 'mac') return `MAC ${query.value}`;
    return `name "${query.value}"`;
};

/* ------------------------------------------------------------------ */
/* The search in the page URL                                          */
/* ------------------------------------------------------------------ */

/**
 * The overview keeps the submitted search in `?q=`, so a result link can be
 * followed and Back returns to the same results, and so another view can open
 * the overview on a search. This is the page's own URL: the rule that query
 * strings never reach the collector does not apply to it.
 */
export { SEARCH_PARAM };

/** The submitted search in a location's search string; '' when absent. */
export const readSearchParam = (search: string): string =>
    (new URLSearchParams(search).get(SEARCH_PARAM) ?? '').trim();

const pairName = (pair: string): string => {
    const name = pair.split('=')[0];
    try {
        return decodeURIComponent(name);
    } catch {
        return name;
    }
};

/**
 * The search string with `q` set to the value, or removed when it is empty.
 * Other parameters keep their order and exact encoding, like the select
 * parameter's writer.
 */
export const withSearchParam = (search: string, value: string): string => {
    const kept = search.replace(/^\?/, '').split('&').filter((pair) => pair && pairName(pair) !== SEARCH_PARAM);
    const text = value.trim();
    if (text !== '') kept.push(`${SEARCH_PARAM}=${encodeSelectValue(text)}`);
    return kept.length > 0 ? `?${kept.join('&')}` : '';
};

/** The overview opened on a search: the target of a "Find in cluster" link. */
export { overviewSearchPath };

/* ------------------------------------------------------------------ */
/* Links                                                               */
/* ------------------------------------------------------------------ */

export type SearchLinkView = 'logical' | 'cluster' | 'physical' | 'owner';

export interface SearchLink {
    view: SearchLinkView;
    label: string;
    href: string;
}

export interface SearchConstruct {
    kind: LookupConstructKind;
    name: string;
}

/** A node's logical view, with a switch or router selected when one is given. */
export const logicalViewPath = (node: string, construct?: SearchConstruct): string => nodeLogicalPath(node, construct);

/** The cluster logical view with a switch or router selected. */
export const clusterViewPath = (construct: SearchConstruct): string => clusterLogicalPath(construct);

/** A node's physical view, with a canonical node id (`iface:br-ex`) selected when one is given. */
export const physicalViewPath = (node: string, nodeId?: string): string => nodePhysicalPath(node, nodeId);

const logicalLink = (node: string, construct: SearchConstruct): SearchLink =>
    ({ view: 'logical', label: 'Logical view', href: logicalViewPath(node, construct) });

const physicalLink = (node: string, nodeId?: string): SearchLink =>
    ({ view: 'physical', label: 'Physical view', href: physicalViewPath(node, nodeId) });

const clusterLink = (construct: SearchConstruct): SearchLink =>
    ({ view: 'cluster', label: 'Cluster view', href: clusterViewPath(construct) });

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

export type SearchSource = 'collector' | 'cluster';

export type SearchResultKind =
    | 'pod-port'
    | 'switch-port'
    | 'router-port'
    | 'nat'
    | 'service-vip'
    | 'node-interface'
    | 'route'
    | 'construct';

/** Group order on the page, and each group's heading. */
export const RESULT_KINDS: readonly { kind: SearchResultKind; label: string }[] = [
    { kind: 'pod-port', label: 'Pod and VM ports' },
    { kind: 'switch-port', label: 'Other switch ports' },
    { kind: 'router-port', label: 'Router ports' },
    { kind: 'nat', label: 'NAT rules' },
    { kind: 'service-vip', label: 'Service VIPs' },
    { kind: 'node-interface', label: 'Node interfaces' },
    { kind: 'route', label: 'Routes' },
    { kind: 'construct', label: 'Switches and routers' },
];

/** One place a result was found: a zone for a collector hit, a node for a cluster hit. */
export interface SearchPlace {
    node: string;
    /** Opens that node's view with the object selected. Absent when there is nothing to select. */
    link?: SearchLink;
    /** When the zone's snapshot was collected (collector hits). */
    snapshotGeneratedAt?: string;
}

export interface SearchOwner {
    kind: string;
    namespace?: string;
    name: string;
    /** The owner's console page, for the kinds whose path is known. */
    href?: string;
    /** `VM <name>` on a virt-launcher pod. */
    note?: string;
}

/**
 * How a result matched: the collector's match types, plus `prefix` for a
 * name that starts with the searched text. The collector reports that as a
 * substring; it is told apart here so it ranks between exact and substring.
 */
export type SearchMatchType = LookupMatchType | 'prefix';

export interface SearchMatch {
    type: SearchMatchType;
    /** What matched, in words: `address`, `MAC`, `VIP`, `name`. */
    field: string;
    /** The matched value as stored. */
    value: string;
    /** `node InternalIP` when the address is also the Node's own. */
    note?: string;
}

export interface SearchResult {
    key: string;
    kind: SearchResultKind;
    source: SearchSource;
    /** The row's name, or what it is when the table has no name column. */
    title: string;
    /** What kind of row, and what it belongs to: `Switch port on switch node-a`. */
    subtitle?: string;
    match: SearchMatch;
    /** The OVN network identity (`default`, `cluster_udn_<name>`, `<namespace>_<name>`). */
    network?: string;
    /** For a hit with no OVN network: the kernel table or VRF it sits in. */
    context?: string;
    owner?: SearchOwner;
    /** The switch or router a collector hit belongs to (or is). */
    construct?: SearchConstruct;
    /** Every zone or node holding this result. */
    places: SearchPlace[];
    /** Links that are not tied to one place: the cluster view of a multi-zone result. */
    links: SearchLink[];
    /** A Service VIP: the ports programmed on the address, as `53/TCP`, sorted. */
    ports?: string[];
    /** A Service VIP: in how many of the searched zones the address is programmed. */
    zones?: ZoneCount;
    /**
     * A folded row: the rows it stands for (a Service's load balancers, a
     * per-node port on each node), each with its own place and links.
     */
    members?: SearchResult[];
}

export interface ZoneCount {
    /** Searched zones holding the result. */
    found: number;
    /** Zones the collector searched. */
    searched: number;
    /** Searched zones without it, sorted. */
    missing: string[];
    /**
     * The collector cut its hits to the limit, so a zone may be missing
     * only because its hit was cut.
     */
    incomplete?: boolean;
}

export interface SearchResultGroup {
    kind: SearchResultKind;
    label: string;
    results: SearchResult[];
}

/** One covering prefix inside a group, with every zone or node that holds it. */
export interface CoveringEntry {
    key: string;
    /** `Static route`, `Subnet`, `NAT logical IP`, `Kernel route`. */
    what: string;
    prefix: string;
    /** Kernel routes: next hops and table. */
    detail?: string;
    places: SearchPlace[];
}

/**
 * The routes and subnets of one router, switch or node kernel that contain
 * the searched address without being about it.
 */
export interface CoveringGroup {
    key: string;
    source: SearchSource;
    /** `Router ovn_cluster_router`, `Switch node-a`, `Kernel routes on node-a`. */
    label: string;
    construct?: SearchConstruct;
    network?: string;
    entries: CoveringEntry[];
    /** Raw hits folded into this group. */
    hitCount: number;
    /** Distinct zones or nodes across the entries, sorted. */
    nodes: string[];
    links: SearchLink[];
}

/* ------------------------------------------------------------------ */
/* Collector hits                                                      */
/* ------------------------------------------------------------------ */

const TABLE_LABEL: Record<LookupTable, string> = {
    Logical_Switch: 'Logical switch',
    Logical_Router: 'Logical router',
    Logical_Switch_Port: 'Switch port',
    Logical_Router_Port: 'Router port',
    NAT: 'NAT rule',
    Logical_Router_Static_Route: 'Static route',
    Load_Balancer: 'Load balancer',
};

const FIELD_LABEL: Record<LookupField, string> = {
    name: 'name',
    addresses: 'address',
    dynamicAddresses: 'dynamic address',
    portSecurity: 'port security',
    networks: 'network',
    mac: 'MAC',
    externalIp: 'external IP',
    logicalIp: 'logical IP',
    externalMac: 'external MAC',
    ipPrefix: 'prefix',
    vips: 'VIP',
    'otherConfig.subnet': 'subnet',
    'otherConfig.ipv6_prefix': 'IPv6 prefix',
    'externalIds.namespace': 'namespace',
    'externalIds.k8s.ovn.org/network': 'network identity',
};

const kindOfHit = (hit: LookupHit): SearchResultKind => {
    switch (hit.table) {
        case 'Logical_Switch_Port':
            return hit.owner?.kind === 'Pod' ? 'pod-port' : 'switch-port';
        case 'Logical_Router_Port':
            return 'router-port';
        case 'NAT':
            return 'nat';
        case 'Load_Balancer':
            return 'service-vip';
        case 'Logical_Router_Static_Route':
            return 'route';
        default:
            return 'construct';
    }
};

// KubeVirt names a VM's pod virt-launcher-<vm>-<five generated characters>.
const VIRT_LAUNCHER = /^virt-launcher-(.+)-[a-z0-9]{5}$/;

/** The VM a virt-launcher pod runs, or undefined for any other pod. */
export const vmOfLauncherPod = (podName: string): string | undefined => VIRT_LAUNCHER.exec(podName)?.[1];

// The owner kinds whose console page is known. Everything else stays text.
const OWNER_API_VERSION: Record<string, string> = { Pod: 'v1', Service: 'v1' };

const ownerOfHit = (hit: LookupHit): SearchOwner | undefined => {
    if (!hit.owner) return undefined;
    const { kind, namespace, name } = hit.owner;
    const owner: SearchOwner = { kind, name };
    if (namespace) owner.namespace = namespace;
    const apiVersion = OWNER_API_VERSION[kind];
    if (apiVersion && namespace) owner.href = getResourcePath({ apiVersion, kind, namespace, name });
    const vm = kind === 'Pod' ? vmOfLauncherPod(name) : undefined;
    if (vm) owner.note = `VM ${vm}`;
    return owner;
};

const constructOfHit = (hit: LookupHit): SearchConstruct | undefined =>
    hit.construct ? { kind: hit.construct.kind, name: hit.construct.name } : undefined;

const isConstructRow = (hit: LookupHit): boolean => hit.table === 'Logical_Switch' || hit.table === 'Logical_Router';

const subtitleOfHit = (hit: LookupHit): string => {
    const table = TABLE_LABEL[hit.table] ?? hit.table;
    if (isConstructRow(hit)) return table;
    const where = hit.construct ? `on ${hit.construct.kind} ${hit.construct.name}` : '';
    // A table with no name column is titled by its table label already.
    return hit.rowName ? [table, where].filter(Boolean).join(' ') : where;
};

/**
 * The identity of a hit apart from its zone. Row UUIDs are per database, so
 * the same row in two zones shares everything here and nothing else. The
 * network and the construct are part of it: the same address in two networks
 * stays two results.
 */
const hitIdentity = (hit: LookupHit): string =>
    [
        hit.table,
        hit.rowName ?? '',
        hit.construct ? `${hit.construct.kind}:${hit.construct.name}` : '',
        hit.network,
        hit.matchedField,
        hit.matchedValue,
        hit.matchType,
        hit.owner ? `${hit.owner.kind}/${hit.owner.namespace ?? ''}/${hit.owner.name}` : '',
    ].join('|');

const placeOfHit = (hit: LookupHit): SearchPlace => {
    const construct = constructOfHit(hit);
    const place: SearchPlace = { node: hit.node, snapshotGeneratedAt: hit.snapshotGeneratedAt };
    if (construct) place.link = logicalLink(hit.node, construct);
    return place;
};

/** A collector hit as a result in one place; folding adds the other zones. */
export const resultOfHit = (hit: LookupHit): SearchResult => {
    const result: SearchResult = {
        key: `collector|${hitIdentity(hit)}`,
        kind: kindOfHit(hit),
        source: 'collector',
        title: hit.rowName || (TABLE_LABEL[hit.table] ?? hit.table),
        match: {
            type: hit.matchType,
            field: FIELD_LABEL[hit.matchedField] ?? hit.matchedField,
            value: hit.matchedValue,
        },
        network: hit.network,
        places: [placeOfHit(hit)],
        links: [],
    };
    const subtitle = subtitleOfHit(hit);
    if (subtitle) result.subtitle = subtitle;
    const owner = ownerOfHit(hit);
    if (owner) result.owner = owner;
    const construct = constructOfHit(hit);
    if (construct) result.construct = construct;
    return result;
};

/**
 * Fold results that differ only in where they were found into one result
 * listing every place, in first-seen order. A result seen in several zones
 * gains a link to the cluster view, where the construct is one card.
 */
export const foldResults = (results: SearchResult[]): SearchResult[] => {
    const folded = new Map<string, SearchResult>();
    for (const result of results) {
        const existing = folded.get(result.key);
        if (!existing) {
            folded.set(result.key, { ...result, places: [...result.places], links: [...result.links] });
            continue;
        }
        for (const place of result.places) {
            if (!existing.places.some((other) => other.node === place.node)) existing.places.push(place);
        }
    }
    return Array.from(folded.values()).map((result) => {
        if (result.source !== 'collector' || !result.construct || result.places.length < 2) return result;
        return { ...result, links: [...result.links, clusterLink(result.construct)] };
    });
};

const prefixLengthOf = (text: string): number => parsePrefix(text)?.length ?? -1;

const sortedUnique = (values: string[]): string[] => Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));

const coveringWhat = (hit: LookupHit): string => {
    if (hit.table === 'Logical_Router_Static_Route') return 'Static route';
    if (hit.table === 'Logical_Switch') return hit.matchedField === 'otherConfig.ipv6_prefix' ? 'IPv6 prefix' : 'Subnet';
    if (hit.table === 'NAT') return `NAT ${FIELD_LABEL[hit.matchedField] ?? hit.matchedField}`;
    return `${TABLE_LABEL[hit.table] ?? hit.table} ${FIELD_LABEL[hit.matchedField] ?? hit.matchedField}`;
};

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Containment hits as groups: one per router or switch name within a network,
 * across every zone that has it. Inside a group the same prefix seen from
 * several zones is one entry, longest prefix first.
 */
export const coveringGroupsOfHits = (hits: LookupHit[]): CoveringGroup[] => {
    const groups = new Map<string, CoveringGroup>();
    const entries = new Map<string, CoveringEntry>();
    for (const hit of hits) {
        const construct = constructOfHit(hit);
        const key = construct
            ? `collector|${construct.kind}:${construct.name}|${hit.network}`
            : `collector|unattached|${hit.table}|${hit.network}`;
        let group = groups.get(key);
        if (!group) {
            group = {
                key,
                source: 'collector',
                label: construct
                    ? `${capitalize(construct.kind)} ${construct.name}`
                    : `${TABLE_LABEL[hit.table] ?? hit.table} rows attached to no switch or router`,
                network: hit.network,
                entries: [],
                hitCount: 0,
                nodes: [],
                links: [],
            };
            if (construct) group.construct = construct;
            groups.set(key, group);
        }
        group.hitCount += 1;
        const entryKey = `${key}|${hit.table}|${hit.matchedField}|${hit.matchedValue}`;
        let entry = entries.get(entryKey);
        if (!entry) {
            entry = { key: entryKey, what: coveringWhat(hit), prefix: hit.matchedValue, places: [] };
            entries.set(entryKey, entry);
            group.entries.push(entry);
        }
        if (!entry.places.some((place) => place.node === hit.node)) entry.places.push(placeOfHit(hit));
    }
    return Array.from(groups.values()).map((group) => {
        const nodes = sortedUnique(group.entries.flatMap((entry) => entry.places.map((place) => place.node)));
        return {
            ...group,
            entries: [...group.entries].sort(
                (a, b) => prefixLengthOf(b.prefix) - prefixLengthOf(a.prefix) || a.prefix.localeCompare(b.prefix),
            ),
            nodes,
            links: group.construct && nodes.length > 1 ? [clusterLink(group.construct)] : [],
        };
    });
};

/* ------------------------------------------------------------------ */
/* Name ranking                                                        */
/* ------------------------------------------------------------------ */

/**
 * A name match ranked against the searched text: `exact` when the stored
 * value is the text in any case, `prefix` when it starts with it, else as
 * it came. Matches of an address or MAC query are left as they are.
 */
export const rankNameMatch = (query: SearchQuery, match: SearchMatch): SearchMatch => {
    if (query.kind !== 'name' || (match.type !== 'substring' && match.type !== 'prefix')) return match;
    const value = match.value.toLowerCase();
    const needle = query.value.toLowerCase();
    if (value === needle) return { ...match, type: 'exact' };
    if (value.startsWith(needle)) return { ...match, type: 'prefix' };
    return { ...match, type: 'substring' };
};

/* ------------------------------------------------------------------ */
/* Service VIPs: one row per Service and address                       */
/* ------------------------------------------------------------------ */

// OVN-Kubernetes names a Service's load balancers
// Service_<namespace>/<name>_<protocol>_<cluster | node_router_<node> | ...>,
// sometimes behind a network prefix. Namespaces and Service names are DNS
// labels, so neither holds an underscore.
const SERVICE_LOAD_BALANCER = /Service_([a-z0-9.-]+)\/([a-z0-9.-]+)_(TCP|UDP|SCTP)(?:_|$)/i;

/** The Service and protocol a load balancer row is named for, when its name follows the OVN-Kubernetes form. */
export const serviceOfLoadBalancerName = (
    name: string | undefined,
): { namespace: string; name: string; protocol: string } | undefined => {
    const parsed = SERVICE_LOAD_BALANCER.exec(name ?? '');
    return parsed ? { namespace: parsed[1], name: parsed[2], protocol: parsed[3].toUpperCase() } : undefined;
};

/**
 * A load balancer `vips` key read as address and port: `198.51.100.10:443`,
 * `[2001:db8::10]:443`, or an address with no port. The address is in
 * canonical spelling, so the same VIP written two ways is one.
 */
export const parseVip = (vip: string): { address: string; port?: string } => {
    const bracketed = /^\[(.+)\]:(\d+)$/.exec(vip);
    const v4 = /^([^:]+):(\d+)$/.exec(vip);
    const [address, port] = bracketed ? [bracketed[1], bracketed[2]] : v4 ? [v4[1], v4[2]] : [vip.replace(/^\[|\]$/g, ''), undefined];
    const parsed = parsePrefix(address);
    const canonical = parsed ? networkCidr(parsed).split('/')[0] : address;
    return port ? { address: canonical, port } : { address: canonical };
};

const ownerIdentity = (owner: SearchOwner | undefined): string =>
    owner ? `${owner.kind}/${owner.namespace ?? ''}/${owner.name}` : '';

const compareByPlace = (a: SearchResult, b: SearchResult): number =>
    (a.places[0]?.node ?? '').localeCompare(b.places[0]?.node ?? '') || a.title.localeCompare(b.title) || a.key.localeCompare(b.key);

const unionPlaces = (members: SearchResult[]): SearchPlace[] => {
    const places = new Map<string, SearchPlace>();
    for (const member of members) {
        for (const place of member.places) {
            if (!places.has(place.node)) places.set(place.node, place);
        }
    }
    return Array.from(places.values()).sort((a, b) => a.node.localeCompare(b.node));
};

const bestMatchType = (members: SearchResult[]): SearchMatchType =>
    members.map((member) => member.match.type).sort((a, b) => MATCH_RANK[a] - MATCH_RANK[b])[0];

/** The best-ranked member's name match, with its node name left out when it holds one. */
const nameMatchOf = (members: SearchResult[]): SearchMatch => {
    const best = [...members].sort((a, b) => MATCH_RANK[a.match.type] - MATCH_RANK[b.match.type])[0];
    const node = best.places[0]?.node ?? '';
    return { ...best.match, value: members.length > 1 ? withoutNodeName(best.match.value, node) : best.match.value };
};

const comparePorts = (a: string, b: string): number => {
    const [portA, protocolA] = a.split('/');
    const [portB, protocolB] = b.split('/');
    return Number(portA) - Number(portB) || (protocolA ?? '').localeCompare(protocolB ?? '');
};

/**
 * Service VIP hits as one result per Service, network and VIP address. A
 * Service is a load balancer per protocol in each zone, and often one for
 * the node router and one for the node switch, so one ClusterIP on ten
 * nodes is forty hits; here it is one row with its ports, the zones that
 * program it out of the zones searched, and every load balancer row as a
 * member. A load balancer with no Service owner and no Service name is a
 * Service of its own, under its row name.
 *
 * The collector reports one hit per load balancer row; `matchedValues`
 * carries every VIP of the row that matched, so a second port of the same
 * address in the same row is a port here too. An older collector sends only
 * `matchedValue`, the first.
 */
export const foldServiceVips = (
    hits: LookupHit[],
    searchedZones: string[],
    options: { query?: SearchQuery; truncated?: boolean } = {},
): SearchResult[] => {
    // A name search finds load balancers by row name: those fold by Service
    // alone, with no address.
    const buckets = new Map<string, { hits: LookupHit[]; address?: string }>();
    for (const vipHit of hits) {
        const address = vipHit.matchedField === 'vips' ? parseVip(vipHit.matchedValue).address : undefined;
        const named = serviceOfLoadBalancerName(vipHit.rowName);
        const service = vipHit.owner
            ? `${vipHit.owner.kind}/${vipHit.owner.namespace ?? ''}/${vipHit.owner.name}`
            : named ? `Service/${named.namespace}/${named.name}` : `row/${vipHit.rowName ?? vipHit.rowUuid}`;
        const key = `collector|service|${vipHit.network}|${service}|${address ?? 'name'}`;
        const bucket = buckets.get(key) ?? { hits: [], address };
        bucket.hits.push(vipHit);
        buckets.set(key, bucket);
    }
    const searched = sortedUnique(searchedZones);
    return Array.from(buckets.entries()).map(([key, bucket]) => {
        const first = bucket.hits[0];
        const members = foldResults(bucket.hits.map((vipHit) => {
            const member = resultOfHit(vipHit);
            return options.query ? { ...member, match: rankNameMatch(options.query, member.match) } : member;
        })).sort(compareByPlace);
        const named = bucket.hits.map((vipHit) => serviceOfLoadBalancerName(vipHit.rowName)).find(Boolean);
        let owner = members.find((member) => member.owner)?.owner;
        if (!owner && named) {
            owner = {
                kind: 'Service',
                namespace: named.namespace,
                name: named.name,
                href: getResourcePath({ apiVersion: 'v1', kind: 'Service', namespace: named.namespace, name: named.name }),
            };
        }
        const ports = new Set<string>();
        for (const vipHit of bucket.hits) {
            if (vipHit.matchedField !== 'vips') continue;
            const protocol = serviceOfLoadBalancerName(vipHit.rowName)?.protocol;
            for (const value of vipHit.matchedValues?.length ? vipHit.matchedValues : [vipHit.matchedValue]) {
                const { port } = parseVip(value);
                if (port) ports.add(protocol ? `${port}/${protocol}` : port);
            }
        }
        const places = unionPlaces(members);
        const found = new Set(places.map((place) => place.node));
        const zones: ZoneCount = {
            found: searched.filter((zone) => found.has(zone)).length,
            searched: searched.length,
            missing: searched.filter((zone) => !found.has(zone)),
        };
        if (options.truncated) zones.incomplete = true;
        const result: SearchResult = {
            key,
            kind: 'service-vip',
            source: 'collector',
            title: owner ? (owner.namespace ? `${owner.namespace}/${owner.name}` : owner.name) : (first.rowName || 'Load balancer'),
            subtitle: `Service VIP · ${members.length} load balancer ${members.length === 1 ? 'row' : 'rows'}`,
            match: bucket.address !== undefined
                ? { type: bestMatchType(members), field: 'VIP', value: bucket.address }
                : nameMatchOf(members),
            network: first.network,
            places,
            links: [],
            ports: Array.from(ports).sort(comparePorts),
            zones,
            members,
        };
        if (owner) result.owner = owner;
        return result;
    });
};

/* ------------------------------------------------------------------ */
/* Rows named after their node: one row across nodes                   */
/* ------------------------------------------------------------------ */

/** What stands for the node name in a row folded across nodes. */
export const NODE_PLACEHOLDER = '<node>';

const isNameCharacter = (character: string | undefined): boolean =>
    character !== undefined && /[A-Za-z0-9]/.test(character);

/**
 * The text with every whole occurrence of the node name replaced by
 * NODE_PLACEHOLDER. "Whole" means not inside a longer name: `node-1` is
 * not replaced in `node-10`.
 */
export const withoutNodeName = (text: string, node: string): string => {
    if (!node) return text;
    let out = '';
    let from = 0;
    for (let at = text.indexOf(node); at !== -1; at = text.indexOf(node, at + node.length)) {
        if (isNameCharacter(text[at - 1]) || isNameCharacter(text[at + node.length])) continue;
        out += text.slice(from, at) + NODE_PLACEHOLDER;
        from = at + node.length;
    }
    return out + text.slice(from);
};

/**
 * Fold collector results that are one object per node: rows found in a
 * single zone whose name, construct or matched value differ from zone to
 * zone only by that zone's node name (`br-ex_node-a` on switch
 * `ext_node-a`, `br-ex_node-b` on `ext_node-b`). They become one row named
 * with NODE_PLACEHOLDER, listing every node, with the original rows as
 * members. A row already seen in several zones under one name is the same
 * row everywhere and is left as it is; so is a row whose name holds no node
 * name, and a group of one. Network, owner, kind and match type are part of
 * the identity, so rows in two networks never fold.
 */
export const foldAcrossNodes = (results: SearchResult[]): SearchResult[] => {
    const order: (SearchResult | string)[] = [];
    const buckets = new Map<string, { members: SearchResult[]; title: string; subtitle?: string; value: string }>();
    for (const result of results) {
        const node = result.source === 'collector' && result.places.length === 1 && !result.members
            ? result.places[0].node
            : undefined;
        if (!node) {
            order.push(result);
            continue;
        }
        const title = withoutNodeName(result.title, node);
        const construct = result.construct ? withoutNodeName(result.construct.name, node) : '';
        if (title === result.title && construct === (result.construct?.name ?? '')) {
            order.push(result);
            continue;
        }
        const subtitle = result.subtitle === undefined ? undefined : withoutNodeName(result.subtitle, node);
        const value = withoutNodeName(result.match.value, node);
        const key = [
            'fold', result.kind, result.network ?? '', title, subtitle ?? '',
            result.construct ? `${result.construct.kind}:${construct}` : '',
            result.match.field, value, result.match.type, ownerIdentity(result.owner), result.context ?? '',
        ].join('|');
        let bucket = buckets.get(key);
        if (!bucket) {
            bucket = { members: [], title, subtitle, value };
            buckets.set(key, bucket);
            order.push(key);
        }
        bucket.members.push(result);
    }
    return order.map((entry) => {
        if (typeof entry !== 'string') return entry;
        const bucket = buckets.get(entry) as { members: SearchResult[]; title: string; subtitle?: string; value: string };
        if (bucket.members.length === 1) return bucket.members[0];
        const members = [...bucket.members].sort(compareByPlace);
        const first = members[0];
        const folded: SearchResult = {
            ...first,
            key: entry,
            title: bucket.title,
            match: { ...first.match, value: bucket.value },
            places: unionPlaces(members),
            links: [],
            members,
        };
        if (bucket.subtitle !== undefined) folded.subtitle = bucket.subtitle;
        delete folded.construct;
        return folded;
    });
};

/* ------------------------------------------------------------------ */
/* Cluster hits: what the overview already watches                     */
/* ------------------------------------------------------------------ */

export interface WatchedSources {
    nodeNetworkStates: NodeNetworkState[];
    /** Node resources, read for status.addresses only. */
    nodes?: K8sResourceCommon[];
}

interface NodeAddress {
    type: string;
    address: string;
}

const nodeAddressesOf = (node: K8sResourceCommon): NodeAddress[] => {
    const addresses = (node as { status?: { addresses?: unknown } }).status?.addresses;
    if (!Array.isArray(addresses)) return [];
    return addresses.filter(
        (entry): entry is NodeAddress =>
            Boolean(entry) && typeof entry.type === 'string' && typeof entry.address === 'string',
    );
};

interface InterfaceAddress {
    /** `192.0.2.27/25`, as nmstate reports it. */
    text: string;
    parsed: ParsedPrefix;
}

const interfaceAddresses = (iface: Interface): InterfaceAddress[] => {
    const entries = [
        ...(Array.isArray(iface.ipv4?.address) ? iface.ipv4.address : []),
        ...(Array.isArray(iface.ipv6?.address) ? iface.ipv6.address : []),
    ];
    const addresses: InterfaceAddress[] = [];
    for (const entry of entries) {
        if (!entry || typeof entry.ip !== 'string') continue;
        const length = entry['prefix-length'] ?? entry.prefix_length;
        const text = length === undefined ? entry.ip : `${entry.ip}/${length}`;
        const parsed = parsePrefix(text);
        if (parsed) addresses.push({ text, parsed });
    }
    return addresses;
};

/** The VRF each enslaved interface belongs to, by interface name. */
const vrfByPort = (interfaces: Interface[]): Map<string, string> => {
    const vrfs = new Map<string, string>();
    for (const iface of interfaces) {
        if (iface.type !== 'vrf') continue;
        const ports = iface.vrf?.port;
        for (const port of Array.isArray(ports) ? ports : typeof ports === 'string' ? [ports] : []) {
            vrfs.set(port, iface.name);
        }
    }
    return vrfs;
};

const sameAddress = (a: ParsedPrefix, b: ParsedPrefix): boolean => a.family === b.family && a.address === b.address;

const isHost = (prefix: ParsedPrefix): boolean => prefix.length === (prefix.family === 4 ? 32 : 128);

/** An interface address as a host prefix: the address alone, without its mask. */
const hostOf = (address: ParsedPrefix): ParsedPrefix => {
    const width = address.family === 4 ? 32 : 128;
    return { family: address.family, address: address.address, network: address.address, length: width };
};

/**
 * How a stored destination relates to an `ip` or `cidr` query, in the
 * collector's terms: `exact` the same prefix (a host route to the searched
 * address counts), `containment` it covers the query, `within` it lies
 * inside the queried CIDR. A default route covers everything and so says
 * nothing: it is never a match.
 */
const relateDestination = (query: ParsedPrefix, stored: ParsedPrefix): LookupMatchType | null => {
    if (stored.family !== query.family) return null;
    if (stored.length === query.length && stored.network === query.network) return 'exact';
    if (stored.length === 0) return null;
    if (prefixContains(stored, query)) return 'containment';
    if (prefixContains(query, stored)) return 'within';
    return null;
};

interface InterfaceMatch {
    match: SearchMatch;
}

const matchInterface = (query: SearchQuery, iface: Interface, nodeAddresses: NodeAddress[]): InterfaceMatch[] => {
    const matches: InterfaceMatch[] = [];
    if (query.kind === 'ip' || query.kind === 'cidr') {
        const wanted = query.prefix as ParsedPrefix;
        for (const address of interfaceAddresses(iface)) {
            // A port's address matches on the address, never by the mask
            // beside it: the collector's rule for ports, kept here.
            const type: LookupMatchType | null = query.kind === 'ip'
                ? (sameAddress(wanted, address.parsed) ? 'exact' : null)
                : (prefixContains(wanted, hostOf(address.parsed)) ? (isHost(wanted) ? 'exact' : 'within') : null);
            if (!type) continue;
            const match: SearchMatch = { type, field: 'address', value: address.text };
            const nodeAddress = nodeAddresses.find((entry) => {
                const parsed = parsePrefix(entry.address);
                return parsed !== null && sameAddress(parsed, address.parsed);
            });
            if (nodeAddress) match.note = `node ${nodeAddress.type}`;
            matches.push({ match });
        }
    } else if (query.kind === 'mac') {
        const current = iface['mac-address'] ?? iface.mac_address;
        const permanent = iface['permanent-mac-address'];
        if (normalizeMac(current) === query.value) {
            matches.push({ match: { type: 'exact', field: 'MAC', value: String(current) } });
        } else if (normalizeMac(permanent) === query.value) {
            matches.push({ match: { type: 'exact', field: 'permanent MAC', value: String(permanent) } });
        }
    } else {
        const needle = query.value.toLowerCase();
        const name = (iface.name ?? '').toLowerCase();
        if (name === needle) {
            matches.push({ match: { type: 'exact', field: 'name', value: iface.name } });
        } else if (name.includes(needle)) {
            matches.push({ match: { type: name.startsWith(needle) ? 'prefix' : 'substring', field: 'name', value: iface.name } });
        } else {
            const altNames = Array.isArray(iface['alt-names']) ? iface['alt-names'] : [];
            const alt = altNames
                .map((entry) => entry?.name)
                .find((altName): altName is string => typeof altName === 'string' && altName.toLowerCase().includes(needle));
            if (alt) {
                matches.push({ match: rankNameMatch(query, { type: 'substring', field: 'alternative name', value: alt }) });
            }
        }
    }
    return matches;
};

const nextHopsText = (row: KernelRouteRow): string =>
    row.nextHops
        .map((hop) => [hop.gateway ? `via ${hop.gateway}` : 'on-link', hop.interface ? `dev ${hop.interface}` : '']
            .filter(Boolean)
            .join(' '))
        .join(', ');

/**
 * Where a kernel route is shown in the physical view: the VRF for a route in
 * a VRF's table, else the device of its first next hop. Undefined when the
 * node reports no interface by that name.
 */
const routeNodeId = (table: KernelRouteTableGroup, row: KernelRouteRow, interfaces: Interface[]): string | undefined =>
    resolveInterfaceLinkRef(table.vrfName, { interfaces })
    ?? row.nextHops.map((hop) => resolveInterfaceLinkRef(hop.interface, { interfaces })).find(Boolean);

export interface WatchedSearch {
    results: SearchResult[];
    covering: CoveringGroup[];
}

/**
 * Search the resources the overview watches. Interfaces match on address, MAC
 * or name; kernel routes match an `ip` or `cidr` query by destination, and a
 * route that only covers the query becomes a covering entry of its node.
 */
export const searchWatchedResources = (query: SearchQuery, sources: WatchedSources): WatchedSearch => {
    const results: SearchResult[] = [];
    const covering: CoveringGroup[] = [];
    const nodesByName = new Map<string, K8sResourceCommon>();
    for (const node of sources.nodes ?? []) {
        if (node.metadata?.name) nodesByName.set(node.metadata.name, node);
    }
    const nodesWithAddressHit = new Set<string>();

    for (const nns of sources.nodeNetworkStates) {
        const node = nns.metadata?.name;
        if (!node) continue;
        const interfaces = nns.status?.currentState?.interfaces ?? [];
        const vrfs = vrfByPort(interfaces);
        const knownNode = nodesByName.get(node);
        const nodeAddresses = knownNode ? nodeAddressesOf(knownNode) : [];

        for (const iface of interfaces) {
            if (!iface?.name) continue;
            for (const { match } of matchInterface(query, iface, nodeAddresses)) {
                if (match.field === 'address') nodesWithAddressHit.add(node);
                const subtitle = [iface.type, iface.state].filter(Boolean).join(' · ');
                const vrf = iface.type === 'vrf' ? undefined : vrfs.get(iface.name);
                const result: SearchResult = {
                    key: [
                        'cluster|interface', iface.name, subtitle, match.type, match.field, match.value,
                        match.note ?? '', vrf ?? '',
                    ].join('|'),
                    kind: 'node-interface',
                    source: 'cluster',
                    title: iface.name,
                    match,
                    places: [{ node, link: physicalLink(node, resolveInterfaceLinkRef(iface.name, { interfaces })) }],
                    links: [],
                };
                if (subtitle) result.subtitle = subtitle;
                if (vrf) result.context = `VRF ${vrf}`;
                results.push(result);
            }
        }

        if (query.kind !== 'ip' && query.kind !== 'cidr') continue;
        const wanted = query.prefix as ParsedPrefix;
        const coveringEntries: CoveringEntry[] = [];
        for (const table of buildKernelRouteTables(getRunningRoutes(nns))) {
            const tableLabel = kernelTableLabel(table);
            for (const row of table.rows) {
                const stored = parsePrefix(row.destination);
                const relation = stored ? relateDestination(wanted, stored) : null;
                if (!relation) continue;
                const hops = nextHopsText(row);
                const place: SearchPlace = { node, link: physicalLink(node, routeNodeId(table, row, interfaces)) };
                if (relation === 'containment') {
                    coveringEntries.push({
                        key: `cluster|route|${node}|${table.key}|${row.key}`,
                        what: 'Kernel route',
                        prefix: row.destination,
                        detail: [hops, tableLabel].filter(Boolean).join(' · '),
                        places: [place],
                    });
                    continue;
                }
                const result: SearchResult = {
                    key: `cluster|route|${row.destination}|${row.metric ?? ''}|${hops}|${tableLabel}|${relation}`,
                    kind: 'route',
                    source: 'cluster',
                    title: row.destination,
                    subtitle: ['Kernel route', hops].filter(Boolean).join(' · '),
                    match: { type: relation, field: 'destination', value: row.destination },
                    context: tableLabel,
                    places: [place],
                    links: [],
                };
                results.push(result);
            }
        }
        if (coveringEntries.length > 0) {
            covering.push({
                key: `cluster|kernel|${node}`,
                source: 'cluster',
                label: `Kernel routes on ${node}`,
                entries: coveringEntries.sort(
                    (a, b) => prefixLengthOf(b.prefix) - prefixLengthOf(a.prefix) || a.prefix.localeCompare(b.prefix),
                ),
                hitCount: coveringEntries.length,
                nodes: [node],
                links: [],
            });
        }
    }

    // A Node address no reported interface holds (a node without a
    // NodeNetworkState, or an address nmstate does not list) is still an
    // answer to "whose address is this?".
    if (query.kind === 'ip') {
        const wanted = query.prefix as ParsedPrefix;
        for (const [name, node] of nodesByName) {
            if (nodesWithAddressHit.has(name)) continue;
            for (const entry of nodeAddressesOf(node)) {
                const parsed = parsePrefix(entry.address);
                if (!parsed || !sameAddress(parsed, wanted)) continue;
                results.push({
                    key: `cluster|node-address|${name}|${entry.type}|${entry.address}`,
                    kind: 'node-interface',
                    source: 'cluster',
                    title: name,
                    subtitle: 'Node address, on no interface NodeNetworkState reports',
                    match: { type: 'exact', field: entry.type, value: entry.address },
                    places: [{ node: name, link: physicalLink(name) }],
                    links: [],
                });
            }
        }
    }

    return { results, covering };
};

/* ------------------------------------------------------------------ */
/* Coverage: what was and was not searched                             */
/* ------------------------------------------------------------------ */

/** What became of the collector half of a search. */
export type CollectorOutcome =
    /** The collector feature is off: only the cluster half ran. */
    | { state: 'disabled' }
    /** The request never got an answer. */
    | { state: 'unreachable'; message: string }
    /** The collector refused the value (HTTP 400); `message` is its reason. */
    | { state: 'rejected'; message: string }
    | { state: 'searched'; response: LookupResponse };

export interface SearchCoverage {
    collector: CollectorOutcome['state'];
    /** The collector's refusal, or why it could not be reached. */
    collectorMessage?: string;
    /** Zone snapshots the collector searched. */
    zonesSearched: number;
    /** The oldest searched snapshot's collection time. */
    oldestSnapshotAt?: string;
    /** Known nodes with no searched zone snapshot, sorted. */
    unsearchedNodes: string[];
    warnings: LogicalTopologyWarning[];
    /** Set when the collector cut its hits to the limit. */
    truncated?: { shown: number; total: number };
    /** Nodes whose NodeNetworkState was searched. */
    nodesWithState: number;
    /** True when something that should have been searched was not, or hits were cut. */
    partial: boolean;
}

const oldestOf = (times: string[]): string | undefined => {
    let oldest: { text: string; at: number } | undefined;
    for (const text of times) {
        const at = new Date(text).getTime();
        if (Number.isNaN(at)) continue;
        if (!oldest || at < oldest.at) oldest = { text, at };
    }
    return oldest?.text;
};

export const describeCoverage = (outcome: CollectorOutcome, sources: WatchedSources): SearchCoverage => {
    const stateNodes = sources.nodeNetworkStates
        .map((nns) => nns.metadata?.name)
        .filter((name): name is string => Boolean(name));
    const coverage: SearchCoverage = {
        collector: outcome.state,
        zonesSearched: 0,
        unsearchedNodes: [],
        warnings: [],
        nodesWithState: stateNodes.length,
        partial: outcome.state !== 'searched',
    };
    if (outcome.state === 'unreachable' || outcome.state === 'rejected') {
        coverage.collectorMessage = outcome.message;
    }
    if (outcome.state !== 'searched') return coverage;

    const { response } = outcome;
    const zones = response.zones ?? [];
    const searched = new Set(zones.map((zone) => zone.node));
    const nodeNames = (sources.nodes ?? [])
        .map((node) => node.metadata?.name)
        .filter((name): name is string => Boolean(name));
    // Every node runs a zone, so a known node with no zone was not searched.
    const known = nodeNames.length > 0 ? nodeNames : stateNodes;
    coverage.zonesSearched = zones.length;
    coverage.oldestSnapshotAt = oldestOf(zones.map((zone) => zone.snapshotGeneratedAt));
    coverage.unsearchedNodes = sortedUnique(known.filter((name) => !searched.has(name)));
    coverage.warnings = response.warnings ?? [];
    if (response.truncated) coverage.truncated = { shown: (response.hits ?? []).length, total: response.total };
    coverage.partial = zones.length === 0 || coverage.unsearchedNodes.length > 0 || Boolean(response.truncated);
    return coverage;
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * Where the search looked: `10 collector zone snapshots and the
 * NodeNetworkState of 10 nodes`. `snapshotNote` is said of the snapshots
 * (their age), so it sits next to them and not at the end of the sentence.
 */
export const describeSearched = (coverage: SearchCoverage, snapshotNote = ''): string => {
    const cluster = `the NodeNetworkState of ${plural(coverage.nodesWithState, 'node')}`;
    if (coverage.collector !== 'searched') return cluster;
    const note = snapshotNote && coverage.zonesSearched > 0 ? ` (${snapshotNote})` : '';
    return `${plural(coverage.zonesSearched, 'collector zone snapshot')}${note} and ${cluster}`;
};

/* ------------------------------------------------------------------ */
/* The assembled answer                                                */
/* ------------------------------------------------------------------ */

export interface ClusterSearchResults {
    query: SearchQuery;
    /**
     * Results by kind, best match first: the groups holding an exact match,
     * then the rest, each tier in page order. Empty kinds are left out.
     */
    groups: SearchResultGroup[];
    /** Rows across all groups. */
    resultCount: number;
    /** Routes and subnets that only cover the query, most specific group first. */
    covering: CoveringGroup[];
    /** Raw covering hits across all groups. */
    coveringCount: number;
    coverage: SearchCoverage;
}

// exact, then inside the queried CIDR or a name that starts with the text
// (never both: one is an address search, the other a name search), then a
// name that only contains the text.
const MATCH_RANK: Record<SearchMatchType, number> = { exact: 0, within: 1, prefix: 1, substring: 2, containment: 3 };

const compareResults = (a: SearchResult, b: SearchResult): number =>
    MATCH_RANK[a.match.type] - MATCH_RANK[b.match.type] ||
    a.title.localeCompare(b.title) ||
    (a.network ?? '').localeCompare(b.network ?? '') ||
    (a.places[0]?.node ?? '').localeCompare(b.places[0]?.node ?? '') ||
    a.key.localeCompare(b.key);

const longestPrefixOf = (group: CoveringGroup): number =>
    Math.max(-1, ...group.entries.map((entry) => prefixLengthOf(entry.prefix)));

const compareCovering = (a: CoveringGroup, b: CoveringGroup): number =>
    longestPrefixOf(b) - longestPrefixOf(a) ||
    Number(a.source === 'cluster') - Number(b.source === 'cluster') ||
    a.label.localeCompare(b.label) ||
    a.key.localeCompare(b.key);

/**
 * One answer from both sources. Collector and cluster hits of a kind share a
 * group, exact matches first; containment hits from either source go to
 * `covering` and never into a group.
 */
export const buildClusterSearchResults = (
    query: SearchQuery,
    outcome: CollectorOutcome,
    sources: WatchedSources,
): ClusterSearchResults => {
    const hits = outcome.state === 'searched' ? (outcome.response.hits ?? []) : [];
    const watched = searchWatchedResources(query, sources);
    const direct = hits.filter((hit) => hit.matchType !== 'containment');
    const isVip = (hit: LookupHit): boolean => kindOfHit(hit) === 'service-vip';

    const services = foldServiceVips(
        direct.filter(isVip),
        outcome.state === 'searched' ? (outcome.response.zones ?? []).map((zone) => zone.node) : [],
        { query, truncated: outcome.state === 'searched' && Boolean(outcome.response.truncated) },
    );
    const results = [
        ...foldAcrossNodes(foldResults([
            ...direct.filter((hit) => !isVip(hit)).map((hit) => {
                const result = resultOfHit(hit);
                return { ...result, match: rankNameMatch(query, result.match) };
            }),
            ...watched.results,
        ])),
        ...services,
    ];
    const pageOrder = (kind: SearchResultKind): number => RESULT_KINDS.findIndex((entry) => entry.kind === kind);
    const groups = RESULT_KINDS
        .map(({ kind, label }) => ({
            kind,
            label,
            results: results.filter((result) => result.kind === kind).sort(compareResults),
        }))
        .filter((group) => group.results.length > 0)
        .sort((a, b) =>
            MATCH_RANK[a.results[0].match.type] - MATCH_RANK[b.results[0].match.type] ||
            pageOrder(a.kind) - pageOrder(b.kind));

    const covering = [
        ...coveringGroupsOfHits(hits.filter((hit) => hit.matchType === 'containment')),
        ...watched.covering,
    ].sort(compareCovering);

    return {
        query,
        groups,
        resultCount: groups.reduce((total, group) => total + group.results.length, 0),
        covering,
        coveringCount: covering.reduce((total, group) => total + group.hitCount, 0),
        coverage: describeCoverage(outcome, sources),
    };
};

/* ------------------------------------------------------------------ */
/* Marks in the explorer's tree (ovn-recon-gbr.8)                      */
/* ------------------------------------------------------------------ */

/** How many results each node and network holds, for the explorer tree's marks. */
export interface SearchMarks {
    /** Results with a place on the node, by node name. */
    nodes: ReadonlyMap<string, number>;
    /**
     * Results on a ClusterUserDefinedNetwork or UserDefinedNetwork, keyed as the
     * overview's network rows are (`kind/namespace/name`, kind `cudn` or `udn`).
     * Read from the OVN network name (`cluster_udn_<name>`, `<namespace>_<name>`);
     * the default network and NADs are not marked.
     */
    networks: ReadonlyMap<string, number>;
}

/** The overview network row key of an OVN network name, when it names a CUDN or UDN. */
export const networkRowKeyOfOvnNetwork = (network: string | undefined): string | undefined => {
    const ref = network ? networkResourceRef(network) : undefined;
    if (!ref) return undefined;
    return ref.kind === 'ClusterUserDefinedNetwork' ? `cudn//${ref.name}` : `udn/${ref.namespace ?? ''}/${ref.name}`;
};

/**
 * Each result counts once on every node that holds it (a folded row counts on each
 * of its nodes) and once on its network. Covering routes and subnets are not
 * matches: they only contain the searched address.
 */
export const searchMarksOf = (results: ClusterSearchResults | null): SearchMarks => {
    const nodes = new Map<string, number>();
    const networks = new Map<string, number>();
    const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
    for (const group of results?.groups ?? []) {
        for (const result of group.results) {
            new Set(result.places.map((place) => place.node)).forEach((name) => bump(nodes, name));
            const network = networkRowKeyOfOvnNetwork(result.network);
            if (network) bump(networks, network);
        }
    }
    return { nodes, networks };
};

/* ------------------------------------------------------------------ */
/* The jump list                                                       */
/* ------------------------------------------------------------------ */

export interface SearchJumpTarget {
    /** The element id of the group on the page. */
    id: string;
    label: string;
    /** Rows in the group; for the covering section, the covering hits. */
    count: number;
}

/** The page id of a result group, the target of its jump-list entry. */
export const searchGroupAnchorId = (kind: SearchResultKind | 'covering'): string => `ovn-recon-search-${kind}`;

/**
 * A short list of the groups with their counts, shown above the results
 * when there are more than two result groups; one or two are on screen
 * already. The covering section is listed last when there is one.
 */
export const jumpTargets = (results: ClusterSearchResults): SearchJumpTarget[] => {
    if (results.groups.length <= 2) return [];
    const targets = results.groups.map((group) => ({
        id: searchGroupAnchorId(group.kind),
        label: group.label,
        count: group.results.length,
    }));
    if (results.covering.length > 0) {
        targets.push({ id: searchGroupAnchorId('covering'), label: 'Covering routes and subnets', count: results.coveringCount });
    }
    return targets;
};
