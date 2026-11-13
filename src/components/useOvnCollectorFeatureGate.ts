import * as React from 'react';
import { useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';

import { OvnRecon } from '../types';
import { selectPrimaryOvnRecon } from './consoleIntegration';

/** The collector's Deployment: where to look when it does not answer. */
export interface CollectorDeploymentRef {
    namespace: string;
    name: string;
}

interface UseOvnCollectorFeatureGateResult {
    enabled: boolean;
    loaded: boolean;
    loadError: Error | null;
    /** The primary OvnRecon's collector Deployment; absent until an OvnRecon is read. */
    collectorDeployment?: CollectorDeploymentRef;
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

/** The operator's default for spec.targetNamespace (defaultNamespace in the controller). */
export const DEFAULT_TARGET_NAMESPACE = 'ovn-recon';

/**
 * Where the operator runs the collector for an OvnRecon (ovn-recon-nt4.4), by the
 * operator's own rules (targetNamespace and collectorName in
 * operator/internal/controller/ovnrecon_controller.go): `<name>-collector` in the
 * target namespace, read from status.effective first, then the spec, then the default.
 */
export const collectorDeploymentOf = (instance: OvnRecon | undefined): CollectorDeploymentRef | undefined => {
    const name = instance?.metadata?.name;
    if (!name) return undefined;
    return {
        namespace: instance.status?.effective?.targetNamespace
            || instance.spec?.targetNamespace
            || DEFAULT_TARGET_NAMESPACE,
        name: `${name}-collector`,
    };
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
    const primary = React.useMemo(() => selectPrimaryOvnRecon(instances), [instances]);
    const deploymentNamespace = collectorDeploymentOf(primary)?.namespace;
    const deploymentName = collectorDeploymentOf(primary)?.name;
    const collectorDeployment = React.useMemo(
        () => (deploymentNamespace && deploymentName
            ? { namespace: deploymentNamespace, name: deploymentName }
            : undefined),
        [deploymentNamespace, deploymentName],
    );

    return {
        enabled,
        loaded,
        loadError,
        collectorDeployment,
    };
};
