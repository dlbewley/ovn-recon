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
