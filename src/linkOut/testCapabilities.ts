import { ConsoleCapabilities, CRD_FLAGS, kindReference, NETWORKING_PLUGIN, NMSTATE_PLUGIN } from './registry';

/**
 * Test-only capability sets (ovn-recon-zdt.4), shaped after what the plugins'
 * manifests register on each release.
 */

const allCrds = (present: boolean): Record<string, boolean> =>
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
