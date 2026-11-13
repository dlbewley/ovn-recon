import type { ConstructDetailTab, DetailKind } from './components/constructDetailLinks';
import type { LadderConstruct } from './components/logicalLadderModel';
import type { NetworkAddress } from './components/networkPageModel';
import { constructSelectValue, encodeSelectValue, withSelectParam } from './components/useSelectParam';

/**
 * Every OVN Recon page path, and what a location asks for (ovn-recon-gbr.2). Pure.
 *
 * This is the one place a `/ovn-recon` page path is written; `routes.guard.test.ts`
 * fails on a page-path literal anywhere else in `src`. The URL table is the one in
 * docs/tasks/EXPLORER_SHELL_PLAN.md:
 *
 *   URL                                            scope    tab
 *   /ovn-recon, /ovn-recon/node-network-state      cluster  nodes
 *   /ovn-recon/networks                            cluster  networks
 *   /ovn-recon/findings                            cluster  findings    (new)
 *   /ovn-recon/ovn                                 cluster  logical
 *   /ovn-recon/search?q=                           cluster  search      (new; /ovn-recon?q= too)
 *   /ovn-recon/node-network-state/:name            node     physical
 *   /ovn-recon/ovn/:name                           node     logical
 *   /ovn-recon/node-network-state/:name/routes     node     routes      (new)
 *   /ovn-recon/node-network-state/:name/findings   node     findings    (new)
 *   /ovn-recon/ovn/:node/:kind/:name               node     construct
 *   /ovn-recon/networks/cudn/:name                 network  network
 *   /ovn-recon/networks/{udn,nad}/:namespace/:name network  network
 *
 * `?select=`, `?tab=`, `?q=` and `?port=` keep their meaning. The explorer shell
 * (`OvnReconApp`, ovn-recon-gbr.4) serves every path here under one console route
 * through `SHELL_ROUTES`. Each scope draws its own: Cluster (gbr.4), a node
 * (`NodeScope`, gbr.5) and a network (`NetworkScope`, gbr.6, one view and so no tabs).
 *
 * The other modules that used to build these paths re-export the builders under their
 * old names (physicalViewPath, nodeLadderPath, NETWORKS_PATH, ...), so call sites did
 * not have to change.
 */

export const BASE_PATH = '/ovn-recon';

const PHYSICAL_SEGMENT = 'node-network-state';
const LOGICAL_SEGMENT = 'ovn';
const NETWORKS_SEGMENT = 'networks';
const FINDINGS_SEGMENT = 'findings';
const SEARCH_SEGMENT = 'search';
const ROUTES_SEGMENT = 'routes';

/** The query parameter that carries a search: `?q=`. */
export const SEARCH_PARAM = 'q';

const physicalBase = (node: string): string => `${BASE_PATH}/${PHYSICAL_SEGMENT}/${encodeURIComponent(node)}`;
const logicalBase = (node: string): string => `${BASE_PATH}/${LOGICAL_SEGMENT}/${encodeURIComponent(node)}`;
const selectSearch = (value?: string | null): string => (value ? withSelectParam('', value) : '');
const constructSearch = (construct?: Pick<LadderConstruct, 'kind' | 'name'>): string =>
    construct ? withSelectParam('', constructSelectValue(construct)) : '';

/** `?q=<text>`, or nothing when the text is blank; encoded as the select parameter is. */
const querySearch = (text: string): string => {
    const value = text.trim();
    return value === '' ? '' : `?${SEARCH_PARAM}=${encodeSelectValue(value)}`;
};

// --- Cluster scope -------------------------------------------------------------

/** The overview: the landing page and the nav entry's target. */
export const overviewPath = (): string => BASE_PATH;

/**
 * The overview opened on a search, `/ovn-recon?q=`: the target of every "Find in
 * cluster" link today. The explorer's own search path is `searchPath`.
 */
export const overviewSearchPath = (text: string): string => `${BASE_PATH}${querySearch(text)}`;

/** Every CUDN, UDN and NAD-only network. */
export const NETWORKS_PATH = `${BASE_PATH}/${NETWORKS_SEGMENT}`;
export const networksPath = (): string => NETWORKS_PATH;

/** The logical topology merged across node zones, with a switch or router selected. */
export const clusterLogicalPath = (construct?: Pick<LadderConstruct, 'kind' | 'name'>): string =>
    `${BASE_PATH}/${LOGICAL_SEGMENT}${constructSearch(construct)}`;

