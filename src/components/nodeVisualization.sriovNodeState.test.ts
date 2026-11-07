import fs from 'fs';
import path from 'path';

import { buildGraphContext, GraphContext } from '../topology/context';
import { descriptorFor } from '../topology/descriptors';
import { nadNodeId } from '../topology/ids';
import { LaneViewState } from '../topology/lanes';
import { nodeKindRegistry } from '../topology/registry';
import {
    describeVfIds, findSriovPoolForVf, findSriovPoolsForResource, getSriovPfState, getSriovVfPoolsForPf,
    getSriovVfState, parseVfRange, resourceNameMatches
} from '../topology/sriovNodeState';
import { Fact, FactItem } from '../topology/types';
import { buildNodeViewModel } from '../topology/viewModel';
import { buildTopologyEdges } from './nodeVisualizationModel';
import { getSriovVfs } from './nodeVisualizationSelectors';
import { Interface, NetworkAttachmentDefinition, NodeNetworkState, SriovNetworkNodeState } from '../types';

/**
 * SriovNetworkNodeState in the graph (ovn-recon-s3t.66).
 *
 * NodeNetworkState says a PF has VFs and which are host interfaces; the operator's
 * per-node record says what the rest are for. With it, each VF names its driver and
 * pool, the PF lists its pools, an sriov NAD reaches the PF that carves its pool, and
 * a VF handed to a VM reads as vfio-pci rather than merely gone. Without it, nothing
 * here changes what the sriov tests already pin.
 */
const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;
const rawFixture = (...segments: string[]): string =>
    fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8');

const VIEW: LaneViewState = { showHiddenColumns: false, showNads: true, showLldp: false };

const nns = fixture<NodeNetworkState>('nns', 'sriov.json');
const nads = fixture<NetworkAttachmentDefinition[]>('nad', 'sriov.json');
const state = fixture<SriovNetworkNodeState>('sriovnetworknodestate', 'sriov.json');
const ctx: GraphContext = buildGraphContext({ nns, nads, sriovNodeState: state });
const bare: GraphContext = buildGraphContext({ nns, nads });
const byName = (name: string): Interface => ctx.interfaces.find((i) => i.name === name)!;

const interfaceFacts = (iface: Interface, type: 'physical' | 'sriov-vf', context = ctx): Fact[] =>
    nodeKindRegistry.interface.facts!(buildNodeViewModel(iface, descriptorFor(type)!, context), context);
const nadFacts = (nad: NetworkAttachmentDefinition, context = ctx): Fact[] =>
    nodeKindRegistry.nad.facts!(buildNodeViewModel(nad, descriptorFor('nad')!, context), context);
const find = (facts: Fact[], label: string): Fact | undefined => facts.find((f) => f.label === label);
const items = (fact: Fact | undefined): FactItem[] => fact?.value as FactItem[];
const texts = (fact: Fact | undefined): string[] => items(fact).map((v) => v.text);

