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

    it('includes the Gateway_Chassis rows a router\'s gateway ports reference', () => {
        const construct = byName('ovn_cluster_router');
        const rows = ovnKindFor(construct).rawRows(construct, database) as {
            gatewayChassis?: Array<{ name: string; chassisName: string; priority: number }>;
        };
        expect(rows.gatewayChassis?.map((row) => row.name)).toContain(
            'rtos-cnv-1-91bc7389-d1b9-4fef-9f4c-52e3eedab004',
        );

        // A router without gateway ports omits the key rather than emitting [].
        const gateway = byName('GR_cnv-1');
        const gatewayRows = ovnKindFor(gateway).rawRows(gateway, database) as Record<string, unknown>;
        expect('gatewayChassis' in gatewayRows).toBe(false);
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

    it('adds the load balancer rows a switch or router references when the section is present', () => {
        type Rows = { loadBalancers?: Array<{ uuid: string }>; loadBalancerGroups?: Array<{ name: string }> };
        const nodeSwitch = byName('cnv-1');
        const switchRow = database.logicalSwitches.find((row) => row.name === 'cnv-1')!;
        const rows = ovnKindFor(nodeSwitch).rawRows(nodeSwitch, database) as Rows;
        // Direct rows in full; groups as their own rows, members left as uuids.
        expect(rows.loadBalancers?.map((row) => row.uuid)).toEqual(switchRow.loadBalancer);
        expect(rows.loadBalancerGroups?.map((group) => group.name)).toEqual(['clusterLBGroup', 'clusterSwitchLBGroup']);

        const gateway = byName('GR_cnv-1');
        const gatewayRows = ovnKindFor(gateway).rawRows(gateway, database) as Rows;
        expect(gatewayRows.loadBalancers).toHaveLength(22);
        expect(gatewayRows.loadBalancerGroups?.map((group) => group.name)).toEqual(['clusterLBGroup', 'clusterRouterLBGroup']);

        // A UDN switch attaches groups only; a construct without references
        // gets neither key.
        const udn = byName('cluster_udn_example.p.cudn_ovn_layer2_switch');
        const udnRows = ovnKindFor(udn).rawRows(udn, database) as Rows;
        expect('loadBalancers' in udnRows).toBe(false);
        expect(udnRows.loadBalancerGroups).toHaveLength(2);
        const join = byName('join');
        const joinRows = ovnKindFor(join).rawRows(join, database) as Rows;
        expect('loadBalancers' in joinRows).toBe(false);
        expect('loadBalancerGroups' in joinRows).toBe(false);
    });

    it('leaves the load balancer rows out when the section was not requested', () => {
        const ladder: LogicalDatabase = { ...database };
        delete ladder.loadBalancers;
        delete ladder.loadBalancerGroups;
        const nodeSwitch = byName('cnv-1');
        const rows = ovnKindFor(nodeSwitch).rawRows(nodeSwitch, ladder) as Record<string, unknown>;
        expect(rows.logicalSwitch).toBeDefined();
        expect('loadBalancers' in rows).toBe(false);
        expect('loadBalancerGroups' in rows).toBe(false);
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

    it('caps the inlined port rows unless told otherwise (the detail page lifts the cap)', () => {
        const construct = byName('cnv-1');
        const capped = configPayloadFor(construct, database, { maxPorts: 10 }).payload as { ports: unknown[]; portsOmitted?: number };
        expect(capped.ports).toHaveLength(10);
        expect(capped.portsOmitted).toBe(construct.ports.length - 10);
        const all = configPayloadFor(construct, database, { maxPorts: Infinity }).payload as { ports: unknown[]; portsOmitted?: number };
        expect(all.ports).toHaveLength(construct.ports.length);
        expect(all.portsOmitted).toBeUndefined();
    });

    it('gives unknown kinds a generic fallback definition', () => {
        const alien = { ...byName('GR_cnv-1'), kind: 'load-balancer' } as never;
        const kind = ovnKindFor(alien);
        expect(kind.table).toBe('OVN northbound');
        expect(kind.rawRows(alien, database)).toBeNull();
        expect(configPayloadFor(alien, database).source).toBe('model');
    });
});
