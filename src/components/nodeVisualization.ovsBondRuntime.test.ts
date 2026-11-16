import fs from 'fs';
import path from 'path';

import { buildGraphContext, GraphContext, OvsBondRuntimeState } from '../topology/context';
import { descriptorFor } from '../topology/descriptors';
import { nodeKindRegistry } from '../topology/registry';
import { Fact, FactItem } from '../topology/types';
import { buildNodeViewModel } from '../topology/viewModel';
import { NodeNetworkState, OvsBondsResponse } from '../types';
import { ovsBondRuntimeState } from './useOvsBondState';

/**
 * The ovs-bond drawer's Runtime State row with the collector's bond/show answer laid
 * over the context (ovn-recon-1tw.7). The response is the contract's example, which is
 * the live capture of bond1 on worker-1 (OVS 3.5.2): balance-slb over ens161 and ens256,
 * ens161 the active member, both enabled.
 */
const nns: NodeNetworkState = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), 'test', 'fixtures', 'nns', 'ovs-bond-slb.json'), 'utf-8'));

const CONTRACT_EXAMPLE: OvsBondsResponse = {
    metadata: {
        schemaVersion: 'v1alpha1',
        generatedAt: '2026-11-16T20:15:00Z',
        sourceHealth: 'ok',
        nodeName: 'worker-1'
    },
    warnings: [],
    bonds: [{
        name: 'bond1',
        mode: 'balance-slb',
        lacpStatus: 'off',
        lacpFallbackAb: false,
        allMembersActive: false,
        updelayMs: 0,
        downdelayMs: 0,
        nextRebalanceMs: 9036,
        activeBackupPrimary: null,
        activeMember: { name: 'ens161', mac: '00:50:56:b4:1b:27' },
        members: [
            { name: 'ens161', enabled: true, active: true, mayEnable: true },
            { name: 'ens256', enabled: true, active: false, mayEnable: true }
        ]
    }]
};

const withMembers = (members: OvsBondsResponse['bonds'][number]['members']): OvsBondsResponse => ({
    ...CONTRACT_EXAMPLE,
    bonds: [{ ...CONTRACT_EXAMPLE.bonds[0], members }]
});

const DEGRADED: OvsBondsResponse = {
    ...CONTRACT_EXAMPLE,
    metadata: { ...CONTRACT_EXAMPLE.metadata, sourceHealth: 'degraded' },
    warnings: [{ code: 'LIVE_PROBE_FAILED', message: 'exec into ovnkube-node failed; serving fixture' }]
};

const baseCtx = buildGraphContext({ nns });
const over = (runtime: OvsBondRuntimeState | undefined): GraphContext =>
    (runtime ? { ...baseCtx, ovsBondRuntime: runtime } : baseCtx);
const loaded = (response: OvsBondsResponse): GraphContext => over(ovsBondRuntimeState(response, 'worker-1'));

const descriptor = descriptorFor('ovs-bond')!;
const factsOf = (ctx: GraphContext): Fact[] => {
    const node = buildNodeViewModel(ctx.ovsBonds[0], descriptor, ctx);
    return nodeKindRegistry[node.kind].facts!(node, ctx);
};
const runtimeRow = (ctx: GraphContext): Fact => factsOf(ctx).find((fact) => fact.label === 'Runtime State')!;
const texts = (fact: Fact): string[] => (fact.value as FactItem[]).map((item) => item.text);

describe('ovsBondRuntimeState', () => {
    it('keys the bonds by name and keeps the answer\'s provenance', () => {
        const state = ovsBondRuntimeState(CONTRACT_EXAMPLE, 'worker-1');
        expect('error' in state).toBe(false);
        if ('error' in state) return;
        expect(Array.from(state.byBond.keys())).toEqual(['bond1']);
        expect(state).toMatchObject({
            nodeName: 'worker-1', generatedAt: '2026-11-16T20:15:00Z', sourceHealth: 'ok', warnings: []
        });
    });
});

