import * as React from 'react';
import { useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';

import { OvnRecon } from '../types';

interface UseOvnCollectorFeatureGateResult {
    enabled: boolean;
    loaded: boolean;
    loadError: Error | null;
}

const isCollectorFeatureEnabled = (instance: OvnRecon): boolean => {
    const gateFromCollector = instance.spec?.collector?.enabled;
    if (typeof gateFromCollector === 'boolean') {
        return gateFromCollector;
    }

    const gateFromFeatureGates = instance.spec?.featureGates?.['ovn-collector'];
    if (gateFromFeatureGates === true) {
        return true;
    }

    const gateFromFeatures = instance.spec?.features?.['ovn-collector'];
    return gateFromFeatures === true;
};

export const useOvnCollectorFeatureGate = (): UseOvnCollectorFeatureGateResult => {
    const [instances, loaded, loadError] = useK8sWatchResource<OvnRecon[]>({
        groupVersionKind: {
            group: 'recon.bewley.net',
            version: 'v1alpha1',
            kind: 'OvnRecon',
        },
        isList: true,
    });

    const enabled = React.useMemo(() => (instances || []).some(isCollectorFeatureEnabled), [instances]);

    return {
        enabled,
        loaded,
        loadError,
    };
};
