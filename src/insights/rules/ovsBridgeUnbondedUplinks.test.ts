import type { BridgeOptions, Interface, NodeNetworkState } from '../../types';
import { clone, loadFixture, physicalContext } from '../testing';
import { ovsBridgeUnbondedUplinks } from './ovsBridgeUnbondedUplinks';

/*
 * The ovs-bond-slb capture (ovn-recon-1tw.1): br-vmdata, STP and RSTP off, whose
 * uplinks ens161 and ens256 are members of OVS bond bond1; br-ex, whose only uplink is
 * the VLAN bond0.1926. Each case varies a copy of it.
 */
const fixture = loadFixture<NodeNetworkState>('nns', 'ovs-bond-slb.json');

const interfacesOf = (nns: NodeNetworkState): Interface[] => nns.status!.currentState!.interfaces!;
const find = (nns: NodeNetworkState, name: string, type: string): Interface =>
    interfacesOf(nns).find((iface) => iface.name === name && iface.type === type)!;

/** The capture with bond1 taken apart: ens161 and ens256 plain ports of br-vmdata. */
const unbonded = (options?: BridgeOptions | null): NodeNetworkState => {
    const nns = clone(fixture);
    const bridge = find(nns, 'br-vmdata', 'ovs-bridge');
    bridge.bridge!.port = [{ name: 'ovs-br1' }, { name: 'ens161' }, { name: 'ens256' }];
    if (options === null) delete bridge.bridge!.options;
    else if (options) bridge.bridge!.options = options;
    return nns;
};

const evaluate = (nns: NodeNetworkState) => ovsBridgeUnbondedUplinks.evaluate(physicalContext({ nns }));

