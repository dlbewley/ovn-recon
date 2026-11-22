import { DEFAULTS, SOURCE_LABELS } from '../../components/cnoConfigModel';
import type { ConditionRow } from '../../components/cnoConfigModel';
import { networkClusterOperatorRef, operatorNetworkRef, readOperator, refForSource } from '../cno';
import { makeFinding } from '../refs';
import type { Evidence, PhysicalRule } from '../types';

const OPERATOR_SOURCES: readonly string[] = [SOURCE_LABELS.clusterOperator, SOURCE_LABELS.operator];

/**
 * A condition that says the operator is unwell: Degraded (or ManagementStateDegraded)
 * True, Available False, or Progressing True for longer than the model's threshold
 * (the model notes how long; LONG_PROGRESSING_MS).
 */
const unhealthy = (row: ConditionRow): boolean =>
    OPERATOR_SOURCES.includes(row.source) && (
        (/Degraded$/.test(row.type) && row.status === 'True')
        || (row.type === 'Available' && row.status === 'False')
        || (row.type === 'Progressing' && row.status === 'True' && Boolean(row.note)));

const conditionFact = (row: ConditionRow): string => {
    const detail = [row.reason, row.message].filter(Boolean).join(': ');
    return `${row.source} reports ${row.type}=${row.status}${row.note ? ` (${row.note})` : ''}${detail ? `: ${detail}` : ''}.`;
};

/**
 * cno-operator-unhealthy (ovn-recon-n7r.3): the Cluster Network Operator is Degraded,
 * not Available, Progressing for a long time, or not Managed (so it is not reconciling
 * the network at all). Reads the condition rows the Network config tab draws, from
 * the network ClusterOperator and the operator configuration, and the operator's
 * managementState. Once, on the ClusterOperator.
 */
export const cnoOperatorUnhealthy: PhysicalRule = {
    id: 'cno-operator-unhealthy',
    severity: 'warning',
    scope: 'network',
    domain: 'physical',
    title: 'Cluster Network Operator unhealthy',
    evaluate: ({ cluster }) => {
        const config = cluster.networkConfig;
        if (!config) return [];
        const rows = config.model.conditions.filter(unhealthy);
        const managementState = readOperator(config)?.spec?.managementState ?? DEFAULTS.managementState;
        const unmanaged = readOperator(config) !== undefined && managementState !== DEFAULTS.managementState;
        if (rows.length === 0 && !unmanaged) return [];

        const evidence: Evidence[] = [
            ...(unmanaged ? [{
                fact: `The network operator's managementState is ${managementState}, so it is not reconciling the cluster network.`,
                sources: [operatorNetworkRef],
                path: 'spec.managementState'
            }] : []),
            ...rows.map((row): Evidence => ({
                fact: conditionFact(row),
                sources: [refForSource(row.source)],
                path: `status.conditions[type=${row.type}]`
            }))
        ];
        const states = [
            ...(unmanaged ? [managementState] : []),
            ...[...new Set(rows.map((row) => (row.type === 'Available' ? 'not Available'
                : row.type === 'Progressing' ? `Progressing${row.note ? ` (${row.note.replace(/^Progressing for /, 'for ')})` : ''}`
                    : row.type)))]
        ];
        return [makeFinding({
            ruleId: cnoOperatorUnhealthy.id,
            severity: cnoOperatorUnhealthy.severity,
            subject: { kind: 'k8s', ref: networkClusterOperatorRef },
            scope: {},
            summary: `The Cluster Network Operator is ${states.join(', ')}.`,
            evidence,
            remedy: unmanaged && rows.length === 0
                ? {
                    text: `Set managementState back to ${DEFAULTS.managementState} once whatever needed the operator held off is done.`,
                    target: operatorNetworkRef,
                    path: 'spec.managementState'
                }
                : {
                    text: 'Read the conditions\' messages on the network ClusterOperator, then the pods and events in '
                        + 'openshift-network-operator and openshift-ovn-kubernetes.',
                    target: networkClusterOperatorRef,
                    verb: 'view'
                }
        })];
    }
};
