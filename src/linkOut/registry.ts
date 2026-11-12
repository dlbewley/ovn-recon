import { getApiResourcePath, getProjectPath, getResourcePath } from '../topology/links';
import type { ResourceRef } from '../topology/types';

/**
 * The link-out registry (ovn-recon-zdt.4): given an object and what this console
 * has loaded, the best page for it, and nothing when no page is there.
 *
 * Pure. What the console has loaded arrives as ConsoleCapabilities, read once by
 * useConsoleCapabilities; everything here is a function of the two.
 *
 * What was read from the neighbouring plugins' source (release-4.22 and release-5.1
 * of networking-console-plugin and nmstate-console-plugin, release-4.22 of the
 * console) and shapes this file:
 *
 * - A resource's list and details pages keep the generic /k8s/... address whoever
 *   draws them. The console looks the page up by model, so a plugin that registers
 *   `console.page/resource/details` for NetworkPolicy replaces the component at the
 *   same URL. The registry therefore returns one address for a resource and says
 *   who owns the page in `owner`.
 * - Create forms are different: `~new/form` exists only as a route the networking
 *   plugin adds. Without that plugin the console's own `~new` (YAML) is the page.
 * - nmstate replaces the NodeNetworkState list page, and that page opens one
 *   interface's details from `selectedState`, `selectedInterface` and
 *   `selectedInterfaceType` (release-4.21 to release-5.1). That is where an
 *   interface links. nmstate's topology at `/node-network-configuration` also
 *   reads a `selectedID`, but on release-4.22 an arriving link selects and opens
 *   nothing there, so it is not a destination (checked on a 4.22 console).
 * - `/physical-networks` belongs to the nmstate plugin on 4.22 and to the
 *   networking plugin on 5.1. Neither reads a network name from the URL, so the
 *   link opens the list.
 *
 * Network Observability's "View traffic" (ovn-recon-vqd.1) is a provider too. What
 * was read from netobserv-plugin's source (v1.9 to v2.0) and shapes it:
 *
 * - The plugin's name is `netobserv-plugin`, and `/netflow-traffic` is its page and
 *   its navigation item on every release read. A second plugin,
 *   `netobserv-plugin-static`, only carries FlowCollector forms, so the traffic
 *   page is recognised by the navigation item, never by the plugin name alone.
 * - It adds a "Network Traffic" tab at `<details page>/netflow`. The Node tab is
 *   registered without a flag on every release read and applies the node filter
 *   itself, so it needs no URL format from us. Without Loki it draws from the
 *   node metrics, which are on unless the FlowCollector's includeList drops them.
 * - The CUDN and UDN tabs are registered from 1.9 but say "Kind not managed"
 *   before 1.11, and nothing tells the releases apart from here. So a network
 *   links to the traffic page with the filter the 1.11 tab applies: `udns=<name>`
 *   for a CUDN, `udns=<namespace>.<name>` for a UDN. That filter exists only with
 *   the FlowCollector's UDNMapping feature; the page silently drops a filter it
 *   does not know and would show all traffic.
 * - A Service is `dst_resource=Service.<namespace>.<name>` (a Service is always
 *   the destination side), the filter netobserv's own Service tab applies.
 * - Resource and UDN filters are answered from flow logs. Without Loki the page
 *   offers only filters whose labels are on the metrics, which these are not, so
 *   both need Loki. netobserv publishes that as the NETOBSERV_LOKI_ENABLED flag
 *   (1.10 on) and gates its own Pod and Service tabs on it.
 * - In the `filters` parameter `key=value` is an exact match from 1.10; on 1.9 it
 *   is a partial match. No `match` parameter is sent: its values changed between
 *   releases and the default suits both filters.
 */

export const NETWORKING_PLUGIN = 'networking-console-plugin';
export const NMSTATE_PLUGIN = 'nmstate-console-plugin';
export const NETOBSERV_PLUGIN = 'netobserv-plugin';
/** Network Observability's traffic page, and the navigation item that proves it is there. */
export const NETOBSERV_TRAFFIC_PATH = '/netflow-traffic';
/** The console flag netobserv sets once it knows whether flow logs are stored in Loki. */
export const NETOBSERV_LOKI_FLAG = 'NETOBSERV_LOKI_ENABLED';
/** The FlowCollector feature that records which UDN a flow belongs to. */
export const NETOBSERV_UDN_MAPPING = 'UDNMapping';

/** The console itself, as the owner of a page no plugin replaces. */
export const CONSOLE_OWNER = 'console';

export const PHYSICAL_NETWORKS_PATH = '/physical-networks';

/** A kind, without an object: enough to address its list or create page. */
export interface KindRef {
    apiVersion: string;
    kind: string;
}

