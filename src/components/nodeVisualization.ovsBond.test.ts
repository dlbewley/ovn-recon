import fs from 'fs';
import path from 'path';

import { buildGraphContext, GraphContext } from '../topology/context';
import { descriptorFor, opaqueNodeIds } from '../topology/descriptors';
import { buildFlowGraph, flowPath } from '../topology/flowPath';
import { edgeKey, parseNodeId } from '../topology/ids';
import { layoutLanes, LaneViewState } from '../topology/lanes';
import { nodeKindRegistry } from '../topology/registry';
import { Fact, FactItem } from '../topology/types';
import { buildNodeViewModel } from '../topology/viewModel';
import { buildTopologyEdges, TopologyEdge } from './nodeVisualizationModel';
import { readSelectParam, withSelectParam } from './useSelectParam';
import {
    describeBond, describeOvsBond, formatOvsBondMembers, getBondMembers, getOvsBonds, OvsBond
} from './nodeVisualizationSelectors';
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

});

/**
 * The bond drawn as a node (ovn-recon-1tw.2), between its members and its bridge.
 *
 * Before it, ens161 and ens256 each drew a controller edge straight to br-vmdata: two
 * independent uplinks on a bridge with STP off, the picture of a switching loop, where
 * the policy configures one bonded uplink.
 */
