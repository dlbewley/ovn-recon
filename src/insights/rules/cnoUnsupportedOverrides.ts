import { CNO_CONFIG_MAPS } from '../../components/cnoConfigModel';
import { cnoConfigMapRef, operatorNetworkRef, readOperator } from '../cno';
import { makeFinding } from '../refs';
import type { Evidence, PhysicalRule } from '../types';

const isSet = (value: unknown): boolean =>
    value !== undefined && value !== null && value !== ''
    && !(Array.isArray(value) && value.length === 0)
    && !(typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0);

/**
 * cno-unsupported-overrides (ovn-recon-n7r.3): the network operator configuration
 * sets `spec.unsupportedConfigOverrides`, or the hidden
 * `ovn-kubernetes-config-overrides` ConfigMap is present in
 * openshift-network-operator. Info: the cluster may work, but outside what is
 * supported, and what runs may differ from what the configuration says. Once, on the
 * network configuration.
 */
export const cnoUnsupportedOverrides: PhysicalRule = {
    id: 'cno-unsupported-overrides',
    severity: 'info',
    scope: 'network',
    domain: 'physical',
    title: 'Unsupported network operator overrides',
    evaluate: ({ cluster }) => {
        const config = cluster.networkConfig;
        if (!config) return [];
        const field = isSet(readOperator(config)?.spec?.unsupportedConfigOverrides);
        const overrides = config.sources.configMaps.overrides;
        const configMap = overrides.status === 'ok';
        if (!field && !configMap) return [];
        const configMapRef = cnoConfigMapRef(CNO_CONFIG_MAPS.overrides);
        const keys = Object.keys(overrides.data?.data ?? {});
        const evidence: Evidence[] = [
            ...(field ? [{
                fact: 'The network operator configuration sets unsupportedConfigOverrides.',
                sources: [operatorNetworkRef],
                path: 'spec.unsupportedConfigOverrides'
            }] : []),
            ...(configMap ? [{
                fact: `ConfigMap ${CNO_CONFIG_MAPS.overrides} is present${keys.length > 0 ? `, with keys ${keys.join(', ')}` : ''}; `
                    + 'the operator passes it to OVN-Kubernetes as hidden overrides.',
                sources: [configMapRef],
                ...(keys.length > 0 ? { path: 'data' } : {})
            }] : [])
        ];
        const what = field && configMap
            ? 'unsupportedConfigOverrides and hidden OVN-Kubernetes overrides are'
            : field ? 'unsupportedConfigOverrides is' : `hidden OVN-Kubernetes overrides (ConfigMap ${CNO_CONFIG_MAPS.overrides}) are`;
        return [makeFinding({
            ruleId: cnoUnsupportedOverrides.id,
            severity: cnoUnsupportedOverrides.severity,
            subject: { kind: 'k8s', ref: operatorNetworkRef },
            scope: {},
            summary: `The network operator's ${what} set; the cluster network runs outside what is supported.`,
            evidence,
            remedy: field
                ? {
                    text: 'Remove spec.unsupportedConfigOverrides once it is no longer needed, after checking with support.',
                    target: operatorNetworkRef,
                    path: 'spec.unsupportedConfigOverrides'
                }
                : {
                    text: `Delete ConfigMap ${CNO_CONFIG_MAPS.overrides} once it is no longer needed, after checking with support.`,
                    target: configMapRef,
                    verb: 'view'
                }
        })];
    }
};
