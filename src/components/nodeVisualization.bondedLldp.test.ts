import fs from 'fs';
import path from 'path';

import { extractLldpNeighbors, getIpv4Addresses, hasLldpNeighbors } from './nodeVisualizationSelectors';
import { Interface, NodeNetworkState, OvnBridgeMapping } from '../types';

/**
 * A sanitised capture of a bonded, LLDP-attached worker on Cisco UCS hardware.
 * Complements primary-cudn-vrf.json, which has neither bonds nor LLDP, and adds
 * two shapes no other fixture has:
 *
 *   - three 802.3ad bonds with different fates: one into br-ex, one into a
 *     second OVS bridge, one standalone carrying its own address
 *   - twenty-seven localnet mappings on a single bridge
 */
const nns: NodeNetworkState = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), 'test', 'fixtures', 'nns', 'bonded-lldp.json'), 'utf-8'));

const interfaces: Interface[] = nns.status?.currentState?.interfaces ?? [];
const bridgeMappings: OvnBridgeMapping[] = nns.status?.currentState?.ovn?.['bridge-mappings'] ?? [];
const find = (name: string, type: string) =>
    interfaces.find((i) => i.name === name && i.type === type)!;

describe('bonded-lldp fixture: sanitisation', () => {
    it('carries no identifying values from the source cluster', () => {
        const raw = fs.readFileSync(
            path.join(process.cwd(), 'test', 'fixtures', 'nns', 'bonded-lldp.json'), 'utf-8');

        expect(raw).not.toMatch(/hostname\.example\.com/);
        expect(raw).not.toMatch(/mc900|1234207/);            // switch names with an asset number
        expect(raw).not.toMatch(/10\.23[25]\.|10\.155\./);   // site addressing and switch management
        expect(raw).not.toMatch(/6C:83:75|30:FE:FA|6C:4F:A1/i); // vendor OUIs
        expect(raw).not.toMatch(/clnepic|clnsvis|ctxxdc/i);  // tenant application names
    });

    it('keeps the relationships anonymisation could have broken', () => {
        const bond0 = find('bond0', 'bond');
        const member = find('ens5f0np0', 'ethernet');

        // 802.3ad members take the bond's MAC; permanent-mac-address remembers the
        // burned-in one. Rewriting MACs must not collapse that distinction.
        expect(find('ens2f0np0', 'ethernet')['mac-address']).toBe(bond0['mac-address']);
        expect(member['mac-address']).toBe(bond0['mac-address']);
        expect(member['permanent-mac-address']).not.toBe(member['mac-address']);

        // The br-ex internal port shares the uplink bond's MAC too.
        expect(find('br-ex', 'ovs-interface')['mac-address']).toBe(bond0['mac-address']);

        // OVN derives ovn-k8s-mp0's MAC from its address (ac.16.18.02 == 172.22.24.2),
        // so both were deliberately left alone rather than rewritten inconsistently.
        expect(find('ovn-k8s-mp0', 'ovs-interface')['mac-address']).toBe('0A:58:AC:16:18:02');
        expect(getIpv4Addresses(find('ovn-k8s-mp0', 'ovs-interface'))).toEqual(['172.22.24.2/21']);
    });
});

describe('bonds', () => {
    it('has three 802.3ad bonds with three different fates', () => {
        const bonds = interfaces.filter((i) => i.type === 'bond');
        expect(bonds.map((b) => b.name)).toEqual(['bond0', 'bond1', 'bond2']);
        bonds.forEach((b) => expect(b['link-aggregation']?.mode).toBe('802.3ad'));

        expect(find('bond0', 'bond').controller).toBe('br-ex');    // cluster uplink
        expect(find('bond1', 'bond').controller).toBe('ovs-vm');   // VM traffic bridge
        expect(find('bond2', 'bond').controller).toBeUndefined();  // standalone
    });

    it('carries a bond that owns an address and belongs to no bridge', () => {
        // The case the bond lane must not assume away: not every bond feeds a bridge.
        const bond2 = find('bond2', 'bond');
        expect(getIpv4Addresses(bond2)).toEqual(['203.0.113.24/24']);
        expect(bond2.controller).toBeUndefined();
        expect(bond2.mtu).toBe(9000);
    });

    it('links each member back to its bond in both directions', () => {
        interfaces.filter((i) => i.type === 'bond').forEach((bond) => {
            const declared: string[] = bond['link-aggregation']?.port ?? [];
            expect(declared).toHaveLength(2);
            // link-aggregation.port lists members; each member also names its controller.
            declared.forEach((name) => {
                expect(find(name, 'ethernet').controller).toBe(bond.name);
            });
        });
    });

    it('includes NICs in every member slot plus two unused down NICs', () => {
        const ethernets = interfaces.filter((i) => i.type === 'ethernet');
        const down = ethernets.filter((i) => i.state === 'down').map((i) => i.name);
        expect(down.sort()).toEqual(['ens2f3np3', 'ens5f3np3']);
    });
});

