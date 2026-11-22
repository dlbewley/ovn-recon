import { cnoWith, networkConfigOf } from '../cnoTesting';
import { clusterContext } from '../testing';
import { cnoMigrationInProgress } from './cnoMigrationInProgress';

describe('cno-migration-in-progress', () => {
    it('reports an MTU migration, with the model\'s description', () => {
        const data = cnoWith((d) => {
            d.operatorNetwork.spec!.migration = { mtu: { network: { from: 1400, to: 8900 }, machine: { to: 9000 } } };
            d.configNetwork.status!.migration = { mtu: { network: { from: 1400, to: 8900 }, machine: { to: 9000 } } };
        });
        const findings = cnoMigrationInProgress.evaluate(clusterContext({ networkConfig: networkConfigOf(data) }));
        expect(findings).toHaveLength(1);
        expect(findings[0].severity).toBe('info');
        expect(findings[0].summary).toBe('A network migration is in progress: cluster MTU 1400 to 8900; machine MTU ? to 9000.');
        expect(findings[0].evidence.map((e) => e.path)).toEqual(['spec.migration', 'status.migration']);
    });

    it('is quiet with no migration', () => {
        expect(cnoMigrationInProgress.evaluate(clusterContext({ networkConfig: networkConfigOf() }))).toEqual([]);
    });
});
