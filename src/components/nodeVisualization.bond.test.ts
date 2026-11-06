import fs from 'fs';
import path from 'path';

import { buildGraphContext, GraphContext } from '../topology/context';
import { descriptorFor } from '../topology/descriptors';
import { nodeKindRegistry } from '../topology/registry';
import { Fact } from '../topology/types';
import { buildNodeViewModel } from '../topology/viewModel';
import { describeBond, getBondMembers } from './nodeVisualizationSelectors';
import { Interface, NodeNetworkState } from '../types';

/**
 * A bond's drawer says what kind of bond it is (ovn-recon-s3t.61).
 *
 * The drawer showed a bond's type, state, MAC and MTU and nothing about the bond
 * itself, though NodeNetworkState reports its mode, members and every kernel option
 * under link-aggregation. The fact is selective: the Config tab has all thirty-odd
 * options, so the overview carries the ones that say how the bond behaves and what
 * the switch side must match.
 */
const nns: NodeNetworkState = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), 'test', 'fixtures', 'nns', 'bonded-lldp.json'), 'utf-8'));

/**
 * The option block as nmstate reports it for an LACP bond: every kernel option,
 * most at their defaults, in no useful order.
 */
const LACP_OPTIONS = {
    use_carrier: true,
    lp_interval: 1,
    ad_actor_sys_prio: 65535,
    downdelay: 0,
    lacp_active: true,
    arp_all_targets: 'any',
    xmit_hash_policy: 'layer2',
    arp_interval: 0,
    updelay: 0,
    all_slaves_active: 'dropped',
    primary_reselect: 'always',
    min_links: 0,
    ad_actor_system: '00:00:00:00:00:00',
    arp_validate: 'none',
    ad_select: 'stable',
    ad_user_port_key: 0,
    lacp_rate: 'slow',
    miimon: 150
};

const bond = (
    mode: string | undefined,
    options?: Record<string, string | number | boolean>,
    port: string[] = ['eno3', 'eno4']
): Interface => ({
    name: 'bond0',
    type: 'bond',
    state: 'up',
    'link-aggregation': { ...(mode ? { mode } : {}), port, ...(options ? { options } : {}) }
});

const ctxOf = (interfaces: Interface[]): GraphContext => buildGraphContext({
    nns: { status: { currentState: { interfaces } } } as NodeNetworkState
});
const factsFor = (ctx: GraphContext, name: string, type: 'bond' | 'physical'): Fact[] => {
    const descriptor = descriptorFor(type)!;
    const item = ctx.interfaces.find((i) => i.name === name)!;
    return nodeKindRegistry[descriptor.kind].facts!(buildNodeViewModel(item, descriptor, ctx), ctx);
};
const bondFact = (ctx: GraphContext, name = 'bond0'): Fact | undefined =>
    factsFor(ctx, name, 'bond').find((f) => f.label === 'Bond');

