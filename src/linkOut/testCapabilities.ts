import {
    ConsoleCapabilities, CRD_FLAGS, kindReference, NetObservCapabilities, NETOBSERV_PLUGIN, NETOBSERV_TRAFFIC_PATH,
    NETOBSERV_UDN_MAPPING, NETWORKING_PLUGIN, NMSTATE_PLUGIN
} from './registry';

/**
 * Test-only capability sets (ovn-recon-zdt.4), shaped after what the plugins'
 * manifests register on each release.
 */

export const allCrds = (present: boolean): Record<string, boolean> =>
    Object.fromEntries(CRD_FLAGS.map(({ kind }) => [kindReference(kind), present]));

export const capabilities = (
    plugins: Record<string, string[]>,
    crds: ConsoleCapabilities['crds'] = allCrds(true),
): ConsoleCapabilities => ({
    plugins: new Set(Object.keys(plugins)),
    navHrefs: new Map(Object.entries(plugins).map(([plugin, hrefs]) => [plugin, new Set(hrefs)])),
    crds,
});

/** 4.22: nmstate owns both the topology and Physical networks. */
export const OCP_4_22 = capabilities({
    [NETWORKING_PLUGIN]: [],
    [NMSTATE_PLUGIN]: ['/node-network-configuration', '/physical-networks'],
});

/** 5.1: Physical networks moved to the networking plugin. */
export const OCP_5_1 = capabilities({
    [NETWORKING_PLUGIN]: ['/physical-networks'],
    [NMSTATE_PLUGIN]: ['/node-network-configuration'],
});

/** Neither plugin, and none of the CRDs. */
export const BARE = capabilities({}, allCrds(false));

/** Network Observability loaded beside the 4.22 plugins, answering what `netobserv` says. */
export const withNetobserv = (netobserv: NetObservCapabilities | undefined): ConsoleCapabilities => ({
    ...capabilities({
        [NETWORKING_PLUGIN]: [],
        [NMSTATE_PLUGIN]: ['/node-network-configuration', '/physical-networks'],
        [NETOBSERV_PLUGIN]: ['/network-health', NETOBSERV_TRAFFIC_PATH],
    }),
    ...(netobserv ? { netobserv } : {}),
});

/** Loki, node metrics and UDN mapping: every traffic link has something to show. */
export const NETOBSERV_FULL = withNetobserv({
    loki: true,
    nodeMetrics: true,
    features: new Set([NETOBSERV_UDN_MAPPING]),
});