describe('sriovnetworknodestate and virtualmachine fixtures: sanitisation', () => {
    it('carry no identifying values from the source cluster', () => {
        const stateRaw = rawFixture('sriovnetworknodestate', 'sriov.json');
        const vmRaw = rawFixture('virtualmachine', 'sriov.json');
        [stateRaw, vmRaw].forEach((raw) => {
            expect(raw).not.toMatch(/snok/i);
            expect(raw).not.toMatch(/98:03:9b|d0:50:99/i);
            expect(raw).not.toMatch(/managedFields|resourceVersion/);
        });
        expect(vmRaw).not.toMatch(/password|chpasswd/);
        expect(vmRaw).not.toMatch(/"serial"|"uuid": "0/);
    });

    it('keep the relationships the fixtures exist to show', () => {
        // The operator reports the same PF MACs nmstate does, in lower case.
        state.status!.interfaces!.forEach((pf) => {
            expect(pf.mac).toBe(byName(pf.name!)['mac-address']!.toLowerCase());
        });
        // Each VF on the host carries the same MAC in both records.
        expect(getSriovVfState(state, 'enp65s0f1', 4)?.mac).toBe(byName('enp66s0f1v4')['mac-address']!.toLowerCase());
        // The VM's sriov interface is VF 0 of enp65s0f1, the one the PF marks trusted.
        const vm = fixture<{ spec: { template: { spec: { domain: { devices: { interfaces: { macAddress?: string; sriov?: unknown }[] } } } } } }>('virtualmachine', 'sriov.json');
        const sriovNic = vm.spec.template.spec.domain.devices.interfaces.find((i) => i.sriov)!;
        const vf0 = getSriovVfs(byName('enp65s0f1'))[0];
        expect(sriovNic.macAddress).toBe(vf0['mac-address']!.toLowerCase());
        expect(vf0.trust).toBe(true);
        expect(getSriovVfState(state, 'enp65s0f1', 0)?.driver).toBe('vfio-pci');
    });
});

describe('reading the node state', () => {
    it('parses VF ranges and refuses what is not one', () => {
        expect(parseVfRange('0-3')).toEqual([0, 1, 2, 3]);
        expect(parseVfRange('2-2')).toEqual([2]);
        expect(parseVfRange('4')).toEqual([4]);
        expect(parseVfRange('3-1')).toEqual([]);
        expect(parseVfRange('a-b')).toEqual([]);
        expect(parseVfRange(undefined)).toEqual([]);
        expect(describeVfIds([0, 1, 2, 3])).toBe('VFs 0-3');
        expect(describeVfIds([2])).toBe('VF 2');
        expect(describeVfIds([])).toBe('no VFs');
    });

    it('carves each PF into its pools and places every VF in one', () => {
        const pools = getSriovVfPoolsForPf(state, 'enp65s0f1');
        expect(pools.map((p) => [p.group.resourceName, p.vfIds, p.group.deviceType, p.group.policyName])).toEqual([
            ['vm_igb', [0, 1, 2, 3], 'vfio-pci', 'vm-igb'],
            ['pod_igb', [4, 5, 6], 'netdevice', 'pod-igb']
        ]);
        expect(findSriovPoolForVf(state, 'enp65s0f1', 0)?.group.resourceName).toBe('vm_igb');
        expect(findSriovPoolForVf(state, 'enp65s0f1', 6)?.group.resourceName).toBe('pod_igb');
        expect(findSriovPoolForVf(state, 'enp65s0f1', 7)).toBeUndefined();
        expect(getSriovVfPoolsForPf(state, 'enp65s0f0')).toEqual([]);
        expect(getSriovVfPoolsForPf(undefined, 'enp65s0f1')).toEqual([]);
    });

    it('matches a NAD resource name to a pool with or without the prefix', () => {
        expect(resourceNameMatches('openshift.io/vm_igb', 'vm_igb')).toBe(true);
        expect(resourceNameMatches('vm_igb', 'vm_igb')).toBe(true);
        expect(resourceNameMatches('example.com/vm_igb', 'openshift.io/vm_igb')).toBe(true);
        expect(resourceNameMatches('openshift.io/vm_igb', 'pod_igb')).toBe(false);
        expect(resourceNameMatches(undefined, 'vm_igb')).toBe(false);
        expect(findSriovPoolsForResource(state, 'openshift.io/vm_igb').map((p) => p.pfName)).toEqual(['enp65s0f1']);
        expect(findSriovPoolsForResource(state, 'openshift.io/nothing')).toEqual([]);
    });

    it('reports each VF as the config daemon found it', () => {
        expect(getSriovVfState(state, 'enp65s0f1', 0)).toMatchObject({ driver: 'vfio-pci', pciAddress: '0000:42:10.1' });
        expect(getSriovVfState(state, 'enp65s0f1', 4)).toMatchObject({ driver: 'igbvf', name: 'enp66s0f1v4' });
        expect(getSriovVfState(state, 'enp65s0f0', 0)).toBeUndefined();
        expect(getSriovPfState(state, 'enp194s0f0np0')).toMatchObject({ eSwitchMode: 'legacy', totalvfs: 8 });
    });
});

describe('an sriov NAD reaches the PF that carves its pool', () => {
    const nadId = nadNodeId(nads[0]);

    it('by a declared edge whose rationale names the pool, the range and the policy', () => {
        const { edges, unresolved } = buildTopologyEdges(ctx, VIEW);
        const edge = edges.find((e) => e.rule === 'sriov-pool');
        expect(edge).toMatchObject({
            source: 'iface:enp65s0f1', target: nadId, kind: 'reference', provenance: 'declared'
        });
        expect(edge?.rationale).toBe(
            'NAD default/vm-igb attaches VFs from pool vm_igb (k8s.v1.cni.cncf.io/resourceName: openshift.io/vm_igb); '
            + 'SriovNetworkNodeState maps that pool to VFs 0-3 of enp65s0f1 as vfio-pci, per SriovNetworkNodePolicy vm-igb.'
        );
        expect(edges.filter((e) => e.rule === 'sriov-pool')).toHaveLength(1);
        expect(unresolved.filter((u) => u.rule === 'sriov-pool')).toHaveLength(0);
    });

    it('and not at all without the node state', () => {
        expect(buildTopologyEdges(bare, VIEW).edges.some((e) => e.rule === 'sriov-pool')).toBe(false);
    });
});

describe('the PF drawer with the node state', () => {
    const facts = interfaceFacts(byName('enp65s0f1'), 'physical');

    it('says what each VF is bound to and which pool it is in', () => {
        expect(texts(find(facts, 'SR-IOV'))).toEqual([
            '7 of 7 VFs configured',
            'VF 0: vfio-pci at 0000:42:10.1 · pool vm_igb · trust on · spoof check off',
            'VF 1: vfio-pci at 0000:42:10.5 · pool vm_igb · trust off · spoof check on',
            'VF 2: vfio-pci at 0000:42:11.1 · pool vm_igb · trust off · spoof check on',
            'VF 3: vfio-pci at 0000:42:11.5 · pool vm_igb · trust off · spoof check on',
            'VF 4: enp66s0f1v4 · pool pod_igb · trust off · spoof check on',
            'VF 5: enp66s0f1v5 · pool pod_igb · trust off · spoof check on',
            'VF 6: enp66s0f1v6 · pool pod_igb · trust off · spoof check on'
        ]);
        expect(find(facts, 'SR-IOV')?.hint).toContain('SriovNetworkNodeState');
    });

    it('lists its pools, each linked to the policy that asked for it', () => {
        const pools = find(facts, 'VF Pools')!;
        expect(pools.provenance).toBe('declared');
        expect(items(pools)).toEqual([
            {
                text: 'vm_igb: VFs 0-3, vfio-pci (policy vm-igb)',
                ref: { apiVersion: 'sriovnetwork.openshift.io/v1', kind: 'SriovNetworkNodePolicy', name: 'vm-igb', namespace: 'openshift-sriov-network-operator' }
            },
            {
                text: 'pod_igb: VFs 4-6, netdevice (policy pod-igb)',
                ref: { apiVersion: 'sriovnetwork.openshift.io/v1', kind: 'SriovNetworkNodePolicy', name: 'pod-igb', namespace: 'openshift-sriov-network-operator' }
            }
        ]);
    });

    it('has no pools row for a capable PF the operator left alone', () => {
        const facts = interfaceFacts(byName('enp65s0f0'), 'physical');
        expect(texts(find(facts, 'SR-IOV'))).toEqual(['Capable, no VFs configured (max 7)']);
        expect(find(facts, 'VF Pools')).toBeUndefined();
    });

    it('falls back to the MAC alone where the daemon reports no driver', () => {
        const trimmed: SriovNetworkNodeState = {
            ...state,
            status: { interfaces: [{ name: 'enp65s0f1', Vfs: [{ vfID: 0 }] }] }
        };
        const context = buildGraphContext({ nns, nads, sriovNodeState: trimmed });
        const facts = interfaceFacts(byName('enp65s0f1'), 'physical', context);
        expect(texts(find(facts, 'SR-IOV'))[1]).toBe('VF 0: no host interface (02:1E:AD:27:70:AC) · pool vm_igb · trust on · spoof check off');
    });
});

describe('the VF drawer with the node state', () => {
    it('names its pool and device type beside its PF', () => {
        const fact = find(interfaceFacts(byName('enp66s0f1v4'), 'sriov-vf'), 'SR-IOV VF')!;
        expect(items(fact)).toEqual([
            { text: 'VF 4 of enp65s0f1' },
            {
                text: 'pool pod_igb (netdevice)',
                ref: { apiVersion: 'sriovnetwork.openshift.io/v1', kind: 'SriovNetworkNodePolicy', name: 'pod-igb', namespace: 'openshift-sriov-network-operator' }
            },
            { text: 'trust off' },
            { text: 'spoof check on' }
        ]);
        expect(fact.hint).toContain('SriovNetworkNodeState');
    });
});

describe('the NAD drawer with the node state', () => {
    it('names the PF and VFs feeding its pool', () => {
        const facts = nadFacts(nads[0]);
        const pool = find(facts, 'VF Pool')!;
        expect(pool.provenance).toBe('declared');
        expect(items(pool)).toEqual([{
            text: 'VFs 0-3 of enp65s0f1, vfio-pci (policy vm-igb)',
            ref: { apiVersion: 'sriovnetwork.openshift.io/v1', kind: 'SriovNetworkNodePolicy', name: 'vm-igb', namespace: 'openshift-sriov-network-operator' }
        }]);
        expect(find(facts, 'Device Resource')?.hint).not.toContain('was not read');
        expect(facts.map((f) => f.label)).toEqual([
            'Type', 'CNI Type', 'Network Name', 'SR-IOV Network', 'Device Resource', 'VF Pool', 'VF Settings'
        ]);
    });

    it('has no pool row without the node state, and says so', () => {
        const facts = nadFacts(nads[0], bare);
        expect(find(facts, 'VF Pool')).toBeUndefined();
        expect(find(facts, 'Device Resource')?.hint).toContain('was not read');
    });
});
