import fs from 'fs';
import path from 'path';

import { classify } from '../topology/classify';
import { buildGraphContext, GraphContext } from '../topology/context';
import { descriptorFor, iconFor } from '../topology/descriptors';
import { laneOrderingInput, layoutLanes, LaneViewState } from '../topology/lanes';
import { nodeKindRegistry } from '../topology/registry';
import { Fact, FactItem } from '../topology/types';
import { buildNodeViewModel } from '../topology/viewModel';
import { buildTopologyEdges, TopologyEdge } from './nodeVisualizationModel';
import { describeSriovVfSettings, findSriovParent, getSriovVfs } from './nodeVisualizationSelectors';
import { Interface, NodeNetworkState, SriovVf } from '../types';

/**
 * SR-IOV virtual functions (ovn-recon-s3t.63).
 *
 * A VF is `ethernet` to nmstate, so until now every VF on the host drew as a NIC of its
 * own with no tie to the PF it was carved from. The PF's `ethernet.sr-iov.vfs` names
 * each VF that is a host interface, which is what the role, the lane, the edge and both
 * drawers are built on. A VF the PF lists without a name has gone into a pod or to a
 * userspace driver, and the PF drawer says so.
 */
const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

const VIEW: LaneViewState = { showHiddenColumns: false, showNads: false, showLldp: false };
const METRICS = { padding: 20, itemHeight: 80, itemGap: 20, colSpacing: 220 };

const nns = fixture<NodeNetworkState>('nns', 'sriov.json');
const ctx: GraphContext = buildGraphContext({ nns });
const byName = (name: string): Interface => ctx.interfaces.find((i) => i.name === name)!;

const factsFor = (iface: Interface): Fact[] => {
    const type = classify(iface, ctx).role === 'sriov-vf' ? 'sriov-vf' : 'physical';
    const node = buildNodeViewModel(iface, descriptorFor(type)!, ctx);
    return nodeKindRegistry.interface.facts!(node, ctx);
};
const find = (facts: Fact[], label: string): Fact | undefined => facts.find((f) => f.label === label);
const texts = (fact: Fact | undefined): string[] => (fact?.value as FactItem[]).map((v) => v.text);

const edgeByRule = (edges: TopologyEdge[], rule: string, target?: string): TopologyEdge | undefined =>
    edges.find((e) => e.rule === rule && (target === undefined || e.target === target));

describe('sriov fixture: sanitisation', () => {
    const raw = fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'nns', 'sriov.json'), 'utf-8');

    it('carries no identifying values from the source cluster', () => {
        expect(raw).not.toMatch(/snok/i);                  // the node's name
        expect(raw).not.toMatch(/192\.168\.50\./);         // site addressing
        expect(raw).not.toMatch(/98:03:9B|D0:50:99/i);     // vendor OUIs
        expect(raw).not.toMatch(/managedFields|resourceVersion/);
    });

    it('keeps the relationships anonymisation could have broken', () => {
        const bond0 = byName('bond0');
        // Both Mellanox PFs are 802.3ad members and wear the bond's MAC; the second one
        // remembers its own under permanent-mac-address.
        expect(byName('enp194s0f0np0')['mac-address']).toBe(bond0['mac-address']);
        expect(byName('enp194s0f1np1')['mac-address']).toBe(bond0['mac-address']);
        expect(byName('enp194s0f1np1')['permanent-mac-address']).not.toBe(bond0['mac-address']);
        // Each VF on the host carries the MAC its PF assigned it.
        getSriovVfs(byName('enp65s0f1'))
            .filter((vf) => vf['iface-name'])
            .forEach((vf) => expect(byName(vf['iface-name']!)['mac-address']).toBe(vf['mac-address']));
    });

    it('has the three SR-IOV shapes the feature is built against', () => {
        // Partly in use: three VFs, one on the host, two gone elsewhere.
        expect(getSriovVfs(byName('enp194s0f0np0')).map((vf) => vf['iface-name'])).toEqual([undefined, undefined, 'enp1s0f0v2']);
        // Fully carved: seven of seven, three on the host.
        expect(getSriovVfs(byName('enp65s0f1')).filter((vf) => vf['iface-name'])).toHaveLength(3);
        // Capable but unused.
        expect(byName('enp65s0f0').ethernet?.['sr-iov']?.['total-vfs']).toBe(0);
    });
});

