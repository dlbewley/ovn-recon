import fs from 'fs';
import path from 'path';

import { buildTopologyEdges } from '../components/nodeVisualizationModel';
import { buildGraphContext } from './context';
import { opaqueNodeIds } from './descriptors';
import { buildFlowGraph, flowPath } from './flowPath';
import { edgeKey } from './ids';
import { ClusterUserDefinedNetwork, NodeNetworkState } from '../types';

const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

/**
 * The highlight used to walk through br-int (ovn-recon-2h2). Selecting br-vmdata
 * ran br-vmdata -> br-int over the patch cable, then br-int -> VRF over the
 * management port, and lit the VRFs as if they egressed via br-vmdata. They egress
 * via br-ex, which the VRF's own route table says.
 *
 * The fixture is the real node the report came from: two provider bridges both
 * patched to br-int, one VRF whose management port is on br-int and whose table
 * routes 0.0.0.0/0 via br-ex.
 */
describe('flowPath', () => {
    const ctx = buildGraphContext({
        nns: fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json'),
        cudns: fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json')
    });
    const { edges } = buildTopologyEdges(ctx, { showHiddenColumns: false, showNads: false, showLldp: false });
    const graph = buildFlowGraph(edges);
    const opaque = opaqueNodeIds(ctx);
    const light = (id: string) => flowPath(graph, id, opaque);

    it('marks the integration bridge, and only it, opaque', () => {
        expect(Array.from(opaque)).toEqual(['intbr:br-int']);
    });

    it('does not reach the VRF from a provider bridge it does not egress through', () => {
        const lit = light('iface:br-vmdata');
        expect(lit.has('iface:ens224')).toBe(true);
        expect(lit.has('intbr:br-int')).toBe(true);
        expect(lit.has('ovn:physnet-vmdata')).toBe(true);
        expect(lit.has('cudn:vlan-1924')).toBe(true);
        // The path enters br-int but stops there.
        expect(lit.has('vrf:example-p-cudn')).toBe(false);
        expect(lit.has('iface:br-ex')).toBe(false);
        expect(lit.has('cudn:example-p-cudn')).toBe(false);
    });

    it('lights the VRF from the bridge its route table egresses through', () => {
        const lit = light('iface:br-ex');
        expect(lit.has('iface:ens192')).toBe(true);
        expect(lit.has('vrf:example-p-cudn')).toBe(true);
        expect(lit.has(edgeKey('iface:br-ex', 'vrf:example-p-cudn'))).toBe(true);
        expect(lit.has('cudn:example-p-cudn')).toBe(true);
        expect(lit.has('iface:br-vmdata')).toBe(false);
    });

    it('runs a VRF back to the NIC it egresses by, and into br-int no further', () => {
        const lit = light('vrf:example-p-cudn');
        expect(lit.has('iface:br-ex')).toBe(true);
        expect(lit.has('iface:ens192')).toBe(true);
        expect(lit.has('intbr:br-int')).toBe(true);
        // br-int's other patch cable is not the VRF's path.
        expect(lit.has('iface:br-vmdata')).toBe(false);
        expect(lit.has('iface:ens224')).toBe(false);
    });

    it('lights every neighbour when br-int itself is selected', () => {
        // Opaque to a walk passing through, not to its own selection.
        const lit = light('intbr:br-int');
        expect(lit.has('iface:br-ex')).toBe(true);
        expect(lit.has('iface:br-vmdata')).toBe(true);
        expect(lit.has('vrf:example-p-cudn')).toBe(true);
    });

    it('still walks through an ordinary bridge', () => {
        const lit = light('iface:ens224');
        expect(lit.has('iface:br-vmdata')).toBe(true);
        expect(lit.has('cudn:vlan-1926')).toBe(true);
    });

    it('walks everything when nothing is opaque', () => {
        // The old behaviour, kept as a statement of what the flag changes.
        const lit = flowPath(graph, 'iface:br-vmdata');
        expect(lit.has('vrf:example-p-cudn')).toBe(true);
    });
});
