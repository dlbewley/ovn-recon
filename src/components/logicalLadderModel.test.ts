import { LogicalDatabase, LogicalTopologySnapshot } from '../types';
import { buildLadderModel, LadderEdge } from './logicalLadderModel';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';

const database = (cnv1 as unknown as LogicalTopologySnapshot).database as LogicalDatabase;

describe('buildLadderModel on the captured cnv-1 zone', () => {
    const model = buildLadderModel(database);
    const uuidByName = new Map(model.constructs.map((construct) => [construct.name, construct.uuid]));
    const byName = (name: string) => model.constructByUuid.get(uuidByName.get(name) ?? '');

    const edgeBetween = (nameA: string, nameB: string): LadderEdge | undefined => {
        const a = uuidByName.get(nameA);
        const b = uuidByName.get(nameB);
        return model.edges.find(
            (edge) =>
                (edge.source === a && edge.target === b) || (edge.source === b && edge.target === a),
        );
    };

    it('derives the default network ladder edges from router-type ports', () => {
        expect(edgeBetween('join', 'GR_cnv-1')).toMatchObject({
            kind: 'router-link',
            role: 'join',
            networks: ['100.64.0.5/16'],
        });
        expect(edgeBetween('join', 'ovn_cluster_router')).toMatchObject({
            kind: 'router-link',
            role: 'join',
            networks: ['100.64.0.1/16'],
        });
        expect(edgeBetween('ext_cnv-1', 'GR_cnv-1')).toMatchObject({
            kind: 'router-link',
            role: 'external',
            networks: ['192.168.4.72/24'],
        });
        expect(edgeBetween('cnv-1', 'ovn_cluster_router')).toMatchObject({
            kind: 'router-link',
            role: 'gateway',
            networks: ['10.131.0.1/23'],
        });
        expect(edgeBetween('transit_switch', 'ovn_cluster_router')).toMatchObject({
            kind: 'router-link',
            role: 'tunnel',
            networks: ['100.88.0.5/16'],
        });
    });

    it('derives the Layer2 CUDN ladder including the peered router pair', () => {
        expect(
            edgeBetween(
                'cluster_udn_example.p.cudn_ovn_layer2_switch',
                'cluster_udn_example.p.cudn_transit_router',
            ),
        ).toMatchObject({ kind: 'router-link', networks: ['10.1.2.1/24'] });

        expect(
            edgeBetween(
                'ext_cluster_udn_example.p.cudn_cnv-1',
                'GR_cluster_udn_example.p.cudn_cnv-1',
            ),
        ).toMatchObject({ kind: 'router-link' });

        const peer = edgeBetween(
            'GR_cluster_udn_example.p.cudn_cnv-1',
            'cluster_udn_example.p.cudn_transit_router',
        );
        expect(peer?.kind).toBe('router-peer');
        expect(peer?.role).toBe('interconnect');
        const allNetworks = [...(peer?.networks ?? []), ...(peer?.peerNetworks ?? [])];
        expect(allNetworks).toContain('100.88.0.10/31');
        expect(allNetworks).toContain('100.88.0.11/31');
    });

    it('deduplicates peered router ports into a single edge', () => {
        const peerEdges = model.edges.filter((edge) => edge.kind === 'router-peer');
        expect(peerEdges).toHaveLength(1);
    });

    it('aggregates switch ports onto their owning switch', () => {
        const nodeSwitch = byName('cnv-1');
        expect(nodeSwitch?.subnet).toBe('10.131.0.0/23');
        expect(nodeSwitch?.podPortCount).toBeGreaterThan(50);
        expect(nodeSwitch?.managementPort).toBe('k8s-cnv-1');

        const transit = byName('transit_switch');
        expect(transit?.remotePeers).toContain('cnv-2');
        expect(transit?.remotePeers).toContain('ctrl-1');
        expect(transit?.remotePeers.length).toBeGreaterThanOrEqual(7);

        const localnet = byName('cluster_udn_machinenet_ovn_localnet_switch');
        expect(localnet?.localnetPorts).toHaveLength(1);
    });

    it('carries NAT and static route counts on routers', () => {
        expect(byName('GR_cnv-1')?.natCount).toBe(74);
        expect(byName('ovn_cluster_router')?.staticRouteCount).toBeGreaterThan(10);
    });

    it('keeps the default network first in the network list', () => {
        expect(model.networks[0]).toBe('default');
    });
});
