import * as React from 'react';
import {
    isHrefNavItem,
    isModelFeatureFlag,
    isResourceClusterNavItem,
    isResourceNSNavItem,
    useFlag,
    useResolvedExtensions,
} from '@openshift-console/dynamic-plugin-sdk';

import { capabilitiesFrom, LoadedExtensionLike } from './capabilities';
import { ConsoleCapabilities, CRD_FLAGS, kindReference } from './registry';

/**
 * What this console has loaded, for the link-out registry (ovn-recon-zdt.4).
 *
 * Plugins are detected from the `pluginName` the console stamps on every extension
 * in use, and CRDs from the plugin's own `console.flag/model` flags.
 *
 * Only extension types that carry no code reference are asked for: navigation
 * items and model flags. `useResolvedExtensions` resolves every code reference of
 * what it returns, so asking for another plugin's `console.page/route` would make
 * the console download that page just to learn that it exists. A plugin's
 * navigation item for a path sits in the same manifest, behind the same flags, as
 * the route it points at, so the item stands in for the route.
 *
 * The pure half lives in capabilities.ts, because the SDK cannot be loaded
 * under jest: suites replace this module (jest.setup.js) and test that one.
 */

type Extension = Parameters<typeof isHrefNavItem>[0];

const isLightweight = (extension: Extension): extension is Extension =>
    isHrefNavItem(extension)
    || isResourceNSNavItem(extension)
    || isResourceClusterNavItem(extension)
    || isModelFeatureFlag(extension);

export const useConsoleCapabilities = (): ConsoleCapabilities => {
    const [extensions] = useResolvedExtensions(isLightweight);
    // CRD_FLAGS is a constant, so the hooks run in the same order every render.
    const flagValues = CRD_FLAGS.map(({ flag }) => useFlag(flag) as boolean | undefined);
    const flagKey = flagValues.map((value) => (value === undefined ? '?' : value ? '1' : '0')).join('');

    return React.useMemo(() => {
        const crds: Record<string, boolean | undefined> = {};
        CRD_FLAGS.forEach(({ kind }, index) => {
            crds[kindReference(kind)] = flagValues[index];
        });
        return capabilitiesFrom(extensions as LoadedExtensionLike[], crds);
        // flagKey stands for flagValues, which is a new array every render.
    }, [extensions, flagKey]);
};