/** What a link is about. */
export type LinkTarget =
    /** One Kubernetes object; `view: 'yaml'` asks for its YAML tab. */
    | { type: 'resource'; ref: ResourceRef; view?: 'details' | 'yaml' }
    /** Every object of a kind: in one namespace, in all of them, or cluster-scoped. */
    | { type: 'list'; kind: KindRef; scope: 'cluster' | 'all-namespaces' | { namespace: string } }
    /** The page that creates one: cluster-scoped, or in a namespace. */
    | { type: 'create'; kind: KindRef; namespace?: string }
    /** A namespace, which on OpenShift opens as its Project. */
    | { type: 'namespace'; name: string }
    /** A kind's API reference page. */
    | { type: 'api-resource'; kind: KindRef }
    /** One interface of one node, as NodeNetworkState reports it. */
    | { type: 'node-interface'; node: string; name: string; interfaceType: string }
    /** A Localnet physical network, by its physicalNetworkName. */
    | { type: 'physical-network'; name: string }
    /** A console path built elsewhere (a label query); passed through unchanged. */
    | { type: 'path'; path: string };

/**
 * What Network Observability is set up to answer. Every field is `undefined`
 * until it is known, and the registry treats unknown as no.
 */
export interface NetObservCapabilities {
    /** Flow logs are stored in Loki, so filters on a resource or a UDN return rows. */
    loki?: boolean;
    /** Per-node metrics are generated, so a node's traffic shows without Loki. */
    nodeMetrics?: boolean;
    /** The FlowCollector's `spec.agent.ebpf.features`. */
    features?: ReadonlySet<string>;
}

/**
 * What this console has loaded. `undefined` for a CRD means discovery has not
 * answered yet; the registry treats that as absent, since a link that appears a
 * moment late is better than one to a page that is not there.
 */
export interface ConsoleCapabilities {
    /** Names of the plugins that contributed at least one extension in use. */
    plugins: ReadonlySet<string>;
    /** Navigation hrefs in use, normalised to a leading slash, by plugin name. */
    navHrefs: ReadonlyMap<string, ReadonlySet<string>>;
    /** CRD presence by `<group>~<version>~<kind>`. */
    crds: Readonly<Record<string, boolean | undefined>>;
    /** Absent when the Network Observability plugin is not loaded. */
    netobserv?: NetObservCapabilities;
}

/** Nothing loaded: every target resolves to its generic page, or to nothing. */
export const NO_CAPABILITIES: ConsoleCapabilities = {
    plugins: new Set(),
    navHrefs: new Map(),
    crds: {},
};

export interface LinkOut {
    /** A stable name for the destination, for tests and keys. */
    id: string;
    /** An in-console path, for react-router. Never an absolute URL. */
    path: string;
    /** The plugin that draws the page, or `console`. */
    owner: string;
    /** Link text for a link that stands on its own (secondary links always do). */
    label: string;
    /** What following the link shows, where the label alone does not say. */
    hint?: string;
}

export interface LinkOuts {
    /** The page that owns the object, when one is there. */
    primary?: LinkOut;
    /** Other pages worth offering beside it. */
    secondary: LinkOut[];
}

export type LinkOutProvider = (target: LinkTarget, capabilities: ConsoleCapabilities) => Partial<LinkOuts>;

/** `networking.k8s.io~v1~NetworkPolicy`; `core~v1~Pod` for the core group. */
export const kindReference = ({ apiVersion, kind }: KindRef): string =>
    `${apiVersion.includes('/') ? apiVersion.replace('/', '~') : `core~${apiVersion}`}~${kind}`;

