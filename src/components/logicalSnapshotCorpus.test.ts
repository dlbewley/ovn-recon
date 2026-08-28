import { LOGICAL_TOPOLOGY_SCHEMA_V2, LogicalTopologySnapshot } from '../types';

// The captured corpus is the single source of truth shared with the collector
// (served as its fixture fallback and validated by its Go contract tests).
import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';
import cnv2 from '../../collector/fixtures/snapshots/cnv-2.json';
import ctrl1 from '../../collector/fixtures/snapshots/ctrl-1.json';
import defaultSnapshot from '../../collector/fixtures/snapshots/default.json';

const corpus: Record<string, LogicalTopologySnapshot> = {
    'cnv-1': cnv1 as unknown as LogicalTopologySnapshot,
    'cnv-2': cnv2 as unknown as LogicalTopologySnapshot,
    'ctrl-1': ctrl1 as unknown as LogicalTopologySnapshot,
    default: defaultSnapshot as unknown as LogicalTopologySnapshot,
};

describe('captured logical snapshot corpus', () => {
    it.each(Object.entries(corpus))('%s declares the v2 contract', (_name, snapshot) => {
        expect(snapshot.metadata.schemaVersion).toBe(LOGICAL_TOPOLOGY_SCHEMA_V2);
        expect(snapshot.database).toBeDefined();
    });

    it.each(['cnv-1', 'cnv-2', 'ctrl-1'])('%s carries a populated zone database', (name) => {
        const database = corpus[name].database;
        expect(database).toBeDefined();
        if (!database) return;
        expect(database.logicalRouters.length).toBeGreaterThan(0);
        expect(database.logicalRouterPorts.length).toBeGreaterThan(0);
        expect(database.logicalSwitches.length).toBeGreaterThan(0);
        expect(database.logicalSwitchPorts.length).toBeGreaterThan(0);
        expect(database.nats.length).toBeGreaterThan(0);
        expect(database.staticRoutes.length).toBeGreaterThan(0);
    });

    it('covers the network topology variants present on the capture cluster', () => {
        const cnv1Db = corpus['cnv-1'].database;
        expect(cnv1Db).toBeDefined();
        if (!cnv1Db) return;

        const topologies = new Set(
            cnv1Db.logicalRouters
                .map((router) => router.externalIds?.['k8s.ovn.org/topology'])
                .filter(Boolean),
        );
        // Layer2 primary CUDN routers announce their topology; the default
        // cluster network's routers carry no topology external_id.
        expect(topologies.has('layer2')).toBe(true);

        const roles = new Set(
            cnv1Db.logicalSwitches
                .map((logicalSwitch) => logicalSwitch.externalIds?.['k8s.ovn.org/role'])
                .filter(Boolean),
        );
        expect(roles.has('primary')).toBe(true);
        expect(roles.has('secondary')).toBe(true);

        const localnetSwitches = cnv1Db.logicalSwitches.filter((logicalSwitch) =>
            logicalSwitch.name.includes('localnet'),
        );
        expect(localnetSwitches.length).toBeGreaterThan(0);

        // The default cluster network (Layer3): per-node workload switch named
        // after the node, with its host subnet in other_config.
        const nodeSwitch = cnv1Db.logicalSwitches.find((logicalSwitch) => logicalSwitch.name === 'cnv-1');
        expect(nodeSwitch?.otherConfig?.subnet).toBeDefined();
    });
});
