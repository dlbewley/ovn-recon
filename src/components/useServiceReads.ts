import * as React from 'react';
import { K8sResourceCommon, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';

import { EndpointSliceLike, KubeServiceLike } from './serviceIndex';

/**
 * The Kubernetes reads behind the Services tab (ovn-recon-dp7.6): the
 * cluster Network config while the tab is open, and, while a row is
 * expanded, that Service and its EndpointSlices (one label-selected list in
 * its namespace). There is deliberately no cluster-wide or namespace-wide
 * standing watch; a cluster can hold thousands of Services.
 */

interface NetworkConfig extends K8sResourceCommon {
    spec?: { serviceNetwork?: string[] };
    status?: { serviceNetwork?: string[] };
}

export interface ServiceNetworksResult {
    /** The service network CIDRs; empty until read, or when the read failed. */
    serviceNetworks: string[];
    loaded: boolean;
    error?: string;
}

const errorText = (error: unknown): string | undefined => {
    if (!error) return undefined;
    if (error instanceof Error) return error.message;
    return typeof error === 'string' ? error : String((error as { message?: unknown }).message ?? error);
};

/**
 * The service network from the cluster Network config
 * (config.openshift.io/v1 Network "cluster"): status first, the requested
 * spec when the operator has not reported yet.
 */
export const useServiceNetworks = (): ServiceNetworksResult => {
    const [network, loaded, error] = useK8sWatchResource<NetworkConfig>({
        groupVersionKind: { group: 'config.openshift.io', version: 'v1', kind: 'Network' },
        name: 'cluster',
        isList: false,
    });
    return React.useMemo(() => {
        // A single-object watch can hand back an empty object before it loads.
        const usable = loaded && !error && network;
        const serviceNetworks = usable ? network.status?.serviceNetwork ?? network.spec?.serviceNetwork ?? [] : [];
        return { serviceNetworks, loaded, error: errorText(error) };
    }, [network, loaded, error]);
};

export interface KubeServiceResult {
    service?: KubeServiceLike;
    loaded: boolean;
    error?: string;
}

/** One Service, watched while the component that asks is mounted. */
export const useKubeService = (namespace: string, name: string): KubeServiceResult => {
    const [service, loaded, error] = useK8sWatchResource<KubeServiceLike & K8sResourceCommon>({
        groupVersionKind: { version: 'v1', kind: 'Service' },
        namespace,
        name,
        isList: false,
    });
    return React.useMemo(
        () => ({
            service: loaded && !error && service?.spec ? service : undefined,
            loaded,
            error: errorText(error),
        }),
        [service, loaded, error],
    );
};

export interface EndpointSlicesResult {
    slices: EndpointSliceLike[];
    loaded: boolean;
    error?: string;
}

/**
 * One Service's EndpointSlices: a list by label (a Service can have several
 * slices, one per address family at least), watched while the caller is
 * mounted. `labelKey` is kubernetes.io/service-name for the default network,
 * k8s.ovn.org/service-name for a user-defined network's mirrors.
 */
export const useServiceEndpointSlices = (namespace: string, name: string, labelKey: string): EndpointSlicesResult => {
    const [slices, loaded, error] = useK8sWatchResource<(EndpointSliceLike & K8sResourceCommon)[]>({
        groupVersionKind: { group: 'discovery.k8s.io', version: 'v1', kind: 'EndpointSlice' },
        namespace,
        isList: true,
        selector: { matchLabels: { [labelKey]: name } },
    });
    return React.useMemo(
        () => ({
            slices: loaded && !error && Array.isArray(slices) ? slices : [],
            loaded,
            error: errorText(error),
        }),
        [slices, loaded, error],
    );
};