describe('the ovs-bond Runtime State row', () => {
    it('is today\'s pointer, exactly, with no runtime state (collector off, or no answer yet)', () => {
        const row = runtimeRow(baseCtx);
        expect(row.value).toBe('ovs-appctl bond/show bond1');
        expect(row.provenance).toBe('observed');
        expect(row.hint).toBe('ip link does not show bond1: an OVS bond has no kernel device, and '
            + 'NodeNetworkState carries its configuration only. Run ovs-appctl bond/show bond1 on worker-1 '
            + '(oc debug node, then chroot /host) for the active member, which members OVS has enabled, and '
            + 'how the hash buckets are spread.');
    });

    it('shows the active member, each member as OVS has it, and LACP, from the contract\'s example', () => {
        const row = runtimeRow(loaded(CONTRACT_EXAMPLE));
        expect(row.value).toEqual([
            { text: 'Active member: ens161', node: 'iface:ens161' },
            { text: 'ens161: enabled', node: 'iface:ens161' },
            { text: 'ens256: enabled', node: 'iface:ens256' },
            { text: 'LACP: off' }
        ]);
        expect(row.provenance).toBe('observed');
        expect(row.hint).toContain('ovs-appctl bond/show on worker-1, read by the collector at 2026-11-16T20:15:00Z.');
        // The rebalance timer is stale before anyone reads it.
        expect(JSON.stringify(row)).not.toContain('rebalance');
    });

    it('says which member OVS disabled, and why it cannot enable it', () => {
        const row = runtimeRow(loaded(withMembers([
            { name: 'ens161', enabled: true, active: true, mayEnable: true },
            { name: 'ens256', enabled: false, active: false, mayEnable: false }
        ])));
        expect(texts(row)).toContain('ens256: disabled (may_enable: false)');
    });

    it('shows a configured member OVS does not list, and a listed one NNS does not configure', () => {
        const row = runtimeRow(loaded(withMembers([
            { name: 'ens161', enabled: true, active: true, mayEnable: true },
            { name: 'ens999', enabled: true, active: false, mayEnable: true }
        ])));
        const items = row.value as FactItem[];
        expect(items.find((item) => item.text === 'ens999: enabled')?.detail)
            .toBe('not in br-vmdata\'s link-aggregation.port');
        expect(items.find((item) => item.text === 'ens256: not in bond/show')?.detail)
            .toBe('configured in NodeNetworkState, but OVS does not list it as a member');
    });

    it('says "none" for a bond with no active member', () => {
        const response = withMembers(CONTRACT_EXAMPLE.bonds[0].members);
        delete response.bonds[0].activeMember;
        expect(texts(runtimeRow(loaded(response)))[0]).toBe('Active member: none');
    });

    it('marks a degraded (LIVE_PROBE_FAILED) answer as not live, in the value and the hint', () => {
        const row = runtimeRow(loaded(DEGRADED));
        expect(texts(row)[0]).toBe('⚠ Not live: sample data from the collector (LIVE_PROBE_FAILED)');
        expect(texts(row)).toContain('Active member: ens161');
        expect(row.hint).toBe('The collector could not run ovs-appctl bond/show on worker-1 (LIVE_PROBE_FAILED) '
            + 'and served the sample data it ships instead, at 2026-11-16T20:15:00Z: this is not worker-1\'s '
            + 'live state.');
    });

    it('keeps the pointer when a degraded answer has no bonds at all', () => {
        const row = runtimeRow(loaded({ ...DEGRADED, bonds: [] }));
        expect(texts(row)).toEqual([
            'ovs-appctl bond/show bond1',
            '⚠ Collector could not read worker-1\'s bonds (LIVE_PROBE_FAILED)'
        ]);
        expect(row.hint).toContain('this is not worker-1\'s live state');
        expect(row.hint).toContain('ip link does not show bond1');
    });

    it('says so when OVS, read live, has no bond of that name', () => {
        const row = runtimeRow(loaded({ ...CONTRACT_EXAMPLE, bonds: [] }));
        expect(texts(row)).toEqual(['ovs-appctl bond/show bond1', '⚠ bond/show on worker-1 lists no bond bond1']);
        expect(row.hint).toContain('OVS reports no bond named bond1, though NodeNetworkState configures one in br-vmdata');
    });

    it('keeps the pointer and adds the collector\'s one-line failure when the request failed', () => {
        const row = runtimeRow(over({ error: 'Collector is not answering (HTTP 502)' }));
        expect(row.value).toEqual([
            { text: 'ovs-appctl bond/show bond1' },
            { text: 'Collector: Collector is not answering (HTTP 502)' }
        ]);
        expect(row.hint).toBe(runtimeRow(baseCtx).hint);
    });

    it('is a pure function of the context: the same context gives the same facts', () => {
        [baseCtx, loaded(CONTRACT_EXAMPLE), loaded(DEGRADED), over({ error: 'x' })].forEach((ctx) => {
            expect(factsOf(ctx)).toEqual(factsOf(ctx));
        });
        // Nothing but the Runtime State row moves with the runtime state.
        const without = factsOf(baseCtx).filter((fact) => fact.label !== 'Runtime State');
        const withRuntime = factsOf(loaded(CONTRACT_EXAMPLE)).filter((fact) => fact.label !== 'Runtime State');
        expect(withRuntime).toEqual(without);
    });
});

describe('the ovs-bond card\'s state line with runtime state', () => {
    const stateOf = (ctx: GraphContext) => descriptor.present(ctx.ovsBonds[0], ctx).state;

    it('is unchanged while OVS has every member enabled', () => {
        expect(stateOf(loaded(CONTRACT_EXAMPLE))).toBe(stateOf(baseCtx));
        expect(stateOf(baseCtx)).toBe('balance-slb');
    });

    it('counts the enabled members when OVS disabled one whose link is up', () => {
        const ctx = loaded(withMembers([
            { name: 'ens161', enabled: true, active: true, mayEnable: true },
            { name: 'ens256', enabled: false, active: false, mayEnable: false }
        ]));
        expect(stateOf(ctx)).toBe('balance-slb · 1/2 enabled');
    });

    it('ignores a degraded answer: the card cannot say it is not live', () => {
        const ctx = loaded({
            ...DEGRADED,
            bonds: [{ ...DEGRADED.bonds[0], members: [
                { name: 'ens161', enabled: true, active: true, mayEnable: true },
                { name: 'ens256', enabled: false, active: false, mayEnable: false }
            ] }]
        });
        expect(stateOf(ctx)).toBe('balance-slb');
    });
});
