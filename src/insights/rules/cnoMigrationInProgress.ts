import { configNetworkRef, operatorNetworkRef, readOperator } from '../cno';
import { makeFinding } from '../refs';
import type { Evidence, PhysicalRule } from '../types';

const isSet = (value: object | undefined): boolean => Boolean(value && Object.keys(value).length > 0);

/**
 * cno-migration-in-progress (ovn-recon-n7r.3): a network migration is under way, set
 * in the operator's `spec.migration` or reported in the cluster network
 * configuration's `status.migration` (an MTU change, a network type change). Info:
 * values elsewhere on the Network config tab may be mid-change. The summary is the
 * model's own migration notice. Once, on the network configuration.
 */
export const cnoMigrationInProgress: PhysicalRule = {
    id: 'cno-migration-in-progress',
    severity: 'info',
    scope: 'network',
    domain: 'physical',
    title: 'Network migration in progress',
    evaluate: ({ cluster }) => {
        const config = cluster.networkConfig;
        if (!config) return [];
        const spec = isSet(readOperator(config)?.spec?.migration);
        const configNetwork = config.sources.configNetwork.status === 'ok' ? config.sources.configNetwork.data : undefined;
        const status = isSet(configNetwork?.status?.migration);
        if (!spec && !status) return [];
        const notice = config.model.notices.find((candidate) => candidate.id === 'migration');
        const evidence: Evidence[] = [
            ...(spec ? [{ fact: 'The network operator configuration sets a migration.', sources: [operatorNetworkRef], path: 'spec.migration' }] : []),
            ...(status ? [{ fact: 'The cluster network configuration reports a migration.', sources: [configNetworkRef], path: 'status.migration' }] : [])
        ];
        return [makeFinding({
            ruleId: cnoMigrationInProgress.id,
            severity: cnoMigrationInProgress.severity,
            subject: { kind: 'k8s', ref: operatorNetworkRef },
            scope: {},
            summary: `A network migration is in progress${notice?.body ? `: ${notice.body}` : ''}.`,
            evidence,
            remedy: {
                text: 'Let the migration finish: follow the network ClusterOperator\'s conditions and the MachineConfigPool '
                    + 'rollout. Clear spec.migration once the documented procedure says to.',
                target: operatorNetworkRef,
                verb: 'view'
            }
        })];
    }
};
