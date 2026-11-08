import { LogicalTopologySnapshot } from '../types';
import { buildLadderModel } from './logicalLadderModel';
import { mergeZones } from './logicalClusterModel';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';
import cnv2 from '../../collector/fixtures/snapshots/cnv-2.json';
import ctrl1 from '../../collector/fixtures/snapshots/ctrl-1.json';

const snapshots = [cnv1, cnv2, ctrl1] as unknown as LogicalTopologySnapshot[];

describe('mergeZones over the captured corpus', () => {
    const merged = mergeZones(snapshots);
    const byName = new Map(merged.constructs.map((construct) => [construct.name, construct]));

    it('unions switch ports by name across zones, keeping the type-then-name order', () => {
        const transit = byName.get('transit_switch')!;
        const perZone = snapshots.map((snapshot) =>
            buildLadderModel(snapshot.database!).constructs.find((construct) => construct.name === 'transit_switch')!,
        );
        const unionNames = new Set(perZone.flatMap((zone) => zone.ports.map((port) => port.name)));
        expect(transit.ports.map((port) => port.name).sort()).toEqual([...unionNames].sort());
        // tstor-<node> is a router port in its own zone and a remote port in
        // every other; the name-keyed union keeps one row per name (the first
        // zone's), so each node's transit port appears exactly once.
        const names = transit.ports.map((port) => port.name);
        expect(new Set(names).size).toBe(names.length);
        for (const node of ['cnv-1', 'cnv-2', 'ctrl-1']) {
            expect(names).toContain(`tstor-${node}`);
        }
        const types = transit.ports.map((port) => port.row.type ?? '');
        expect(types).toEqual([...types].sort((a, b) => a.localeCompare(b)));
        // The NB row travels with the port, so per-port columns work in the cluster view.
        expect(transit.ports.every((port) => port.row.uuid === port.uuid)).toBe(true);
    });

    it('counts contributing zones', () => {
        expect(merged.zoneCount).toBe(3);
    });

    it('merges zone-replicated constructs into one instance with provenance', () => {
        const transit = byName.get('transit_switch');
        expect(transit?.zones.sort()).toEqual(['cnv-1', 'cnv-2', 'ctrl-1']);

        const clusterRouter = byName.get('ovn_cluster_router');
        expect(clusterRouter?.zones).toHaveLength(3);

        const layer2 = byName.get('cluster_udn_example.p.cudn_ovn_layer2_switch');
        expect(layer2?.zones).toHaveLength(3);

        const transitRouter = byName.get('cluster_udn_example.p.cudn_transit_router');
        expect(transitRouter?.zones).toHaveLength(3);
    });

    it('keeps node-bound constructs distinct per node', () => {
        for (const node of ['cnv-1', 'cnv-2', 'ctrl-1']) {
            expect(byName.get(`GR_${node}`)?.zones).toEqual([node]);
            expect(byName.get(`ext_${node}`)?.zones).toEqual([node]);
            expect(byName.get(node)?.role).toBe('node-switch');
        }
        const gateways = merged.constructs.filter(
            (construct) => construct.role === 'gateway-router' && construct.network === 'default',
        );
        expect(gateways).toHaveLength(3);
    });

    it('sums local workload ports across zones', () => {
        const layer2Name = 'cluster_udn_example.p.cudn_ovn_layer2_switch';
        const expected = snapshots
            .map((snapshot) => buildLadderModel(snapshot.database!))
            .map((model) => model.constructs.find((construct) => construct.name === layer2Name)?.podPortCount ?? 0)
            .reduce((total, count) => total + count, 0);
        expect(byName.get(layer2Name)?.podPortCount).toBe(expected);
    });

    it('unions gateway port placements of a distributed router across zones', () => {
        const clusterRouter = byName.get('ovn_cluster_router');
        const ports = clusterRouter?.gatewayPorts.map((placement) => placement.port).sort();
        expect(ports).toEqual(['rtos-cnv-1', 'rtos-cnv-2', 'rtos-ctrl-1']);
        // Each node's gateway port is hosted on that node's own chassis.
        const hosts = new Set(clusterRouter?.gatewayPorts.map((placement) => placement.hostingChassis));
        expect(hosts.size).toBe(3);
    });

    it('takes the maximum reference count across zones and keeps a disabled router disabled', () => {
        const perZone = snapshots
            .map((snapshot) => buildLadderModel(snapshot.database!))
            .map((model) => model.constructs.find((construct) => construct.name === 'ovn_cluster_router')?.policyCount ?? 0);
        expect(byName.get('ovn_cluster_router')?.policyCount).toBe(Math.max(...perZone));

        const [first, second] = snapshots;
        const disabledInOne = mergeZones([
            {
                ...first,
                database: {
                    ...first.database!,
                    logicalRouters: first.database!.logicalRouters.map((router) =>
                        router.name === 'ovn_cluster_router' ? { ...router, enabled: false } : router,
                    ),
                },
            },
            second,
        ]);
        const merged = disabledInOne.constructs.find((construct) => construct.name === 'ovn_cluster_router');
        expect(merged?.enabled).toBe(false);
    });

    it('unions transit tunnel peers across zones', () => {
        const transit = byName.get('transit_switch');
        // Every zone contributes its own remote peers; the union covers all
        // other nodes in the cluster, including nodes we did not snapshot.
        expect(transit?.remotePeers).toEqual(expect.arrayContaining(['cnv-1', 'cnv-2', 'ctrl-1', 'cnv-4']));
    });

    it('merges shared edges and keeps per-node edges distinct', () => {
        const joinUuid = merged.constructs.find((construct) => construct.name === 'join')?.uuid;
        const joinEdges = merged.edges.filter(
            (edge) => edge.source === joinUuid || edge.target === joinUuid,
        );
        // join connects to ovn_cluster_router (merged to one edge) and to
        // each node's gateway router (one edge per node).
        expect(joinEdges).toHaveLength(4);
    });

    it('keeps the default network first and lists every network', () => {
        expect(merged.networks[0]).toBe('default');
        expect(merged.networks).toContain('cluster_udn_example-p-cudn');
        expect(merged.networks).toContain('cluster_udn_machinenet');
    });

    it('merges bridge mappings with bridge resolution surviving partial chassis coverage', () => {
        const physnet = merged.constructByUuid.get('physnet:default:physnet');
        expect(physnet?.zones.sort()).toEqual(['cnv-1', 'cnv-2', 'ctrl-1']);
        expect(physnet?.bridge).toBe('br-ex');

        // The vlan-1924 switch references physnet-vmdata from every zone,
        // but only the cnv workers' chassis actually map it — the merged
        // construct still resolves br-vmdata from the nodes that do.
        const vmdata = merged.constructByUuid.get('physnet:cluster_udn_vlan-1924:physnet-vmdata');
        expect(vmdata?.zones.sort()).toEqual(['cnv-1', 'cnv-2', 'ctrl-1']);
        expect(vmdata?.bridge).toBe('br-vmdata');
    });

    it('produces a model the ladder layout can place without loss', () => {
        for (const construct of merged.constructs) {
            expect(merged.constructByUuid.get(construct.uuid)).toBe(construct);
        }
        for (const edge of merged.edges) {
            expect(merged.constructByUuid.has(edge.source)).toBe(true);
            expect(merged.constructByUuid.has(edge.target)).toBe(true);
        }
    });
});