const NETWORK_POLICY: KindRef = { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy' };
const MULTI_NETWORK_POLICY: KindRef = { apiVersion: 'k8s.cni.cncf.io/v1beta1', kind: 'MultiNetworkPolicy' };
const CUDN: KindRef = { apiVersion: 'k8s.ovn.org/v1', kind: 'ClusterUserDefinedNetwork' };
const UDN: KindRef = { apiVersion: 'k8s.ovn.org/v1', kind: 'UserDefinedNetwork' };
const NAD: KindRef = { apiVersion: 'k8s.cni.cncf.io/v1', kind: 'NetworkAttachmentDefinition' };
const NNCP: KindRef = { apiVersion: 'nmstate.io/v1', kind: 'NodeNetworkConfigurationPolicy' };
const NNS: KindRef = { apiVersion: 'nmstate.io/v1beta1', kind: 'NodeNetworkState' };
const NODE: KindRef = { apiVersion: 'v1', kind: 'Node' };
const SERVICE: KindRef = { apiVersion: 'v1', kind: 'Service' };

/**
 * The CRDs whose presence the plugin asks the console about, one
 * `console.flag/model` extension each (console-extensions.json; the guard test
 * keeps the two lists equal). A list or create page of a kind named here is
 * offered only once its CRD is known to be installed.
 */
export const CRD_FLAGS: ReadonlyArray<{ flag: string; kind: KindRef }> = [
    { flag: 'OVN_RECON_CRD_CUDN', kind: CUDN },
    { flag: 'OVN_RECON_CRD_UDN', kind: UDN },
    { flag: 'OVN_RECON_CRD_NAD', kind: NAD },
    { flag: 'OVN_RECON_CRD_MULTI_NETWORK_POLICY', kind: MULTI_NETWORK_POLICY },
    { flag: 'OVN_RECON_CRD_NNCP', kind: NNCP },
    { flag: 'OVN_RECON_CRD_NNS', kind: NNS },
];

const CRD_BACKED = new Set(CRD_FLAGS.map(({ kind }) => kindReference(kind)));

/** False only for a kind the plugin tracks whose CRD is absent or not yet known. */
const kindIsServed = (kind: KindRef, capabilities: ConsoleCapabilities): boolean => {
    const reference = kindReference(kind);
    return !CRD_BACKED.has(reference) || capabilities.crds[reference] === true;
};

/**
 * Which plugin replaces the list and details pages of a kind. Limited to what
 * holds on every release from 4.22: the networking plugin gains CUDN and UDN
 * details pages only in 5.1, so those two are not claimed for it here.
 */
const PAGE_OWNER: Readonly<Record<string, string>> = {
    [kindReference(NETWORK_POLICY)]: NETWORKING_PLUGIN,
    [kindReference(MULTI_NETWORK_POLICY)]: NETWORKING_PLUGIN,
    [kindReference(NNCP)]: NMSTATE_PLUGIN,
};

/** The kinds the networking plugin adds a `~new/form` route for. */
const NETWORKING_FORMS = new Set([NETWORK_POLICY, MULTI_NETWORK_POLICY, CUDN, UDN].map(kindReference));

const pageOwner = (kind: KindRef, capabilities: ConsoleCapabilities): string => {
    const plugin = PAGE_OWNER[kindReference(kind)];
    return plugin && capabilities.plugins.has(plugin) ? plugin : CONSOLE_OWNER;
};

/** The plugin, if any, that has `href` in the navigation; undefined when none does. */
const navOwner = (
    href: string,
    capabilities: ConsoleCapabilities,
    candidates: string[],
): string | undefined =>
    candidates.find((plugin) => capabilities.navHrefs.get(plugin)?.has(href));

const consoleProvider: LinkOutProvider = (target, capabilities) => {
    switch (target.type) {
        case 'resource': {
            if (!target.ref.name) return {};
            const path = getResourcePath(target.ref);
            return {
                primary: {
                    id: target.view === 'yaml' ? 'resource-yaml' : 'resource',
                    path: target.view === 'yaml' ? `${path}/yaml` : path,
                    owner: pageOwner(target.ref, capabilities),
                    label: target.view === 'yaml' ? `${target.ref.kind} YAML` : target.ref.kind,
                },
            };
        }
        case 'list': {
            if (!kindIsServed(target.kind, capabilities)) return {};
            const base = target.scope === 'cluster'
                ? '/k8s/cluster'
                : target.scope === 'all-namespaces'
                    ? '/k8s/all-namespaces'
                    : `/k8s/ns/${target.scope.namespace}`;
            return {
                primary: {
                    id: 'list',
                    path: `${base}/${kindReference(target.kind)}`,
                    owner: pageOwner(target.kind, capabilities),
                    label: `${target.kind.kind} list`,
                },
            };
        }
        case 'create': {
            if (!kindIsServed(target.kind, capabilities)) return {};
            const reference = kindReference(target.kind);
            const base = target.namespace ? `/k8s/ns/${target.namespace}` : '/k8s/cluster';
            const form = capabilities.plugins.has(NETWORKING_PLUGIN) && NETWORKING_FORMS.has(reference);
            return {
                primary: {
                    id: form ? 'create-form' : 'create',
                    path: `${base}/${reference}/~new${form ? '/form' : ''}`,
                    owner: form ? NETWORKING_PLUGIN : CONSOLE_OWNER,
                    label: `Create ${target.kind.kind}`,
                },
            };
        }
        case 'namespace':
            return target.name
                ? { primary: { id: 'project', path: getProjectPath(target.name), owner: CONSOLE_OWNER, label: 'Project' } }
                : {};
        case 'api-resource':
            return {
                primary: {
                    id: 'api-resource',
                    path: getApiResourcePath(target.kind.apiVersion, target.kind.kind),
                    owner: CONSOLE_OWNER,
                    label: `${target.kind.kind} API reference`,
                },
            };
        case 'path':
            return target.path.startsWith('/')
                ? { primary: { id: 'path', path: target.path, owner: CONSOLE_OWNER, label: 'Console' } }
                : {};
        default:
            return {};
    }
};

const nmstateProvider: LinkOutProvider = (target, capabilities) => {
    if (target.type !== 'node-interface') return {};
    if (!target.node || !target.name || !target.interfaceType) return {};
    if (!capabilities.plugins.has(NMSTATE_PLUGIN) || !kindIsServed(NNS, capabilities)) return {};
    const query = new URLSearchParams({
        selectedState: target.node,
        selectedInterface: target.name,
        selectedInterfaceType: target.interfaceType,
    });
    return {
        secondary: [{
            id: 'nmstate-interface',
            path: `/k8s/cluster/${kindReference(NNS)}?${query.toString()}`,
            owner: NMSTATE_PLUGIN,
            label: 'Interface details in nmstate',
        }],
    };
};

const physicalNetworksProvider: LinkOutProvider = (target, capabilities) => {
    if (target.type !== 'physical-network' || !target.name) return {};
    const owner = navOwner(PHYSICAL_NETWORKS_PATH, capabilities, [NETWORKING_PLUGIN, NMSTATE_PLUGIN]);
    if (!owner) return {};
    return {
        primary: { id: 'physical-networks', path: PHYSICAL_NETWORKS_PATH, owner, label: 'Physical networks' },
    };
};

const isKind = (ref: ResourceRef, kind: KindRef): boolean =>
    ref.apiVersion === kind.apiVersion && ref.kind === kind.kind;

const trafficPage = (filter: string): string =>
    `${NETOBSERV_TRAFFIC_PATH}?${new URLSearchParams({ filters: filter }).toString()}`;

/**
 * "View traffic": the Network Observability page for a node, a network or a
 * Service. Offered only when that page would be filtered to the object and have
 * something to draw from; the header comment says what each one needs.
 */
const netobservProvider: LinkOutProvider = (target, capabilities) => {
    if (target.type !== 'resource' || target.view === 'yaml' || !target.ref.name) return {};
    if (!capabilities.navHrefs.get(NETOBSERV_PLUGIN)?.has(NETOBSERV_TRAFFIC_PATH)) return {};
    const { loki, nodeMetrics, features } = capabilities.netobserv ?? {};
    const { ref } = target;
    const link = (id: string, path: string, hint: string): Partial<LinkOuts> => ({
        secondary: [{ id, path, owner: NETOBSERV_PLUGIN, label: 'View traffic', hint }],
    });

    if (isKind(ref, NODE)) {
        return loki === true || nodeMetrics === true
            ? link(
                'netobserv-node',
                `${getResourcePath(ref)}/netflow`,
                'Network Observability: traffic to and from this node',
            )
            : {};
    }
    if (isKind(ref, CUDN) || isKind(ref, UDN)) {
        if (loki !== true || !features?.has(NETOBSERV_UDN_MAPPING)) return {};
        if (isKind(ref, UDN) && !ref.namespace) return {};
        return link(
            'netobserv-network',
            trafficPage(`udns=${isKind(ref, UDN) ? `${ref.namespace}.${ref.name}` : ref.name}`),
            'Network Observability: traffic on this network',
        );
    }
    if (isKind(ref, SERVICE)) {
        return loki === true && ref.namespace
            ? link(
                'netobserv-service',
                trafficPage(`dst_resource=Service.${ref.namespace}.${ref.name}`),
                'Network Observability: traffic to this Service',
            )
            : {};
    }
    return {};
};

/** In order: the first provider to name a primary page wins it. */
const PROVIDERS: LinkOutProvider[] = [physicalNetworksProvider, nmstateProvider, consoleProvider, netobservProvider];

/** Every page worth offering for a target on this console. */
export const resolveLinkOuts = (
    target: LinkTarget,
    capabilities: ConsoleCapabilities = NO_CAPABILITIES,
): LinkOuts => {
    const result: LinkOuts = { secondary: [] };
    for (const provider of PROVIDERS) {
        const { primary, secondary } = provider(target, capabilities);
        if (primary && !result.primary) result.primary = primary;
        if (secondary) result.secondary.push(...secondary);
    }
    return result;
};

/** The one page that owns a target, when it is there. */
export const resolveLinkOut = (
    target: LinkTarget,
    capabilities: ConsoleCapabilities = NO_CAPABILITIES,
): LinkOut | undefined => resolveLinkOuts(target, capabilities).primary;

/** The target for a resource reference, as drawer facts and chips carry them. */
export const resourceTarget = (ref: ResourceRef, view?: 'details' | 'yaml'): LinkTarget =>
    ({ type: 'resource', ref, ...(view ? { view } : {}) });