describe('the ovs-bond node', () => {
    const DEFAULT_VIEW: LaneViewState = { showHiddenColumns: false, showNads: false, showLldp: false };
    const BOND1 = 'ovs-bond:br-vmdata/bond1';
    const ctxOf = (source: NodeNetworkState): GraphContext => buildGraphContext({ nns: source });
    const nnsWith = (list: unknown[]): NodeNetworkState =>
        ({ metadata: { name: 'worker-1' }, status: { currentState: { interfaces: list } } } as unknown as NodeNetworkState);
    const edgesOf = (local: GraphContext): TopologyEdge[] => buildTopologyEdges(local, DEFAULT_VIEW).edges;
    const touching = (edges: TopologyEdge[], id: string) =>
        edges.filter((edge) => edge.source === id || edge.target === id).map((edge) => `${edge.source} -> ${edge.target}`);
    const ctx = ctxOf(nns);
    const edges = edgesOf(ctx);
    const descriptor = descriptorFor('ovs-bond')!;
    const bond1 = ctx.ovsBonds[0];

    it('is keyed by its bridge, so it parses back and survives ?select= unencoded', () => {
        expect(descriptor.id(bond1, ctx)).toBe(BOND1);
        expect(parseNodeId(BOND1)).toEqual({ kind: 'ovs-bond', key: 'br-vmdata/bond1' });
        const search = withSelectParam('?keep=1', BOND1);
        expect(search).toBe('?keep=1&select=ovs-bond:br-vmdata/bond1');
        expect(readSelectParam(search)).toBe(BOND1);
    });

    it('is drawn in the Bonds lane with the kernel bond0, below it', () => {
        const layout = layoutLanes(
            ctx, DEFAULT_VIEW, { padding: 20, itemHeight: 80, itemGap: 20, colSpacing: 220 }, {}, () => null, edges);
        const lane = layout.lanes.find(({ lane: candidate }) => candidate.id === 'bond')!;
        const ids = lane.groups.flatMap((group) => group.nodes.map((node) => node.id));
        expect(ids).toEqual(['iface:bond0', BOND1]);
        expect(layout.positions[BOND1].x).toBe(layout.positions['iface:bond0'].x);
        // Members to its left, its bridge to its right, as bond0 sits between ens192 and br-ex.
        expect(layout.positions['iface:ens161'].x).toBeLessThan(layout.positions[BOND1].x);
        expect(layout.positions['iface:br-vmdata'].x).toBeGreaterThan(layout.positions[BOND1].x);
    });

    it('presents as an ovs-bond with its mode, in the bridges\' purple, and not as synthetic', () => {
        expect(descriptor.lane).toBe('bond');
        expect(descriptor.color).toBe(descriptorFor('bridge')!.color);
        expect(descriptor.color).not.toBe(descriptorFor('bond')!.color);
        expect(descriptor.legend).toEqual({
            label: 'OVS bond', description: 'A port of an OVS bridge that aggregates NICs. No kernel device.'
        });
        expect(descriptor.present(bond1, ctx)).toEqual({ label: 'bond1', subtitle: 'ovs-bond', state: 'balance-slb' });
        expect(descriptor.status!(bond1, ctx)).toBe('up');
        const node = buildNodeViewModel(bond1, descriptor, ctx);
        expect(node).toMatchObject({ id: BOND1, kind: 'ovs-bond', label: 'bond1', subtitle: 'ovs-bond' });
        expect(node.isSynthetic).toBeUndefined();
        // The Config tab shows what NNS reports: the bridge.port entry.
        expect(node.raw).toEqual({
            name: 'bond1',
            'link-aggregation': { mode: 'balance-slb', port: [{ name: 'ens161' }, { name: 'ens256' }] }
        });
    });

    it('joins each member to the bond and the bond to the bridge, and no member to the bridge', () => {
        expect(touching(edges, 'iface:ens161')).toEqual([`iface:ens161 -> ${BOND1}`]);
        expect(touching(edges, 'iface:ens256')).toEqual([`iface:ens256 -> ${BOND1}`]);
        expect(touching(edges, BOND1)).toEqual([
            `iface:ens161 -> ${BOND1}`, `iface:ens256 -> ${BOND1}`, `${BOND1} -> iface:br-vmdata`
        ]);
        // br-vmdata's other port is its internal port, ovs-br1; neither NIC reaches it directly.
        expect(edges.filter((edge) => edge.target === 'iface:br-vmdata').map((edge) => edge.source))
            .toEqual([BOND1, 'iface:ovs-br1']);
    });

    it('says why, citing the bridge.port entry and the member\'s own controller', () => {
        const member = edges.find((edge) => edge.source === 'iface:ens161')!;
        expect(member).toMatchObject({ kind: 'membership', provenance: 'observed', rule: 'ovs-bond-member' });
        expect(member.rationale).toBe('ens161 is a member of OVS bond bond1: br-vmdata\'s bridge.port entry bond1 '
            + 'lists it in link-aggregation.port, and ens161 reports controller: br-vmdata.');
        const port = edges.find((edge) => edge.source === BOND1)!;
        expect(port).toMatchObject({ kind: 'membership', provenance: 'observed', rule: 'ovs-bond-port' });
        expect(port.rationale).toBe('bond1 is a port of br-vmdata: br-vmdata\'s bridge.port lists it with link-aggregation.');
    });

    it('leaves the kernel bond0 -> bond0.1926 -> br-ex chain as it was', () => {
        expect(touching(edges, 'iface:bond0')).toEqual([
            'iface:ens192 -> iface:bond0', 'iface:ens224 -> iface:bond0', 'iface:bond0 -> iface:bond0.1926'
        ]);
        expect(edges.find((edge) => edge.source === 'iface:bond0.1926')).toMatchObject({
            target: 'iface:br-ex', rule: 'controller', kind: 'membership'
        });
    });

    it('lights ens161 -> bond1 -> br-vmdata -> physnet-vmdata from ens161, with no special case', () => {
        const lit = flowPath(buildFlowGraph(edges), 'iface:ens161', opaqueNodeIds(ctx));
        ['iface:ens161', BOND1, 'iface:br-vmdata', 'ovn:physnet-vmdata'].forEach((id) => expect(lit.has(id)).toBe(true));
        [
            edgeKey('iface:ens161', BOND1), edgeKey(BOND1, 'iface:br-vmdata'), edgeKey('iface:br-vmdata', 'ovn:physnet-vmdata')
        ].forEach((key) => expect(lit.has(key)).toBe(true));
        // The other member is a sibling, not on ens161's path; br-ex's side is elsewhere.
        expect(lit.has('iface:ens256')).toBe(false);
        expect(lit.has('iface:br-ex')).toBe(false);
    });

    const vmdata = (members: string[], extra: unknown[] = [], bondName = 'bond1') => [
        {
            name: 'br-vmdata',
            type: 'ovs-bridge',
            state: 'up',
            bridge: {
                port: [{ name: bondName, 'link-aggregation': { mode: 'balance-slb', port: members.map((name) => ({ name })) } }]
            }
        },
        ...extra
    ];
    const ethernet = (name: string, state: string, controller?: string) =>
        ({ name, type: 'ethernet', state, ...(controller ? { controller } : {}) });

    it('draws no edge for a member NNS does not list, and calls the bond up with the count', () => {
        const source = nnsWith(vmdata(['ens161', 'ens256'], [ethernet('ens161', 'up', 'br-vmdata')]));
        const local = ctxOf(source);
        const bond = local.ovsBonds[0];
        const localEdges = edgesOf(local);
        expect(touching(localEdges, BOND1)).toEqual([`iface:ens161 -> ${BOND1}`, `${BOND1} -> iface:br-vmdata`]);
        expect(buildTopologyEdges(local, DEFAULT_VIEW).unresolved).toEqual([]);
        expect(descriptor.present(bond, local).state).toBe('balance-slb · 1/2 up');
        expect(descriptor.status!(bond, local)).toBe('up');
    });

    it('is down when every member is down or missing, and unknown when nmstate manages none', () => {
        const down = ctxOf(nnsWith(vmdata(['ens161', 'ens256'], [ethernet('ens161', 'down', 'br-vmdata')])));
        expect(descriptor.status!(down.ovsBonds[0], down)).toBe('down');
        expect(descriptor.present(down.ovsBonds[0], down).state).toBe('balance-slb · 0/2 up');
        const ignored = ctxOf(nnsWith(vmdata(['ens161'], [ethernet('ens161', 'ignore', 'br-vmdata')])));
        expect(descriptor.status!(ignored.ovsBonds[0], ignored)).toBe('unknown');
        const empty = ctxOf(nnsWith(vmdata([])));
        expect(descriptor.status!(empty.ovsBonds[0], empty)).toBe('unknown');
    });

    it('draws two OVS bonds on two bridges apart', () => {
        const source = nnsWith([
            ...vmdata(['ens161'], [ethernet('ens161', 'up', 'br-vmdata')]),
            {
                name: 'br-storage',
                type: 'ovs-bridge',
                state: 'up',
                bridge: { port: [{ name: 'bond1', 'link-aggregation': { mode: 'active-backup', port: [{ name: 'ens300' }] } }] }
            },
            ethernet('ens300', 'up', 'br-storage')
        ]);
        const local = ctxOf(source);
        const localEdges = edgesOf(local);
        expect(local.ovsBonds.map((bond) => descriptor.id(bond, local))).toEqual([BOND1, 'ovs-bond:br-storage/bond1']);
        expect(touching(localEdges, 'ovs-bond:br-storage/bond1')).toEqual([
            'iface:ens300 -> ovs-bond:br-storage/bond1', 'ovs-bond:br-storage/bond1 -> iface:br-storage'
        ]);
        expect(touching(localEdges, 'iface:ens300')).toEqual(['iface:ens300 -> ovs-bond:br-storage/bond1']);
    });

    it('gives a kernel bond and an OVS bond of one name a node each', () => {
        const source = nnsWith([
            ...vmdata(['ens161'], [ethernet('ens161', 'up', 'br-vmdata')], 'bond0'),
            { name: 'bond0', type: 'bond', state: 'up', 'link-aggregation': { mode: 'active-backup', port: ['ens192'] } },
            ethernet('ens192', 'up', 'bond0')
        ]);
        const local = ctxOf(source);
        const layout = layoutLanes(local, DEFAULT_VIEW, { padding: 20, itemHeight: 80, itemGap: 20, colSpacing: 220 },
            {}, () => null, edgesOf(local));
        const ids = layout.lanes.find(({ lane }) => lane.id === 'bond')!.groups.flatMap((g) => g.nodes.map((n) => n.id));
        expect(ids).toEqual(['iface:bond0', 'ovs-bond:br-vmdata/bond0']);
        expect(touching(edgesOf(local), 'iface:bond0')).toEqual(['iface:ens192 -> iface:bond0']);
    });

    it('keeps a controller edge to an OVS bridge for a port that is in no bond', () => {
        const source = nnsWith(vmdata(['ens161'], [ethernet('ens161', 'up', 'br-vmdata'), ethernet('ens999', 'up', 'br-vmdata')]));
        expect(touching(edgesOf(ctxOf(source)), 'iface:ens999')).toEqual(['iface:ens999 -> iface:br-vmdata']);
    });
});

