import { ConsoleCapabilities } from './registry';

/**
 * The pure half of useConsoleCapabilities (ovn-recon-zdt.4): what a set of in-use
 * console extensions and CRD flags amount to. No SDK import, so it runs under jest.
 */

/** An extension as the console hands it over: with the plugin that contributed it. */
export interface LoadedExtensionLike {
    type: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    properties: Record<string, any>;
    /** Stamped by the console on every extension in use. */
    pluginName?: string;
}

/** `node-network-configuration` and `/node-network-configuration` are one path. */
const normaliseHref = (href: string): string => (href.startsWith('/') ? href : `/${href}`);

/** Pure: the capabilities a set of in-use extensions and CRD flags amount to. */
export const capabilitiesFrom = (
    extensions: LoadedExtensionLike[],
    crds: ConsoleCapabilities['crds'],
): ConsoleCapabilities => {
    const plugins = new Set<string>();
    const navHrefs = new Map<string, Set<string>>();
    for (const extension of extensions) {
        const plugin = extension.pluginName;
        if (!plugin) continue;
        plugins.add(plugin);
        const href = extension.type === 'console.navigation/href'
            ? extension.properties.href
            : undefined;
        if (typeof href === 'string' && href) {
            const hrefs = navHrefs.get(plugin) ?? new Set<string>();
            hrefs.add(normaliseHref(href));
            navHrefs.set(plugin, hrefs);
        }
    }
    return { plugins, navHrefs, crds };
};