describe('ovs-bridge-unbonded-uplinks', () => {
    it('fires on a bridge with two plain NIC uplinks and STP and RSTP off', () => {
        const findings = evaluate(unbonded());

        expect(findings).toHaveLength(1);
        expect(findings[0]).toEqual(expect.objectContaining({
            ruleId: 'ovs-bridge-unbonded-uplinks',
            severity: 'warning',
            subject: { kind: 'graph-node', node: 'worker-1', graphNodeId: 'iface:br-vmdata' },
            scope: { node: 'worker-1' },
            summary: 'OVS bridge br-vmdata on worker-1 has 2 uplinks not aggregated in one bond '
                + '(ens161, ens256) with STP and RSTP off.'
        }));
        expect(findings[0].evidence.map((e) => [e.fact, e.path])).toEqual([
            ['ens161 (ethernet, up) is an uplink of br-vmdata in no OVS bond.',
                'status.currentState.interfaces[name=ens161].controller'],
            ['ens256 (ethernet, up) is an uplink of br-vmdata in no OVS bond.',
                'status.currentState.interfaces[name=ens256].controller'],
            ['br-vmdata has STP and RSTP off.', 'status.currentState.interfaces[name=br-vmdata].bridge.options']
        ]);
        expect(findings[0].evidence.every((e) => e.inferred === undefined)).toBe(true);
        expect(findings[0].evidence[0].sources).toEqual([expect.objectContaining({ kind: 'NodeNetworkState', name: 'worker-1' })]);
        // No enactment in the capture, so the remedy points at the node.
        expect(findings[0].remedy.target).toEqual(expect.objectContaining({ kind: 'Node', name: 'worker-1' }));
        expect(findings[0].remedy.text).toContain('Aggregate ens161, ens256 in one OVS bond on br-vmdata');
        expect(findings[0].remedy.text).toContain('enable RSTP');
    });

    it('is quiet on the ovs-bond-slb capture: bond1 is one uplink, and br-ex has one', () => {
        expect(evaluate(fixture)).toEqual([]);
    });

    it('is quiet when STP is enabled, in either shape', () => {
        expect(evaluate(unbonded({ stp: { enabled: true }, rstp: false }))).toEqual([]);
        expect(evaluate(unbonded({ stp: true, rstp: false }))).toEqual([]);
    });

    it('fires when STP is a bare false, as older nmstate reports it', () => {
        expect(evaluate(unbonded({ stp: false, rstp: false }))).toHaveLength(1);
    });

    it('is quiet when RSTP is enabled', () => {
        expect(evaluate(unbonded({ stp: { enabled: false }, rstp: true }))).toEqual([]);
    });

    it('is quiet when the bridge reports no options, or no STP setting: unknown is not off', () => {
        expect(evaluate(unbonded(null))).toEqual([]);
        expect(evaluate(unbonded({ rstp: false }))).toEqual([]);
        expect(evaluate(unbonded({ stp: {}, rstp: false }))).toEqual([]);
    });

    it('reads an absent rstp as off, and marks it inferred', () => {
        const findings = evaluate(unbonded({ stp: { enabled: false } }));
        expect(findings).toHaveLength(1);
        expect(findings[0].evidence[findings[0].evidence.length - 1].inferred).toMatch(/no rstp option/);
    });

    it('counts an OVS bond plus one extra NIC as two uplinks', () => {
        const nns = clone(fixture);
        interfacesOf(nns).push({ ...clone(find(nns, 'ens161', 'ethernet')), name: 'ens300' });
        find(nns, 'br-vmdata', 'ovs-bridge').bridge!.port!.push({ name: 'ens300' });

        const findings = evaluate(nns);

        expect(findings.map((f) => f.summary)).toEqual([
            'OVS bridge br-vmdata on worker-1 has 2 uplinks not aggregated in one bond '
                + '(bond1, ens300) with STP and RSTP off.'
        ]);
        expect(findings[0].evidence.map((e) => e.fact)).toEqual([
            'bond1 is an OVS bond on br-vmdata (balance-slb) aggregating ens161, ens256; it counts as one uplink.',
            'ens300 (ethernet, up) is an uplink of br-vmdata in no OVS bond.',
            'br-vmdata has STP and RSTP off.'
        ]);
        expect(findings[0].evidence[0].path)
            .toBe('status.currentState.interfaces[name=br-vmdata].bridge.port[name=bond1].link-aggregation');
    });

    it('still fires when one uplink is down: a latent loop is still a misconfiguration', () => {
        const nns = unbonded();
        find(nns, 'ens256', 'ethernet').state = 'down';
        const findings = evaluate(nns);
        expect(findings).toHaveLength(1);
        expect(findings[0].evidence[1].fact).toBe('ens256 (ethernet, down) is an uplink of br-vmdata in no OVS bond.');
    });

    it('is quiet on a Linux bridge with two NIC ports and STP off (out of scope)', () => {
        const nns = unbonded();
        const bridge = find(nns, 'br-vmdata', 'ovs-bridge');
        bridge.type = 'linux-bridge';
        bridge.bridge!.options = { stp: { enabled: false } };
        expect(evaluate(nns)).toEqual([]);
    });

    it('is quiet on br-int, which is OVN\'s', () => {
        const nns = unbonded();
        interfacesOf(nns).forEach((iface) => {
            if (iface.name === 'br-vmdata') iface.name = 'br-int';
            if (iface.controller === 'br-vmdata') iface.controller = 'br-int';
        });
        expect(evaluate(nns)).toEqual([]);
    });

    /*
     * Uplinks counted by the link they leave on (ovn-recon-vb1). VLANs of one NIC
     * bridged together join two VLANs; a broadcast never returns on the other one.
     */
    describe('VLAN uplinks (ovn-recon-vb1)', () => {
        const vlan = (name: string, base: string, id: number, controller = 'br-vmdata'): Interface => ({
            name, type: 'vlan', state: 'up', controller, vlan: { 'base-iface': base, id }
        });
        /** br-vmdata with bond1 dropped and these VLANs (and any extra ports) as its ports. */
        const withPorts = (
            vlans: Interface[], extraPorts: string[] = [], keepBond = false, others: Interface[] = []
        ): NodeNetworkState => {
            const nns = clone(fixture);
            const bridge = find(nns, 'br-vmdata', 'ovs-bridge');
            const bond = bridge.bridge!.port!.find((port) => port.name === 'bond1')!;
            bridge.bridge!.port = [
                { name: 'ovs-br1' },
                ...(keepBond ? [bond] : []),
                ...vlans.map((v) => ({ name: v.name })),
                ...extraPorts.map((name) => ({ name }))
            ];
            const nics = interfacesOf(nns).filter((iface) => iface.name === 'ens161' || iface.name === 'ens256');
            // Without the bond, ens161 and ens256 are free NICs, not ports of the bridge.
            if (!keepBond) nics.forEach((nic) => { if (!extraPorts.includes(nic.name)) delete nic.controller; });
            interfacesOf(nns).push(...vlans, ...others);
            return nns;
        };

        it('is quiet for two VLANs of one NIC: one link, no loop', () => {
            expect(evaluate(withPorts([vlan('ens161.10', 'ens161', 10), vlan('ens161.20', 'ens161', 20)]))).toEqual([]);
        });

        it('is quiet for stacked VLANs and a sibling on one NIC', () => {
            // ens161.10.20 rides ens161.10, which is not on the bridge, which rides ens161.
            const outer: Interface = { name: 'ens161.10', type: 'vlan', state: 'up', vlan: { 'base-iface': 'ens161', id: 10 } };
            expect(evaluate(withPorts(
                [vlan('ens161.10.20', 'ens161.10', 20), vlan('ens161.30', 'ens161', 30)], [], false, [outer]
            ))).toEqual([]);
        });

        it('fires for VLANs on two different NICs, naming each link and its VLANs', () => {
            const findings = evaluate(withPorts([vlan('ens161.10', 'ens161', 10), vlan('ens256.20', 'ens256', 20)]));
            expect(findings).toHaveLength(1);
            expect(findings[0].summary).toBe('OVS bridge br-vmdata on worker-1 has 2 uplinks not aggregated in one '
                + 'bond (ens161 (ens161.10), ens256 (ens256.20)) with STP and RSTP off.');
            expect(findings[0].evidence.map((e) => e.fact)).toContain(
                'ens161.10 leaves the node on ens161, counted as one uplink: VLANs of one link join VLANs, '
                    + 'they do not loop one.');
        });

        it('fires for a VLAN of kernel bond0 beside a plain NIC', () => {
            const findings = evaluate(withPorts([vlan('bond0.30', 'bond0', 30)], ['ens161']));
            expect(findings).toHaveLength(1);
            // In the node's interface order: ens161 is reported before the appended VLAN.
            expect(findings[0].summary).toContain('(ens161, bond0 (bond0.30))');
        });

        it('counts a VLAN of an OVS bond member with that bond: one path, quiet', () => {
            expect(evaluate(withPorts([vlan('ens161.10', 'ens161', 10)], [], true))).toEqual([]);
        });
    });

    it('is quiet without a node', () => {
        expect(ovsBridgeUnbondedUplinks.evaluate({ domain: 'physical', cluster: { cudns: [], udns: [], nads: [] } }))
            .toEqual([]);
    });
});