describe('the ovs-bond drawer', () => {
    const ctx = buildGraphContext({ nns });
    const descriptor = descriptorFor('ovs-bond')!;
    const factsOf = (local: GraphContext) => {
        const node = buildNodeViewModel(local.ovsBonds[0], descriptor, local);
        return nodeKindRegistry[node.kind].facts!(node, local);
    };
    const byLabel = (facts: Fact[], label: string) => facts.find((fact) => fact.label === label)!;
    const items = (fact: Fact) => fact.value as FactItem[];

    it('reads Type, Bridge, Bond, Members and where the runtime state is', () => {
        const facts = factsOf(ctx);
        // No enactments on this capture, so no Configured By either way.
        expect(facts.map((fact) => fact.label)).toEqual(['Type', 'Bridge', 'Bond', 'Members', 'Runtime State']);
        expect(items(byLabel(facts, 'Type'))).toEqual([
            { text: 'ovs-bond', href: '/api-resource/cluster/nmstate.io~v1beta1~NodeNetworkState/' }
        ]);
        expect(byLabel(facts, 'Type').hint).toContain('It has no kernel device');
        expect(items(byLabel(facts, 'Bridge'))).toEqual([{ text: 'br-vmdata', node: 'iface:br-vmdata' }]);
        expect(items(byLabel(facts, 'Bond')).map((item) => item.text)).toEqual([
            'Mode: balance-slb (source MAC and VLAN hashing, rebalanced periodically; no LACP, and the switch '
                + 'ports must not be a port-channel or static LAG)'
        ]);
        expect(items(byLabel(facts, 'Members'))).toEqual([
            { text: 'ens161', node: 'iface:ens161', detail: 'up · 10 Gb/s · MTU 1500' },
            { text: 'ens256', node: 'iface:ens256', detail: 'up · 10 Gb/s · MTU 1500' }
        ]);
        const runtime = byLabel(facts, 'Runtime State');
        expect(runtime.value).toBe('ovs-appctl bond/show bond1');
        expect(runtime.hint).toContain('ip link does not show bond1');
        expect(runtime.hint).toContain('on worker-1');
        facts.forEach((fact) => expect(fact.provenance).toBe('observed'));
    });

    it('lists a member NNS does not report, unlinked, and the delays when set', () => {
        const local = buildGraphContext({
            nns: {
                metadata: { name: 'worker-1' },
                status: {
                    currentState: {
                        interfaces: [
                            {
                                name: 'br-vmdata', type: 'ovs-bridge', state: 'up', bridge: {
                                    port: [{
                                        name: 'bond1', 'link-aggregation': {
                                            mode: 'active-backup', port: [{ name: 'ens161' }, { name: 'ens256' }],
                                            'bond-updelay': 100, 'bond-downdelay': 50
                                        }
                                    }]
                                }
                            },
                            { name: 'ens161', type: 'ethernet', state: 'down', controller: 'br-vmdata', mtu: 9000 }
                        ]
                    }
                }
            } as unknown as NodeNetworkState
        });
        const facts = factsOf(local);
        expect(items(byLabel(facts, 'Members'))).toEqual([
            { text: 'ens161', node: 'iface:ens161', detail: 'down · MTU 9000' },
            { text: 'ens256', detail: '(not reported by NodeNetworkState)' }
        ]);
        expect(items(byLabel(facts, 'Bond')).map((item) => item.text).slice(1)).toEqual(['Up delay: 100 ms', 'Down delay: 50 ms']);
    });

    it('names the policy that configures its bridge', () => {
        const local = buildGraphContext({
            nns,
            enactments: [{
                metadata: { name: 'worker-1.br-vmdata' },
                status: {
                    policyGeneration: 1,
                    conditions: [{ type: 'Available', status: 'True' }],
                    desiredState: { interfaces: [{ name: 'br-vmdata', type: 'ovs-bridge' }] }
                }
            }] as never
        });
        const configured = byLabel(factsOf(local), 'Configured By');
        expect((configured.value as FactItem[])[0]).toMatchObject({ text: 'br-vmdata' });
        expect(configured.hint).toBe('The policy configures br-vmdata, whose bridge.port declares bond1: this node\'s '
            + 'enactment for it lists br-vmdata in the applied desiredState.');
    });
});

