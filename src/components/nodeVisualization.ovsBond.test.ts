import fs from 'fs';
import path from 'path';

import { buildGraphContext, GraphContext } from '../topology/context';
import { layoutLanes, LaneViewState } from '../topology/lanes';
import { buildTopologyEdges } from './nodeVisualizationModel';
import { getBondMembers, getOvsBonds } from './nodeVisualizationSelectors';
import { Interface, NodeNetworkState } from '../types';

/**
 * Bonds that live inside an OVS bridge (ovn-recon-1tw.1).
 *
 * An NNCP can aggregate NICs in an OVS bridge rather than with a kernel bond. nmstate
 * then reports the bond only as an entry in the bridge's bridge.port list, with its
 * link-aggregation; there is no interface by the bond's name, and its members say
 * nothing but `controller: <bridge>`. getOvsBonds reads them out once, into
 * GraphContext, for the graph, drawers and findings to share.
 */
const nns: NodeNetworkState = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), 'test', 'fixtures', 'nns', 'ovs-bond-slb.json'), 'utf-8'));
const interfaces: Interface[] = nns.status!.currentState!.interfaces;

const ovsBridge = (name: string, port: unknown[]): Interface => ({
    name, type: 'ovs-bridge', state: 'up', bridge: { port: port as never }
});
const nic = (name: string, controller: string): Interface => ({
    name, type: 'ethernet', state: 'up', controller
});

describe('reading OVS bonds out of bridge.port', () => {
    it('finds bond1 on br-vmdata: balance-slb over ens161 and ens256', () => {
        const bonds = getOvsBonds(interfaces);

        expect(bonds).toHaveLength(1);
        expect(bonds[0]).toMatchObject({
            bridge: 'br-vmdata',
            name: 'bond1',
            mode: 'balance-slb',
            members: [{ name: 'ens161', present: true }, { name: 'ens256', present: true }]
        });
        // The capture reports no delays; absent is not zero.
        expect(bonds[0].updelay).toBeUndefined();
        expect(bonds[0].downdelay).toBeUndefined();
        expect(bonds[0].raw.name).toBe('bond1');
    });

    it('is reported nowhere else: no interface is named bond1', () => {
        expect(interfaces.some((iface) => iface.name === 'bond1')).toBe(false);
    });

    it('does not return the kernel bond, which getBondMembers still reads', () => {
        expect(getOvsBonds(interfaces).map((bond) => bond.name)).not.toContain('bond0');
        expect(getBondMembers(interfaces.find((iface) => iface.name === 'bond0'))).toEqual(['ens192', 'ens224']);
    });

    it('yields nothing for bridge ports without link-aggregation', () => {
        expect(getOvsBonds([
            ovsBridge('br-ex', [{ name: 'eno1' }, { name: 'br-ex' }, 'patch-br-ex-to-br-int']),
            nic('eno1', 'br-ex')
        ])).toEqual([]);
    });

    it('keeps a member NNS does not list, marked absent', () => {
        const bonds = getOvsBonds([
            ovsBridge('br-data', [{
                name: 'bond-data',
                'link-aggregation': { mode: 'active-backup', port: [{ name: 'eno3' }, { name: 'eno4' }] }
            }]),
            nic('eno3', 'br-data')
        ]);

        expect(bonds[0].members).toEqual([
            { name: 'eno3', present: true },
            { name: 'eno4', present: false }
        ]);
    });

    it('reads members given as strings, the delays, and a bridge listing its ports under ports', () => {
        const bonds = getOvsBonds([{
            name: 'br-data',
            type: 'ovs-bridge',
            state: 'up',
            bridge: {
                ports: [{
                    name: 'bond-data',
                    'link-aggregation': {
                        mode: 'balance-tcp', port: ['eno3', { name: 'eno4' }], 'bond-updelay': 100, 'bond-downdelay': 50
                    }
                }]
            }
        }]);

        expect(bonds).toEqual([expect.objectContaining({
            bridge: 'br-data',
            name: 'bond-data',
            mode: 'balance-tcp',
            members: [{ name: 'eno3', present: false }, { name: 'eno4', present: false }],
            updelay: 100,
            downdelay: 50
        })]);
    });

    it('tolerates a link-aggregation with nothing in it, and a linux-bridge port list', () => {
        const bonds = getOvsBonds([
            ovsBridge('br-data', [{ name: 'bond-data', 'link-aggregation': {} }]),
            {
                name: 'br-linux',
                type: 'linux-bridge',
                state: 'up',
                bridge: { port: [{ name: 'bond-x', 'link-aggregation': { mode: 'balance-slb' } }] }
            }
        ]);

        expect(bonds).toEqual([{
            bridge: 'br-data', name: 'bond-data', mode: undefined, members: [],
            updelay: undefined, downdelay: undefined, raw: { name: 'bond-data', 'link-aggregation': {} }
        }]);
    });
});

describe('the OVS bonds in the graph context', () => {
    const ctx: GraphContext = buildGraphContext({ nns });

    it('exposes the list once, as ovsBonds', () => {
        expect(ctx.ovsBonds).toEqual(getOvsBonds(interfaces));
        expect(ctx.ovsBonds.map((bond) => `${bond.bridge}/${bond.name}`)).toEqual(['br-vmdata/bond1']);
    });

    it('is empty for a node with no OVS bonds', () => {
        const plain = buildGraphContext({
            nns: { status: { currentState: { interfaces: [nic('eno1', 'br-ex')] } } } as NodeNetworkState
        });
        expect(plain.ovsBonds).toEqual([]);
    });

    it('loads into the physical graph pipeline without throwing', () => {
        // A smoke test only: how the bond is drawn is ovn-recon-1tw.2.
        const view: LaneViewState = { showHiddenColumns: true, showNads: false, showLldp: false };
        const { edges } = buildTopologyEdges(ctx, view);
        const layout = layoutLanes(
            ctx, view, { padding: 20, itemHeight: 80, itemGap: 20, colSpacing: 220 }, {}, () => null, edges);

        expect(edges.length).toBeGreaterThan(0);
        expect(Object.keys(layout.positions).length).toBeGreaterThan(0);
    });
});