describe('describing a bond', () => {
    it('reads an LACP bond: mode, members, hash, rate, activity and link monitor', () => {
        expect(describeBond(bond('802.3ad', LACP_OPTIONS))).toEqual([
            'Mode: 802.3ad (LACP)',
            'Members: eno3, eno4',
            'Transmit hash: layer2',
            'LACP rate: slow',
            'LACP: active',
            'Link monitor: MII every 150 ms'
        ]);
    });

    it('leaves out the defaults that say nothing: zero delays, zero min links', () => {
        const lines = describeBond(bond('802.3ad', LACP_OPTIONS));
        expect(lines.some((l) => /delay|Min links/.test(l))).toBe(false);
    });

    it('reports min links, delays and a passive LACP when they are set', () => {
        expect(describeBond(bond('802.3ad', {
            ...LACP_OPTIONS, lacp_active: false, lacp_rate: 'fast', min_links: 2, updelay: 300, downdelay: 150
        }))).toEqual([
            'Mode: 802.3ad (LACP)',
            'Members: eno3, eno4',
            'Transmit hash: layer2',
            'LACP rate: fast',
            'LACP: passive',
            'Min links: 2',
            'Link monitor: MII every 150 ms',
            'Up delay: 300 ms',
            'Down delay: 150 ms'
        ]);
    });

    it('reads balance-xor with its hash policy and no LACP lines', () => {
        expect(describeBond(bond('balance-xor', { xmit_hash_policy: 'layer3+4', miimon: 100, lacp_rate: 'slow' })))
            .toEqual([
                'Mode: balance-xor',
                'Members: eno3, eno4',
                'Transmit hash: layer3+4',
                'Link monitor: MII every 100 ms'
            ]);
    });

    it('reads active-backup with its primary, ignoring the hash policy it never uses', () => {
        expect(describeBond(bond('active-backup', { primary: 'eno3', xmit_hash_policy: 'layer2', miimon: 100 })))
            .toEqual([
                'Mode: active-backup',
                'Members: eno3, eno4',
                'Primary: eno3',
                'Link monitor: MII every 100 ms'
            ]);
    });

    it('glosses the modes whose kernel names are opaque', () => {
        expect(describeBond(bond('balance-rr'))[0]).toBe('Mode: balance-rr (round-robin)');
        expect(describeBond(bond('balance-tlb'))[0]).toBe('Mode: balance-tlb (adaptive transmit load balancing)');
        expect(describeBond(bond('balance-alb'))[0]).toBe('Mode: balance-alb (adaptive load balancing)');
        expect(describeBond(bond('broadcast'))[0]).toBe('Mode: broadcast');
    });

    it('shows a mode it has never heard of as reported', () => {
        expect(describeBond(bond('some-future-mode'))[0]).toBe('Mode: some-future-mode');
    });

    it('reads ARP monitoring, with its targets', () => {
        expect(describeBond(bond('active-backup', { miimon: 0, arp_interval: 1000, arp_ip_target: '192.0.2.1' })))
            .toContain('Link monitor: ARP every 1000 ms to 192.0.2.1');
    });

    it('says the bond has no link monitor when both intervals are zero', () => {
        expect(describeBond(bond('active-backup', { miimon: 0, arp_interval: 0 }))).toContain('Link monitor: none');
    });

    it('accepts options reported as strings or kernel-style flags', () => {
        expect(describeBond(bond('802.3ad', { miimon: '100', lacp_active: 'off', min_links: '1' }))).toEqual([
            'Mode: 802.3ad (LACP)',
            'Members: eno3, eno4',
            'LACP: passive',
            'Min links: 1',
            'Link monitor: MII every 100 ms'
        ]);
    });

    it('stands on mode and members alone when no options are reported', () => {
        // Absent options are not "no monitoring": nothing is claimed about them.
        expect(describeBond(bond('802.3ad'))).toEqual(['Mode: 802.3ad (LACP)', 'Members: eno3, eno4']);
    });

    it('reads members under the older `slaves` key', () => {
        const old = { name: 'bond0', type: 'bond', state: 'up', 'link-aggregation': { mode: 'active-backup', slaves: ['eth0', 'eth1'] } };
        expect(getBondMembers(old as Interface)).toEqual(['eth0', 'eth1']);
        expect(describeBond(old as Interface)).toEqual(['Mode: active-backup', 'Members: eth0, eth1']);
    });

    it('has nothing to say about an interface with no link-aggregation', () => {
        expect(describeBond({ name: 'eno3', type: 'ethernet', state: 'up' })).toEqual([]);
        expect(describeBond(undefined)).toEqual([]);
    });
});

describe('the bond drawer', () => {
    it('carries a Bond fact, observed, pointing at the Config tab for the rest', () => {
        const fact = bondFact(ctxOf([bond('802.3ad', LACP_OPTIONS)]))!;
        expect(fact.provenance).toBe('observed');
        expect(fact.value).toEqual([
            { text: 'Mode: 802.3ad (LACP)' },
            { text: 'Members: eno3, eno4' },
            { text: 'Transmit hash: layer2' },
            { text: 'LACP rate: slow' },
            { text: 'LACP: active' },
            { text: 'Link monitor: MII every 150 ms' }
        ]);
        expect(fact.hint).toContain('Config tab');
    });

    it('shows mode and members for every bond of a real capture that reports no options', () => {
        const ctx = buildGraphContext({ nns });
        expect(bondFact(ctx, 'bond0')!.value).toEqual([
            { text: 'Mode: 802.3ad (LACP)' },
            { text: 'Members: ens2f0np0, ens5f0np0' }
        ]);
        ['bond1', 'bond2'].forEach((name) => {
            expect((bondFact(ctx, name)!.value as { text: string }[])[0].text).toBe('Mode: 802.3ad (LACP)');
        });
    });

    it('sits ahead of the MAC address, with the other what-is-this facts', () => {
        const labels = factsFor(ctxOf([{ ...bond('802.3ad', LACP_OPTIONS), 'mac-address': '02:00:00:00:10:00' }]), 'bond0', 'bond')
            .map((f) => f.label);
        expect(labels.indexOf('Bond')).toBeGreaterThan(-1);
        expect(labels.indexOf('Bond')).toBeLessThan(labels.indexOf('MAC Address'));
    });

    it('is not added to an interface that is not a bond', () => {
        const ctx = buildGraphContext({ nns });
        expect(factsFor(ctx, 'ens2f0np0', 'physical').find((f) => f.label === 'Bond')).toBeUndefined();
    });
});
