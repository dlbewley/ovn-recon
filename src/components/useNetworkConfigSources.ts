import * as React from 'react';
import { K8sResourceCommon, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';

import type { ClusterOperator, ConfigMap, ConfigNetwork, FeatureGate, Infrastructure, OperatorNetwork } from '../types';
import {
    CNO_CONFIG_MAPS,
    CNO_NAMESPACE,
    CnoConfigInputs,
    CnoConfigMapId,
    CONFIG_NETWORK,
    FEATURE_GATE,
    INFRASTRUCTURE,
    NETWORK_CLUSTER_OPERATOR,
    OPERATOR_NETWORK,
    ResourceIdentity,
    Source,
    sourceOf,
} from './cnoConfigModel';

/**
 * The cluster network configuration's sources (ovn-recon-n7r.1): one watch per object,
 * each read with the console user's own token and each settling on its own, so a
 * resource the user may not read is `forbidden` and the rest still draw. Nothing here
 * asks the collector, and the ConfigMaps are optional: absent is ordinary.
 */
export type NetworkConfigSources = Omit<CnoConfigInputs, 'nodes'>;

const groupVersionKind = ({ apiVersion, kind }: ResourceIdentity) => {
    const [group, version] = apiVersion.includes('/') ? apiVersion.split('/') : [undefined, apiVersion];
    return { ...(group ? { group } : {}), version, kind };
};

const useSource = <T extends K8sResourceCommon>(resource: ResourceIdentity): Source<T> => {
    const [data, loaded, error] = useK8sWatchResource<T>({
        groupVersionKind: groupVersionKind(resource),
        name: resource.name,
        ...(resource.namespace ? { namespace: resource.namespace, namespaced: true } : {}),
    });
    return React.useMemo(() => sourceOf<T>(data, loaded, error), [data, loaded, error]);
};

const useConfigMap = (id: CnoConfigMapId): Source<ConfigMap> =>
    useSource<ConfigMap>({ apiVersion: 'v1', kind: 'ConfigMap', namespace: CNO_NAMESPACE, name: CNO_CONFIG_MAPS[id] });

export const useNetworkConfigSources = (): NetworkConfigSources => {
    const operatorNetwork = useSource<OperatorNetwork>(OPERATOR_NETWORK);
    const configNetwork = useSource<ConfigNetwork>(CONFIG_NETWORK);
    const clusterOperator = useSource<ClusterOperator>(NETWORK_CLUSTER_OPERATOR);
    const featureGate = useSource<FeatureGate>(FEATURE_GATE);
    const infrastructure = useSource<Infrastructure>(INFRASTRUCTURE);
    const appliedCluster = useConfigMap('appliedCluster');
    const mtu = useConfigMap('mtu');
    const overrides = useConfigMap('overrides');
    const gatewayMode = useConfigMap('gatewayMode');

    const configMaps = React.useMemo(
        () => ({ appliedCluster, mtu, overrides, gatewayMode }),
        [appliedCluster, mtu, overrides, gatewayMode],
    );
    return React.useMemo(
        () => ({ operatorNetwork, configNetwork, clusterOperator, featureGate, infrastructure, configMaps }),
        [operatorNetwork, configNetwork, clusterOperator, featureGate, infrastructure, configMaps],
    );
};
