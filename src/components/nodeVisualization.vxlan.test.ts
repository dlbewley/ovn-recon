import fs from 'fs';
import path from 'path';

import { buildGraphContext, GraphContext } from '../topology/context';
import { descriptorFor } from '../topology/descriptors';
import { laneOrderingInput, layoutLanes, LaneViewState } from '../topology/lanes';
import { nodeKindRegistry } from '../topology/registry';
import { Fact, NodeKind } from '../topology/types';
import { buildNodeViewModel } from '../topology/viewModel';
import { buildTopologyEdges, TopologyEdge } from './nodeVisualizationModel';
import { findInterfaceHoldingAddress } from './nodeVisualizationSelectors';
import { Interface, NodeNetworkState } from '../types';

/**
 * A VXLAN device is a topology participant, not an "other interface" (ovn-recon-s3t.52).
 *
 * On an EVPN-enabled node the chain is: the interface holding the VTEP address ->
 * the VXLAN device -> the linux bridge it is enslaved to -> a VLAN on that bridge ->
 * the UDN's VRF. Every hop already had a lane except the VXLAN device, which fell
 * through classify() to the catch-all grid and was drawn with no edges at all.
 */
const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

const VIEW: LaneViewState = { showHiddenColumns: false, showNads: false, showLldp: false };
const METRICS = { padding: 20, itemHeight: 80, itemGap: 20, colSpacing: 220 };

const ctxFor = (nns: NodeNetworkState): GraphContext => buildGraphContext({ nns });
const ctx = ctxFor(fixture<NodeNetworkState>('nns', 'evpn-vxlan.json'));
const vxlan = ctx.interfaces.find((i) => i.type === 'vxlan')!;

const edgeByRule = (edges: TopologyEdge[], rule: string, source?: string): TopologyEdge | undefined =>
    edges.find((e) => e.rule === rule && (source === undefined || e.source === source));

describe('a VXLAN device has a lane', () => {
    it('draws in the VLAN lane, beside the VLAN devices', () => {
        const laid = layoutLanes(ctx, VIEW, METRICS, {}, () => null);
        const vlanLane = laid.lanes.find(({ lane }) => lane.id === 'vlan')!;
        const ids = vlanLane.groups.flatMap((g) => g.nodes.map((n) => n.id));
        expect(ids).toContain('iface:evx4.4a75265e');
        expect(ids).toContain('iface:svl2.9');
    });

    it('is a distinct node type from a VLAN, so the two are tellable apart', () => {
        const descriptor = descriptorFor('vxlan')!;
        expect(descriptor.lane).toBe('vlan');
        expect(descriptor.color).not.toBe(descriptorFor('vlan')!.color);
    });

    it('contributes to the ordering pass through the same lane', () => {
        const { lanes } = laneOrderingInput(ctx, VIEW);
        expect(lanes.find((l) => l.id === 'vlan')?.nodeIds).toContain('iface:evx4.4a75265e');
    });
});