describe('LLDP', () => {
    it('reports neighbours, so the toggle is offered', () => {
        expect(hasLldpNeighbors(interfaces)).toBe(true);
    });

    it('finds one neighbour on each bonded NIC and none on the unused ones', () => {
        const neighbors = extractLldpNeighbors(interfaces);
        expect(neighbors.map((n) => n.localInterface).sort()).toEqual([
            'ens2f0np0', 'ens2f1np1', 'ens2f2np2', 'ens5f0np0', 'ens5f1np1', 'ens5f2np2'
        ]);
    });

    it('parses the switch identity out of the TLV list', () => {
        const neighbor = extractLldpNeighbors(interfaces)
            .find((n) => n.localInterface === 'ens2f0np0')!;

        expect(neighbor.systemName).toBe('lab-fabric-lf001');
        expect(neighbor.portId).toBe('Eth1/22');
        expect(neighbor.chassisId).toBe('02:00:00:00:40:12');
        expect(neighbor.systemDescription).toBe('topology/pod-1/node-101');
        expect(neighbor.capabilities.sort()).toEqual(['MAC Bridge component', 'Router']);
        expect(neighbor.label).toBe('lab-fabric-lf001');
    });

    it('shows each bond spanning two switches, which is the point of the bond', () => {
        const byInterface = new Map(extractLldpNeighbors(interfaces).map((n) => [n.localInterface, n]));

        // bond0's two members land on different leaves -- visible only because LLDP
        // is parsed per member rather than per bond.
        expect(byInterface.get('ens2f0np0')!.systemName).toBe('lab-fabric-lf001');
        expect(byInterface.get('ens5f0np0')!.systemName).toBe('lab-fabric-lf002');
    });

    it('keeps the raw TLVs, including ones the summary does not surface', () => {
        const neighbor = extractLldpNeighbors(interfaces)
            .find((n) => n.localInterface === 'ens2f0np0')!;

        // The management-address TLV has no field on LldpNeighborNode but must survive
        // for the drawer's raw view.
        const managementTlv = neighbor.rawTlvs.find((t) => 'management-addresses' in t);
        expect(managementTlv).toBeDefined();
        expect(JSON.stringify(managementTlv)).toContain('198.51.100.183');
    });
});

describe('many localnets on one bridge', () => {
    it('has twenty-seven mappings on a single bridge', () => {
        // Answers a design question directly: one bridge carrying many localnets is
        // not only possible, it is the normal shape on a VM-hosting node. Any
        // treatment of bridge mappings has to stay readable at this fan-out.
        const perBridge = bridgeMappings.reduce<Record<string, number>>((acc, m) => {
            acc[m.bridge] = (acc[m.bridge] ?? 0) + 1;
            return acc;
        }, {});

        expect(perBridge).toEqual({ 'br-ex': 1, 'ovs-vm': 27 });
    });

    it('names every mapped bridge as a real interface on the node', () => {
        const bridgeNames = new Set(
            interfaces.filter((i) => i.type === 'ovs-bridge').map((i) => i.name));
        new Set(bridgeMappings.map((m) => m.bridge))
            .forEach((bridge) => expect(bridgeNames.has(bridge)).toBe(true));
    });

    it('shows the dash-to-dot transform in patch port names on real data', () => {
        // Corroborates the naming rule ovn-recon-s3t.29 relies on: the localnet name
        // appears in its patch port with dashes rendered as dots.
        const patchNames = interfaces
            .filter((i) => i.name.startsWith('patch-') && i.name.includes('_ovn_localnet_port'))
            .map((i) => i.name);
        expect(patchNames.length).toBeGreaterThan(0);

        const localnets = new Set(bridgeMappings.map((m) => m.localnet));
        patchNames.forEach((patch) => {
            const dotted = /patch-(?:br-int-to-)?(.+?)_ovn_localnet_port/.exec(patch)![1]
                .replace(/^.*-to-/, '');
            expect(localnets.has(dotted.replace(/\./g, '-'))).toBe(true);
        });
    });

    it('has a localnet patch port that is down and unattached', () => {
        // tenant-a-infra's port exists but has no controller and is down -- a
        // half-configured mapping, and a shape the renderer must not assume away.
        // Note the name carries the dotted form, so it does not match the localnet
        // spelling directly; that transform is the subject of the previous test.
        const orphan = interfaces.find((i) => i.name.startsWith('patch-tenant.a.infra'))!;
        expect(orphan.controller).toBeUndefined();
        expect(orphan.state).toBe('down');
    });
});