describe('a VF is classified by its PF naming it', () => {
    it('resolves each VF on the host to its PF and id, whatever the names look like', () => {
        expect(findSriovParent('enp1s0f0v2', ctx.interfaces)).toMatchObject({ pf: { name: 'enp194s0f0np0' }, vf: { id: 2 } });
        expect(findSriovParent('enp66s0f1v5', ctx.interfaces)).toMatchObject({ pf: { name: 'enp65s0f1' }, vf: { id: 5 } });
        expect(findSriovParent('enp194s0f0np0', ctx.interfaces)).toBeUndefined();
    });

    it('gives VFs their own role and leaves the PFs physical', () => {
        ['enp1s0f0v2', 'enp1s0f1v2', 'enp66s0f1v4', 'enp66s0f1v5', 'enp66s0f1v6'].forEach((name) => {
            expect(classify(byName(name), ctx)).toMatchObject({ role: 'sriov-vf' });
        });
        ['enp194s0f0np0', 'enp194s0f1np1', 'enp65s0f0', 'enp65s0f1'].forEach((name) => {
            expect(classify(byName(name), ctx).role).toBe('physical');
        });
        expect(classify(byName('enp1s0f0v2'), ctx).reason).toContain('ethernet.sr-iov.vfs');
    });

    it('still hides a VF that nmstate ignores', () => {
        const ignored = { ...byName('enp1s0f0v2'), state: 'ignore' };
        expect(classify(ignored, ctx).role).toBe('unmanaged');
    });
});

describe('a VF has a lane of its own, beside the NICs', () => {
    it('draws in the Virtual Functions lane with its own icon and colour', () => {
        const laid = layoutLanes(ctx, VIEW, METRICS, {}, () => null);
        const ids = laid.lanes.find(({ lane }) => lane.id === 'vf')!.groups.flatMap((g) => g.nodes.map((n) => n.id));
        expect(ids.sort()).toEqual(['iface:enp1s0f0v2', 'iface:enp1s0f1v2', 'iface:enp66s0f1v4', 'iface:enp66s0f1v5', 'iface:enp66s0f1v6']);
        const ethIds = laid.lanes.find(({ lane }) => lane.id === 'eth')!.groups.flatMap((g) => g.nodes.map((n) => n.id));
        expect(ethIds).not.toContain('iface:enp1s0f0v2');

        const vf = descriptorFor('sriov-vf')!;
        expect(vf.color).not.toBe(descriptorFor('physical')!.color);
        expect(iconFor(vf, byName('enp1s0f0v2'))).toBe(vf.icon);
        expect(iconFor(descriptorFor('physical')!, byName('enp194s0f0np0'))).not.toBe(vf.icon);
    });

    it('says what it is on the canvas and in the drawer header', () => {
        const node = buildNodeViewModel(byName('enp1s0f0v2'), descriptorFor('sriov-vf')!, ctx);
        expect(node.subtitle).toBe('ethernet (SR-IOV VF)');
        expect(node.graphDisplayLabel).toBe('VF');
    });

    it('is absent from a node with no VFs, like every other empty lane', () => {
        const plain = buildGraphContext({ nns: fixture<NodeNetworkState>('nns', 'basic-host.json') });
        const laid = layoutLanes(plain, VIEW, METRICS, {}, () => null);
        expect(laid.lanes.map(({ lane }) => lane.id)).not.toContain('vf');
        // The ordering pass still knows the lane, so a VF would have a place in it.
        expect(laneOrderingInput(ctx, VIEW).lanes.find((l) => l.id === 'vf')?.nodeIds).toContain('iface:enp1s0f0v2');
    });
});

describe('a VF is linked to its PF', () => {
    const { edges, unresolved } = buildTopologyEdges(ctx, VIEW);

    it('by an observed layering edge whose rationale names the field', () => {
        const edge = edgeByRule(edges, 'sriov-pf', 'iface:enp1s0f0v2');
        expect(edge).toMatchObject({
            source: 'iface:enp194s0f0np0',
            target: 'iface:enp1s0f0v2',
            kind: 'layering',
            provenance: 'observed'
        });
        expect(edge?.rationale).toBe(
            'enp1s0f0v2 is VF 2 of enp194s0f0np0: ethernet.sr-iov.vfs[2].iface-name on enp194s0f0np0 is enp1s0f0v2.'
        );
        expect(edges.filter((e) => e.rule === 'sriov-pf')).toHaveLength(5);
        expect(unresolved.filter((u) => u.rule === 'sriov-pf')).toHaveLength(0);
    });

    it('while the PFs keep their place in the bond and the bridge', () => {
        expect(edgeByRule(edges, 'controller', 'iface:bond0')?.source).toMatch(/^iface:enp194s0f/);
        expect(edges.find((e) => e.rule === 'controller' && e.source === 'iface:enp65s0f0')?.target).toBe('iface:br-mirror');
    });
});

