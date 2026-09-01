import { LogicalDatabase, LogicalTopologySnapshot } from '../types';
import { buildLadderModel } from './logicalLadderModel';
import { configPayloadFor, ovnKindFor } from './ovnKindRegistry';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';

const database = (cnv1 as unknown as LogicalTopologySnapshot).database as LogicalDatabase;
const model = buildLadderModel(database);
const byName = (name: string) => {
    const construct = model.constructs.find((candidate) => candidate.name === name);
    if (!construct) throw new Error(`construct ${name} not in fixture`);
    return construct;
};

describe('ovnKindRegistry', () => {
    it('assembles a router with its ports, NAT, and static routes', () => {
        const construct = byName('GR_cnv-1');
        const kind = ovnKindFor(construct);
        expect(kind.table).toBe('Logical_Router');
        const rows = kind.rawRows(construct, database) as {
            logicalRouter: { name: string };
            ports: unknown[];
            nat: unknown[];
            staticRoutes: unknown[];
        };
        expect(rows.logicalRouter.name).toBe('GR_cnv-1');
        expect(rows.ports.length).toBeGreaterThan(0);
        expect(rows.nat.length).toBeGreaterThan(0);
        expect(rows.staticRoutes.length).toBeGreaterThan(0);
    });

    it('assembles a switch and caps very long port lists', () => {
        const construct = byName('cnv-1');
        const rows = ovnKindFor(construct).rawRows(construct, database) as {
            logicalSwitch: { name: string };
            ports: unknown[];
            portsOmitted?: number;
        };
        expect(rows.logicalSwitch.name).toBe('cnv-1');
        expect(rows.ports.length).toBeLessThanOrEqual(100);
        const switchRow = database.logicalSwitches.find((row) => row.name === 'cnv-1');
        if ((switchRow?.ports.length ?? 0) > 100) {
            expect(rows.portsOmitted).toBe((switchRow?.ports.length ?? 0) - 100);
        }
    });

    it('assembles a bridge mapping from chassis mappings and localnet ports', () => {
        const construct = model.constructs.find((candidate) => candidate.kind === 'physnet');
        expect(construct).toBeDefined();
        const kind = ovnKindFor(construct!);
        const rows = kind.rawRows(construct!, database) as {
            bridgeMappings: unknown[];
            localnetPorts: unknown[];
        };
        expect(rows.bridgeMappings.length + rows.localnetPorts.length).toBeGreaterThan(0);
    });

    it('falls back to the model view when raw rows are unavailable', () => {
        const construct = byName('GR_cnv-1');
        const withoutDb = configPayloadFor(construct, null);
        expect(withoutDb.source).toBe('model');
        expect(withoutDb.payload.construct).toBe(construct);

        const withDb = configPayloadFor(construct, database);
        expect(withDb.source).toBe('nb-rows');
    });

    it('gives unknown kinds a generic fallback definition', () => {
        const alien = { ...byName('GR_cnv-1'), kind: 'load-balancer' } as never;
        const kind = ovnKindFor(alien);
        expect(kind.table).toBe('OVN northbound');
        expect(kind.rawRows(alien, database)).toBeNull();
        expect(configPayloadFor(alien, database).source).toBe('model');
    });
});
