import * as React from 'react';
import { useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';

import { OvnRecon } from '../types';

interface UseOvnCollectorFeatureGateResult {
    enabled: boolean;
    loaded: boolean;
    loadError: Error | null;
}

const isCollectorFeatureEnabled = (instance: OvnRecon): boolean => {
    // Only spec.collector.enabled is an explicit signal; the collector
    // defaults ON when it is unset.
    const gateFromCollector = instance.spec?.collector?.enabled;
    if (typeof gateFromCollector === 'boolean') {
        return gateFromCollector;
    }
    return true;
};

export const useOvnCollectorFeatureGate = (): UseOvnCollectorFeatureGateResult => {
    const [instances, loaded, loadError] = useK8sWatchResource<OvnRecon[]>({
        groupVersionKind: {
            group: 'recon.bewley.net',
            // v1beta1 is the only served version; watching an unserved
            // version breaks the console with "Model does not exist".
            version: 'v1beta1',
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