describe('the PF drawer', () => {
    it('counts the VFs and says where each one is', () => {
        const fact = find(factsFor(byName('enp194s0f0np0')), 'SR-IOV')!;
        expect(fact.provenance).toBe('observed');
        expect(texts(fact)).toEqual([
            '3 of 8 VFs configured',
            'VF 0: no host interface (CE:83:B1:C0:8D:2C) · trust off · spoof check off',
            'VF 1: no host interface (1A:43:E4:2C:18:99) · trust off · spoof check off',
            'VF 2: enp1s0f0v2 · trust off · spoof check off'
        ]);
        expect(fact.hint).toContain('pod');
    });

    it('shows a trusted VF among checked ones', () => {
        const items = texts(find(factsFor(byName('enp65s0f1')), 'SR-IOV'));
        expect(items[0]).toBe('7 of 7 VFs configured');
        expect(items[1]).toBe('VF 0: no host interface (02:1E:AD:27:70:AC) · trust on · spoof check off');
        expect(items[5]).toBe('VF 4: enp66s0f1v4 · trust off · spoof check on');
    });

    it('says a capable NIC has carved out nothing', () => {
        expect(texts(find(factsFor(byName('enp65s0f0')), 'SR-IOV'))).toEqual(['Capable, no VFs configured (max 7)']);
    });

    it('is silent on a NIC that reports no sr-iov', () => {
        const nic = { name: 'eno1', type: 'ethernet', state: 'up', ethernet: { speed: 1000 } };
        const facts = nodeKindRegistry.interface.facts!(
            buildNodeViewModel(nic, descriptorFor('physical')!, buildGraphContext({ nns: { status: { currentState: { interfaces: [nic] } } } as NodeNetworkState })),
            buildGraphContext({ nns: { status: { currentState: { interfaces: [nic] } } } as NodeNetworkState })
        );
        expect(find(facts, 'SR-IOV')).toBeUndefined();
        expect(find(facts, 'SR-IOV VF')).toBeUndefined();
    });
});

describe('the VF drawer', () => {
    it('names its PF and id with the settings the PF imposes', () => {
        const facts = factsFor(byName('enp66s0f1v4'));
        const fact = find(facts, 'SR-IOV VF')!;
        expect(fact.provenance).toBe('observed');
        expect(texts(fact)).toEqual(['VF 4 of enp65s0f1', 'trust off', 'spoof check on']);
        expect(fact.hint).toContain('ethernet.sr-iov.vfs[4].iface-name on enp65s0f1 is enp66s0f1v4');
        // A VF is still a NIC to the rest of the drawer.
        expect(find(facts, 'Driver')?.value).toBe('igbvf');
        expect(find(facts, 'SR-IOV')).toBeUndefined();
    });
});

describe('describeSriovVfSettings', () => {
    const vf = (extra: Partial<SriovVf>): SriovVf => ({ id: 0, ...extra });

    it('omits unset VLAN and rates, and includes them when set', () => {
        expect(describeSriovVfSettings(vf({ 'vlan-id': 0, 'min-tx-rate': 0, 'max-tx-rate': 0 }))).toEqual([]);
        expect(describeSriovVfSettings(vf({ 'vlan-id': 100, qos: 3, 'max-tx-rate': 1000 })))
            .toEqual(['VLAN 100 qos 3', 'tx rate max 1000 Mb/s']);
        expect(describeSriovVfSettings(vf({ 'min-tx-rate': 100, 'max-tx-rate': 500 }))).toEqual(['tx rate min 100 max 500 Mb/s']);
    });

    it('reads a trimmed entry without inventing flags', () => {
        expect(describeSriovVfSettings(vf({ trust: true }))).toEqual(['trust on']);
    });
});
