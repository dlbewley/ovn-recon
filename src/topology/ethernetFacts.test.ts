import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';

import { buildGraphContext, GraphContext } from './context';
import { descriptorFor } from './descriptors';
import { nodeKindRegistry } from './registry';
import { buildNodeViewModel } from './viewModel';
import { Fact } from './types';
import { Interface, NodeNetworkState } from '../types';

/**
 * What the drawer says about a NIC itself (ovn-recon-s3t.62): driver, negotiated
 * link, LLDP, the hardware's own MAC, the MTU ceiling, and where it sits on the bus.
 *
 * Every one of these fields is optional in NodeNetworkState -- a trimmed capture or
 * an older nmstate reports few of them -- so each row is tested present and absent.
 */
const loadNns = (name: string): NodeNetworkState => {
    const content = fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'nns', `${name}.json`), 'utf-8');
    try {
        return JSON.parse(content) as NodeNetworkState;
    } catch {
        // host-lldp is a raw `oc get -o yaml` capture kept under a .json name.
        return yaml.load(content) as NodeNetworkState;
    }
};

const nnsOf = (interfaces: Interface[]): NodeNetworkState => ({
    apiVersion: 'nmstate.io/v1beta1',
    kind: 'NodeNetworkState',
    metadata: { name: 'worker-1' },
    status: { currentState: { interfaces } }
});

const factsIn = (ctx: GraphContext, name: string, type = 'physical'): Fact[] => {
    const iface = ctx.interfaces.find((i) => i.name === name);
    if (!iface) throw new Error(`no interface named "${name}"`);
    const node = buildNodeViewModel(iface, descriptorFor(type as never)!, ctx);
    return nodeKindRegistry.interface.facts!(node, ctx);
};

const factsOf = (iface: Interface, others: Interface[] = [], type = 'physical'): Fact[] =>
    factsIn(buildGraphContext({ nns: nnsOf([iface, ...others]) }), iface.name, type);

const find = (facts: Fact[], label: string): Fact | undefined => facts.find((f) => f.label === label);

const NIC_ONLY_LABELS = ['Driver', 'Link', 'Permanent MAC', 'LLDP', 'PCI Address', 'Alternative Names'];