describe('a VXLAN device is connected', () => {
    const { edges, unresolved } = buildTopologyEdges(ctx, VIEW);

    it('is a port of the bridge it is enslaved to', () => {
        expect(edgeByRule(edges, 'controller', 'iface:evx4.4a75265e')).toMatchObject({
            target: 'iface:evbr.4a75265e',
            kind: 'membership',
            provenance: 'observed'
        });
    });

    it('is carried on the interface holding its VTEP address', () => {
        // vxlan.local is the node IP, which the br-ex internal port holds. A reference
        // by name means the bridge, so the layering edge lands on the visible br-ex
        // node rather than on its hidden internal port.
        const underlay = edgeByRule(edges, 'vxlan-local');
        expect(underlay).toMatchObject({
            source: 'iface:br-ex',
            target: 'iface:evx4.4a75265e',
            kind: 'layering',
            provenance: 'observed'
        });
        expect(underlay?.rationale).toContain('192.0.2.72');
        expect(underlay?.rationale).toContain('br-ex');
    });

    it('completes the chain to the VRF: bridge -> VLAN -> VRF', () => {
        // Layering runs from the carrier to what rides on it; membership from the port
        // to its container. Both are read straight off svl2.9.
        expect(edgeByRule(edges, 'base-iface', 'iface:evbr.4a75265e')).toMatchObject({ target: 'iface:svl2.9', kind: 'layering' });
        expect(edgeByRule(edges, 'controller', 'iface:svl2.9')).toMatchObject({ target: 'vrf:mp9-udn-vrf', kind: 'membership' });
    });

    it('leaves nothing dangling on this capture', () => {
        expect(unresolved.filter((u) => u.rule === 'vxlan-local')).toEqual([]);
    });

    it('reports a VTEP address no interface holds instead of dropping it', () => {
        const orphan = ctxFor({
            apiVersion: 'nmstate.io/v1',
            kind: 'NodeNetworkState',
            metadata: { name: 'orphan-vtep' },
            status: {
                currentState: {
                    interfaces: [
                        { name: 'vxlan100', type: 'vxlan', state: 'up', vxlan: { id: 100, local: '198.51.100.9' } }
                    ]
                }
            }
        } as NodeNetworkState);
        const result = buildTopologyEdges(orphan, VIEW);
        expect(result.edges.filter((e) => e.rule === 'vxlan-local')).toEqual([]);
        expect(result.unresolved).toContainEqual({
            rule: 'vxlan-local', reference: '198.51.100.9', from: 'iface:vxlan100'
        });
    });

    it('draws no underlay edge when nmstate reports no local address', () => {
        const bare = ctxFor({
            apiVersion: 'nmstate.io/v1',
            kind: 'NodeNetworkState',
            metadata: { name: 'bare-vxlan' },
            status: { currentState: { interfaces: [{ name: 'vxlan0', type: 'vxlan', state: 'up' }] } }
        } as NodeNetworkState);
        const result = buildTopologyEdges(bare, VIEW);
        expect(result.edges).toEqual([]);
        expect(result.unresolved).toEqual([]);
    });
});

describe('the address-holder lookup', () => {
    it('finds the interface carrying a bare address', () => {
        expect(findInterfaceHoldingAddress('192.0.2.72', ctx.interfaces)).toMatchObject({ name: 'br-ex', type: 'ovs-interface' });
    });

    it('is undefined for an unheld or missing address', () => {
        expect(findInterfaceHoldingAddress('203.0.113.1', ctx.interfaces)).toBeUndefined();
        expect(findInterfaceHoldingAddress(undefined, ctx.interfaces)).toBeUndefined();
    });
});

describe('the drawer explains the tunnel', () => {
    const factsFor = (item: Interface): Fact[] => {
        const node = buildNodeViewModel(item, descriptorFor('vxlan')!, ctx);
        return nodeKindRegistry['interface' as NodeKind].facts!(node, ctx);
    };
    const texts = (fact: Fact) => (fact.value as { text: string }[]).map((v) => v.text);

    it('lists the VTEP address, port, learning and the per-VLAN VNI', () => {
        const fact = factsFor(vxlan).find((f) => f.label === 'VXLAN')!;
        expect(fact.provenance).toBe('observed');
        expect(texts(fact)).toEqual([
            'VNI: per-VLAN on the bridge (id 0)',
            'Local VTEP: 192.0.2.72',
            'UDP port: 4789',
            'MAC learning: off'
        ]);
    });

    it('names a per-device VNI when one is set', () => {
        const fact = factsFor({ ...vxlan, vxlan: { id: 10010, local: '192.0.2.72' } }).find((f) => f.label === 'VXLAN')!;
        expect(texts(fact)).toEqual(['VNI: 10010', 'Local VTEP: 192.0.2.72']);
    });
});
