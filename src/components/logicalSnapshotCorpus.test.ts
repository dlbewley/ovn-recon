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

    // The services section (ovn-recon-e2b.6): Load_Balancer and
    // Load_Balancer_Group as one zone holds them. A live response carries it
    // only with ?include=services; the fixtures hold the full snapshot, as
    // the collector's cache does.
    describe.each(['cnv-1', 'cnv-2', 'ctrl-1'])('%s services section', (name) => {
        const database = corpus[name].database!;
        const loadBalancers = database.loadBalancers ?? [];
        const groups = database.loadBalancerGroups ?? [];
        const lbByUuid = new Map(loadBalancers.map((row) => [row.uuid, row]));
        const groupByUuid = new Map(groups.map((row) => [row.uuid, row]));
        const nodeSwitch = database.logicalSwitches.find((row) => row.name === name)!;
        const gatewayRouter = database.logicalRouters.find((row) => row.name === `GR_${name}`)!;

        it('carries both tables', () => {
            expect(database.loadBalancers).toBeDefined();
            expect(database.loadBalancerGroups).toBeDefined();
            expect(loadBalancers.length).toBeGreaterThan(300);
            expect(new Set(loadBalancers.map((row) => row.uuid)).size).toBe(loadBalancers.length);
        });

        it('resolves every switch, router and group reference', () => {
            for (const row of [...database.logicalSwitches, ...database.logicalRouters]) {
                for (const uuid of row.loadBalancer ?? []) expect(lbByUuid.has(uuid)).toBe(true);
                for (const uuid of row.loadBalancerGroup ?? []) expect(groupByUuid.has(uuid)).toBe(true);
            }
            for (const group of groups) {
                for (const uuid of group.loadBalancers) expect(lbByUuid.has(uuid)).toBe(true);
            }
        });

        it('attributes every row to a Service and names its scope', () => {
            for (const row of loadBalancers) {
                expect(row.externalIds?.['k8s.ovn.org/kind']).toBe('Service');
                expect(row.externalIds?.['k8s.ovn.org/owner']).toMatch(/^[^/]+\/[^/]+$/);
                expect(row.name).toMatch(/_(cluster|node_(router\+switch|router|switch)_.+)$/);
                expect(Object.keys(row.vips).length).toBeGreaterThan(0);
            }
        });

        it('covers the row shapes the drawer has to render', () => {
            const vips = loadBalancers.flatMap((row) => Object.entries(row.vips));
            // A load balancer with several VIPs, and a VIP with several backends.
            expect(loadBalancers.some((row) => Object.keys(row.vips).length > 1)).toBe(true);
            expect(vips.some(([, backends]) => backends.includes(','))).toBe(true);
            // A VIP whose Service has no endpoints keeps its key with ''.
            expect(vips.some(([, backends]) => backends === '')).toBe(true);
            // An IPv6 VIP, bracketed, with bracketed backends.
            expect(vips.some(([vip, backends]) => vip.startsWith('[') && backends.startsWith('['))).toBe(true);
            expect(loadBalancers.some((row) => row.protocol === 'udp')).toBe(true);
            expect(loadBalancers.some((row) => row.protocol === 'tcp')).toBe(true);
            // Session affinity (Service sessionAffinity: ClientIP).
            expect(loadBalancers.some((row) => row.options?.affinity_timeout !== undefined)).toBe(true);
        });

        it('attaches node-scoped rows directly and cluster-scoped rows through clusterLBGroup', () => {
            const onSwitch = new Set(nodeSwitch.loadBalancer ?? []);
            const onRouter = new Set(gatewayRouter.loadBalancer ?? []);
            const both = [...onSwitch].filter((uuid) => onRouter.has(uuid));
            // node_router+switch rows sit on both; node_switch and node_router
            // rows on one side only.
            expect(both.length).toBeGreaterThan(0);
            for (const uuid of both) expect(lbByUuid.get(uuid)!.name).toContain(`_node_router+switch_${name}`);
            expect([...onSwitch].some((uuid) => lbByUuid.get(uuid)!.name.endsWith(`_node_switch_${name}`))).toBe(true);
            expect([...onRouter].some((uuid) => lbByUuid.get(uuid)!.name.endsWith(`_node_router_${name}`))).toBe(true);

            const clusterGroup = groups.find((group) => group.name === 'clusterLBGroup')!;
            expect(nodeSwitch.loadBalancerGroup).toContain(clusterGroup.uuid);
            expect(gatewayRouter.loadBalancerGroup).toContain(clusterGroup.uuid);
            expect(clusterGroup.loadBalancers.length).toBeGreaterThan(300);
            for (const uuid of clusterGroup.loadBalancers) {
                expect(lbByUuid.get(uuid)!.name.endsWith('_cluster')).toBe(true);
                expect(onSwitch.has(uuid)).toBe(false);
            }
        });

        it('keeps the empty per-network groups the UDN switches reference', () => {
            const empty = groups.filter((group) => group.loadBalancers.length === 0).map((group) => group.name);
            expect(empty).toEqual(expect.arrayContaining([
                'clusterSwitchLBGroup',
                'clusterRouterLBGroup',
                'cluster_udn_example.p.cudn_clusterLBGroup',
                'cluster_udn_example.p.cudn_clusterSwitchLBGroup',
                'cluster_udn_example.p.cudn_clusterRouterLBGroup',
            ]));
            const udnSwitch = database.logicalSwitches.find(
                (row) => row.name === 'cluster_udn_example.p.cudn_ovn_layer2_switch',
            )!;
            expect(udnSwitch.loadBalancer ?? []).toEqual([]);
            expect(udnSwitch.loadBalancerGroup).toHaveLength(2);
            for (const uuid of udnSwitch.loadBalancerGroup ?? []) {
                expect(groupByUuid.get(uuid)!.loadBalancers).toEqual([]);
            }
        });
    });

    it('holds the same cluster-scoped load balancers in every zone', () => {
        const clusterRows = (name: string) =>
            (corpus[name].database!.loadBalancers ?? [])
                .filter((row) => row.name.endsWith('_cluster'))
                .map((row) => row.name)
                .sort();
        expect(clusterRows('cnv-1')).toEqual(clusterRows('ctrl-1'));
        expect(clusterRows('cnv-1')).toEqual(clusterRows('cnv-2'));
        const nodeRows = (name: string) =>
            (corpus[name].database!.loadBalancers ?? []).filter((row) => !row.name.endsWith('_cluster')).length;
        expect(nodeRows('cnv-1')).not.toBe(nodeRows('ctrl-1'));
    });

    it('leaves the default fixture without the section', () => {
        expect(corpus.default.database?.loadBalancers).toBeUndefined();
        expect(corpus.default.database?.loadBalancerGroups).toBeUndefined();
    });
});