describe('ethernet drawer facts (ovn-recon-s3t.62)', () => {
    describe('a bond member on a real host (host-lldp)', () => {
        const ctx = buildGraphContext({ nns: loadNns('host-lldp') });
        const facts = factsIn(ctx, 'enp44s0');

        it('names the driver', () => {
            expect(find(facts, 'Driver')).toEqual({ label: 'Driver', value: 'igc', provenance: 'observed' });
        });

        it('puts speed, duplex and auto-negotiation on one row', () => {
            expect(find(facts, 'Link')?.value).toBe('2.5 Gb/s · full duplex · auto-negotiation on');
        });

        it('shows the permanent MAC because the bond replaced it, and says so', () => {
            const permanent = find(facts, 'Permanent MAC')!;
            expect(find(facts, 'MAC Address')?.value).toBe('58:47:CA:7F:A2:BA');
            expect(permanent.value).toBe('58:47:CA:7F:A2:BB');
            expect(permanent.provenance).toBe('observed');
            expect(permanent.hint).toContain('member of bond bond0');
        });

        it('omits the permanent MAC on the member whose address the bond took', () => {
            expect(find(factsIn(ctx, 'enp45s0'), 'Permanent MAC')).toBeUndefined();
        });

        it('shows the MTU ceiling beside the MTU', () => {
            expect(find(facts, 'MTU')?.value).toBe('9000 (max 9216)');
        });

        it('lists the LLDP neighbor by system name and port', () => {
            const lldp = find(facts, 'LLDP')!;
            expect(lldp.value).toEqual([{ text: 'USWEnterprise48PoE, Port 34' }]);
            expect(lldp.provenance).toBe('observed');
        });

        it('gives the PCI address', () => {
            expect(find(facts, 'PCI Address')?.value).toBe('0000:2c:00.0');
        });

        it('orders the rows: what it is, how it is addressed, who it hears, where it sits', () => {
            const labels = facts.map((f) => f.label);
            const order = ['Driver', 'Link', 'MAC Address', 'Permanent MAC', 'MTU', 'LLDP', 'PCI Address'];
            expect(labels.filter((label) => order.includes(label))).toEqual(order);
        });
    });

    describe('a virtual NIC with an overridden MAC (evpn-vxlan)', () => {
        const facts = factsIn(buildGraphContext({ nns: loadNns('evpn-vxlan') }), 'ens192');

        it('reads driver, link and bus identity', () => {
            expect(find(facts, 'Driver')?.value).toBe('vmxnet3');
            expect(find(facts, 'Link')?.value).toBe('10 Gb/s · full duplex · auto-negotiation off');
            expect(find(facts, 'PCI Address')?.value).toBe('0000:0b:00.0');
            expect(find(facts, 'Alternative Names')?.value).toBe('enp11s0');
        });

        it('attributes the differing MAC to configuration, there being no bond', () => {
            const permanent = find(facts, 'Permanent MAC')!;
            expect(permanent.value).toBe('00:50:56:B4:AE:17');
            expect(permanent.hint).toContain('set by configuration');
            expect(permanent.hint).not.toContain('bond');
        });

        it('leaves the MTU bare when no ceiling is reported, and says nothing about LLDP', () => {
            expect(find(facts, 'MTU')?.value).toBe('1500');
            expect(find(facts, 'LLDP')).toBeUndefined();
        });
    });

    describe('a capture that reports only some fields (bonded-lldp)', () => {
        const facts = factsIn(buildGraphContext({ nns: loadNns('bonded-lldp') }), 'ens2f0np0');

        it('shows the link without auto-negotiation, and no driver', () => {
            expect(find(facts, 'Link')?.value).toBe('25 Gb/s · full duplex');
            expect(find(facts, 'Driver')).toBeUndefined();
        });

        it('omits a permanent MAC equal to the one in use', () => {
            expect(find(facts, 'Permanent MAC')).toBeUndefined();
        });

        it('lists its LLDP neighbor', () => {
            expect(find(facts, 'LLDP')?.value).toEqual([{ text: 'lab-fabric-lf001, Eth1/22' }]);
        });
    });

    it('adds nothing to an ethernet that reports none of it (basic-host)', () => {
        const ctx = buildGraphContext({ nns: loadNns('basic-host') });
        const nic = ctx.interfaces.find((i) => i.type === 'ethernet')!;
        const labels = factsIn(ctx, nic.name).map((f) => f.label);
        NIC_ONLY_LABELS.forEach((label) => expect(labels).not.toContain(label));
    });

    describe('LLDP has three states', () => {
        const nic = (lldp: Interface['lldp']): Interface => ({ name: 'eno1', type: 'ethernet', state: 'up', lldp });

        it('disabled', () => {
            expect(find(factsOf(nic({ enabled: false })), 'LLDP')?.value).toBe('Disabled');
        });

        it('enabled with nobody answering, which is a finding of its own', () => {
            const empty = find(factsOf(nic({ enabled: true, neighbors: [] })), 'LLDP')!;
            expect(empty.value).toBe('Enabled, no neighbors heard');
            expect(empty.hint).toContain('lists no neighbor');
            expect(find(factsOf(nic({ enabled: true })), 'LLDP')?.value).toBe('Enabled, no neighbors heard');
        });

        it('enabled with neighbors, falling back to the chassis ID and dropping a missing port', () => {
            const facts = factsOf(nic({
                enabled: true,
                neighbors: [
                    [{ 'system-name': 'leaf-1', type: 5 }, { 'port-id': 'Eth1/1', type: 2 }],
                    [{ 'chassis-id': '02:00:00:00:40:12', type: 1 }]
                ]
            }));
            expect(find(facts, 'LLDP')?.value).toEqual([{ text: 'leaf-1, Eth1/1' }, { text: '02:00:00:00:40:12' }]);
        });

        it('says nothing when the interface does not report lldp', () => {
            expect(find(factsOf(nic(undefined)), 'LLDP')).toBeUndefined();
        });
    });

    describe('the link row', () => {
        const withLink = (ethernet: Interface['ethernet']): Fact | undefined =>
            find(factsOf({ name: 'eno1', type: 'ethernet', state: 'down', ethernet }), 'Link');

        it('reports sub-gigabit speeds in Mb/s', () => {
            expect(withLink({ speed: 100, duplex: 'half' })?.value).toBe('100 Mb/s · half duplex');
        });

        it('drops a speed and duplex the kernel does not know, as on a link that is down', () => {
            expect(withLink({ speed: 0, duplex: 'unknown' })).toBeUndefined();
            expect(withLink({ speed: -1 })).toBeUndefined();
            expect(withLink({ speed: 0, 'auto-negotiation': true })?.value).toBe('auto-negotiation on');
        });
    });

    it('keeps NIC rows off other interface types, which report some of the same fields', () => {
        const bond: Interface = {
            name: 'bond0', type: 'bond', state: 'up', mtu: 9000, 'max-mtu': 65535, driver: 'bonding',
            'mac-address': '58:47:CA:7F:A2:BA', 'permanent-mac-address': '58:47:CA:7F:A2:BB',
            lldp: { enabled: false }
        };
        const facts = factsOf(bond, [], 'bond');
        NIC_ONLY_LABELS.forEach((label) => expect(find(facts, label)).toBeUndefined());
        expect(find(facts, 'MTU')?.value).toBe('9000');
    });
});