/** The cluster's Findings tab. */
export const clusterFindingsPath = (): string => `${BASE_PATH}/${FINDINGS_SEGMENT}`;

/** The cluster's Search results tab, `/ovn-recon/search?q=`. */
export const searchPath = (text: string): string => `${BASE_PATH}/${SEARCH_SEGMENT}${querySearch(text)}`;

// --- Node scope ----------------------------------------------------------------

/** One node's physical topology, with a canonical graph node id (`iface:br-ex`) selected. */
export const nodePhysicalPath = (node: string, selectId?: string): string =>
    `${physicalBase(node)}${selectSearch(selectId)}`;

/** One node zone's logical topology, with a switch or router selected. */
export const nodeLogicalPath = (node: string, construct?: Pick<LadderConstruct, 'kind' | 'name'>): string =>
    `${logicalBase(node)}${constructSearch(construct)}`;

/** One node's Routes tab: its main routing table. */
export const nodeRoutesPath = (node: string): string => `${physicalBase(node)}/${ROUTES_SEGMENT}`;

/** One node's Findings tab: that node's findings (ovn-recon-gbr.7). */
export const nodeFindingsPath = (node: string): string => `${physicalBase(node)}/${FINDINGS_SEGMENT}`;

export interface DetailLinkOptions {
    tab?: ConstructDetailTab;
    q?: string;
    port?: string;
}

/** The construct page's own parameters; overview is the default tab. */
export const detailSearch = ({ tab, q, port }: DetailLinkOptions = {}): string => {
    const params = new URLSearchParams();
    if (tab && tab !== 'overview') params.set('tab', tab);
    if (q) params.set('q', q);
    if (port) params.set('port', port);
    const search = params.toString();
    return search ? `?${search}` : '';
};

/** One logical switch or router from one node's zone: `?tab=`, `?q=`, `?port=`. */
export const constructDetailPath = (
    node: string,
    kind: DetailKind,
    name: string,
    options: DetailLinkOptions = {},
): string => `${logicalBase(node)}/${kind}/${encodeURIComponent(name)}${detailSearch(options)}`;

// --- Network scope -------------------------------------------------------------

/** One network's page. A UDN or NAD without a namespace is filed under `default`. */
export const networkPath = (address: NetworkAddress): string => {
    const name = encodeURIComponent(address.name);
    if (address.kind === 'cudn') return `${NETWORKS_PATH}/cudn/${name}`;
    return `${NETWORKS_PATH}/${address.kind}/${encodeURIComponent(address.namespace || 'default')}/${name}`;
};

// --- The shell's routes --------------------------------------------------------

/**
 * The explorer shell's nested route patterns, relative to `BASE_PATH`: the console
 * mounts the shell at `${BASE_PATH}/*` and the shell's own `Routes` match these
 * beneath it. Each pattern is the path the builders above produce; the shell's route
 * test checks the two agree.
 */
export const SHELL_ROUTES = {
    /** The overview's second path, the Nodes tab like `BASE_PATH` itself. */
    nodesAlias: PHYSICAL_SEGMENT,
    networks: NETWORKS_SEGMENT,
    findings: FINDINGS_SEGMENT,
    clusterLogical: LOGICAL_SEGMENT,
    search: SEARCH_SEGMENT,
    nodePhysical: `${PHYSICAL_SEGMENT}/:name`,
    nodeRoutes: `${PHYSICAL_SEGMENT}/:name/${ROUTES_SEGMENT}`,
    nodeFindings: `${PHYSICAL_SEGMENT}/:name/${FINDINGS_SEGMENT}`,
    nodeLogical: `${LOGICAL_SEGMENT}/:name`,
    construct: `${LOGICAL_SEGMENT}/:node/:kind/:name`,
    cudn: `${NETWORKS_SEGMENT}/cudn/:name`,
    udn: `${NETWORKS_SEGMENT}/udn/:namespace/:name`,
    nad: `${NETWORKS_SEGMENT}/nad/:namespace/:name`,
} as const;

// --- Locations -----------------------------------------------------------------

const decode = (value: string): string => {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
};

/**
 * What a network page URL asks for: the list, one network, or nothing (a malformed
 * path, which the network page renders as its empty state). Finds the networks path
 * anywhere in the pathname, as it always has.
 */
