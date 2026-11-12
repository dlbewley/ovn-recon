import * as React from 'react';
import {
    isHrefNavItem,
    isModelFeatureFlag,
    isResourceClusterNavItem,
    isResourceNSNavItem,
    K8sResourceCommon,
    useFlag,
    useK8sWatchResource,
    useResolvedExtensions,
} from '@openshift-console/dynamic-plugin-sdk';

import { capabilitiesFrom, FlowCollectorLike, LoadedExtensionLike, netobservFrom } from './capabilities';
import { ConsoleCapabilities, CRD_FLAGS, kindReference, NETOBSERV_LOKI_FLAG, NETOBSERV_PLUGIN } from './registry';

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
 * Network Observability (ovn-recon-vqd.1) adds two reads, both only once its
 * plugin is seen: the NETOBSERV_LOKI_ENABLED flag that plugin sets, and the one
 * FlowCollector, named `cluster`. A user who may not read the FlowCollector gets
 * no answer from it, and the links that depend on it stay away.
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

const FLOW_COLLECTOR = {
    groupVersionKind: { group: 'flows.netobserv.io', version: 'v1beta2', kind: 'FlowCollector' },
    name: 'cluster',
    isList: false,
};

export const useConsoleCapabilities = (): ConsoleCapabilities => {
    const [extensions] = useResolvedExtensions(isLightweight);
    // CRD_FLAGS is a constant, so the hooks run in the same order every render.
    const flagValues = CRD_FLAGS.map(({ flag }) => useFlag(flag) as boolean | undefined);
    const flagKey = flagValues.map((value) => (value === undefined ? '?' : value ? '1' : '0')).join('');

    const hasNetobserv = (extensions as LoadedExtensionLike[])
        .some((extension) => extension.pluginName === NETOBSERV_PLUGIN);
    const lokiFlag = useFlag(NETOBSERV_LOKI_FLAG) as boolean | undefined;
    // A null resource watches nothing: no request for a CRD that is not installed.
    const [flowCollector, flowCollectorLoaded, flowCollectorError] = useK8sWatchResource<K8sResourceCommon & FlowCollectorLike>(
        hasNetobserv ? FLOW_COLLECTOR : null,
    );
    const readableFlowCollector = flowCollectorLoaded && !flowCollectorError ? flowCollector : undefined;

    return React.useMemo(() => {
        const crds: Record<string, boolean | undefined> = {};
        CRD_FLAGS.forEach(({ kind }, index) => {
            crds[kindReference(kind)] = flagValues[index];
        });
        const capabilities = capabilitiesFrom(extensions as LoadedExtensionLike[], crds);
        return hasNetobserv
            ? { ...capabilities, netobserv: netobservFrom(lokiFlag, readableFlowCollector) }
            : capabilities;
        // flagKey stands for flagValues, which is a new array every render.
    }, [extensions, flagKey, hasNetobserv, lokiFlag, readableFlowCollector]);
};