/**
 * The drawer lines for an OVS bond (ovn-recon-1tw.3), the one source the bridge's,
 * the members' and the bond's own drawers share.
 */
describe('describing an OVS bond', () => {
    const bond = (mode: string | undefined, members: OvsBond['members'], extra: Partial<OvsBond> = {}): OvsBond => ({
        bridge: 'br-vmdata', name: 'bond1', mode, members, raw: { name: 'bond1' }, ...extra
    });
    const both = [{ name: 'ens161', present: true }, { name: 'ens256', present: true }];

    it('reads the captured balance-slb bond with its gloss and members', () => {
        expect(describeOvsBond(getOvsBonds(interfaces)[0])).toEqual([
            'Mode: balance-slb (source MAC and VLAN hashing, rebalanced periodically; no LACP, and the switch '
                + 'ports must not be a port-channel or static LAG)',
            'Members: ens161, ens256'
        ]);
    });

    it('glosses balance-tcp as needing LACP, and active-backup as needing no LAG', () => {
        expect(describeOvsBond(bond('balance-tcp', both))[0])
            .toBe('Mode: balance-tcp (L2 to L4 hashing; needs LACP on both the bond and the switch ports)');
        expect(describeOvsBond(bond('active-backup', both))[0]).toBe('Mode: active-backup (one member carries all '
            + 'traffic, another takes over when it fails; no LACP or switch-side LAG)');
    });

    it('leaves the kernel glosses alone: a kernel active-backup bond is not glossed as OVS', () => {
        const kernel: Interface = {
            name: 'bond0', type: 'bond', state: 'up', 'link-aggregation': { mode: 'active-backup', port: ['eno3'] }
        } as Interface;
        expect(describeBond(kernel)[0]).toBe('Mode: active-backup');
    });

    it('marks a member NNS does not list, and states the delays when reported', () => {
        const degraded = bond('balance-slb', [{ name: 'ens161', present: true }, { name: 'ens256', present: false }],
            { updelay: 100, downdelay: 50 });
        expect(formatOvsBondMembers(degraded)).toBe('ens161, ens256 (not in NNS)');
        expect(describeOvsBond(degraded).slice(1)).toEqual([
            'Members: ens161, ens256 (not in NNS)',
            'Up delay: 100 ms',
            'Down delay: 50 ms'
        ]);
    });

    it('says what it can of a bond with no mode, an unknown mode or no members', () => {
        expect(describeOvsBond(bond(undefined, []))).toEqual(['Members: none reported']);
        expect(describeOvsBond(bond('some-future-mode', both))[0]).toBe('Mode: some-future-mode');
    });
});