export const parseNetworkPath = (pathname: string): { list: true } | NetworkAddress | null => {
    const index = pathname.indexOf(NETWORKS_PATH);
    if (index < 0) return null;
    const rest = pathname.slice(index + NETWORKS_PATH.length).split('/').filter(Boolean).map(decode);
    if (rest.length === 0) return { list: true };
    const [kind, ...parts] = rest;
    if (kind === 'cudn' && parts.length === 1) return { kind, name: parts[0] };
    if ((kind === 'udn' || kind === 'nad') && parts.length === 2) {
        return { kind, namespace: parts[0], name: parts[1] };
    }
    return null;
};

export type ExplorerScope = 'cluster' | 'node' | 'network';
export type ClusterTab = 'nodes' | 'networks' | 'findings' | 'logical' | 'search';
export type NodeTab = 'physical' | 'logical' | 'routes' | 'findings' | 'construct';
export type NetworkTab = 'network';

/** The path and query parameters of a view; only those the location carries are set. */
export interface ViewParams {
    /** The node of a node-scope view. */
    node?: string;
    /** The construct page's kind (`switch` or `router`; the page itself rejects others) and row name. */
    kind?: string;
    name?: string;
    /** The network of a network-scope view. */
    network?: NetworkAddress;
    /** `?select=`: the graph selection. */
    select?: string;
    /** `?q=`: the search text, or a construct page tab's filter. */
    q?: string;
    /** `?tab=`: the construct page's tab. */
    detailTab?: string;
    /** `?port=`: the construct page's expanded port. */
    port?: string;
}

export type ExplorerView =
    | { scope: 'cluster'; tab: ClusterTab; params: ViewParams }
    | { scope: 'node'; tab: NodeTab; params: ViewParams & { node: string } }
    | { scope: 'network'; tab: NetworkTab; params: ViewParams & { network: NetworkAddress } };

export interface ViewLocation {
    pathname: string;
    search?: string;
}

const queryParams = (search: string | undefined): ViewParams => {
    const query = new URLSearchParams(search ?? '');
    const params: ViewParams = {};
    const select = query.get('select');
    const q = query.get(SEARCH_PARAM);
    const tab = query.get('tab');
    const port = query.get('port');
    if (select) params.select = select;
    if (q) params.q = q;
    if (tab) params.detailTab = tab;
    if (port) params.port = port;
    return params;
};

/**
 * The scope, tab and parameters a location asks for, following the URL table above;
 * null for a path OVN Recon does not serve (the shell's not-found view). The overview
 * with a non-blank `?q=` is the search view, so `/ovn-recon?q=` and
 * `/ovn-recon/search?q=` resolve to the same thing.
 */
export const viewForLocation = ({ pathname, search }: ViewLocation): ExplorerView | null => {
    const segments = pathname.split('/').filter(Boolean);
    if (`/${segments[0] ?? ''}` !== BASE_PATH) return null;
    const rest = segments.slice(1).map(decode);
    const params = queryParams(search);

    const [first, ...tail] = rest;
    if (first === undefined || (first === PHYSICAL_SEGMENT && tail.length === 0)) {
        return { scope: 'cluster', tab: params.q?.trim() ? 'search' : 'nodes', params };
    }
    if (first === SEARCH_SEGMENT && tail.length === 0) return { scope: 'cluster', tab: 'search', params };
    if (first === FINDINGS_SEGMENT && tail.length === 0) return { scope: 'cluster', tab: 'findings', params };

    if (first === PHYSICAL_SEGMENT) {
        const [node, view, ...extra] = tail;
        if (extra.length > 0) return null;
        if (view === undefined) return { scope: 'node', tab: 'physical', params: { ...params, node } };
        if (view === ROUTES_SEGMENT) return { scope: 'node', tab: 'routes', params: { ...params, node } };
        if (view === FINDINGS_SEGMENT) return { scope: 'node', tab: 'findings', params: { ...params, node } };
        return null;
    }

    if (first === LOGICAL_SEGMENT) {
        if (tail.length === 0) return { scope: 'cluster', tab: 'logical', params };
        if (tail.length === 1) return { scope: 'node', tab: 'logical', params: { ...params, node: tail[0] } };
        if (tail.length === 3) {
            const [node, kind, name] = tail;
            return { scope: 'node', tab: 'construct', params: { ...params, node, kind, name } };
        }
        return null;
    }

    if (first === NETWORKS_SEGMENT) {
        const target = parseNetworkPath(`${BASE_PATH}/${segments.slice(1).join('/')}`);
        if (target === null) return null;
        if ('list' in target) return { scope: 'cluster', tab: 'networks', params };
        return { scope: 'network', tab: 'network', params: { ...params, network: target } };
    }

    return null;
};
