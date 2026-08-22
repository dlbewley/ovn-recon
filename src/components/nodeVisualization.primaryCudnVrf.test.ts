import fs from 'fs';
import path from 'path';

import {
    getVrfConnectionInfo,
    getVrfRoutesForInterface,
    getCudnAssociatedNamespaces,
    extractLldpNeighbors,
    hasLldpNeighbors
} from './nodeVisualizationSelectors';
import { ClusterUserDefinedNetwork, Interface, NodeNetworkState, OvnBridgeMapping } from '../types';

/**
 * Exercises the selectors against a sanitised capture of a real CNV worker
 * (test/fixtures/nns/primary-cudn-vrf.json). Synthetic fixtures only prove the
 * parsers handle shapes we thought of; this one carries shapes we did not:
 *
 *   - an ovs-interface that shadows an ovs-bridge of the same name, and holds
 *     the node's IP
 *   - a linux VLAN interface on a bridge-enslaved NIC
 *   - a VRF created by a Primary (Layer2) CUDN, with its own route table
 *   - two OVS bridges with two localnet bridge mappings
 *   - patch ports, a veth, a geneve tunnel and a loopback in the tail
 */
const loadJson = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

const nns = loadJson<NodeNetworkState>('nns', 'primary-cudn-vrf.json');
const cudns = loadJson<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json');

const interfaces: Interface[] = nns.status?.currentState?.interfaces ?? [];
const bridgeMappings: OvnBridgeMapping[] = nns.status?.currentState?.ovn?.['bridge-mappings'] ?? [];

const byNameAndType = (name: string, type: string) =>
    interfaces.find((iface) => iface.name === name && iface.type === type);

describe('primary-cudn-vrf fixture: shape', () => {
    it('keeps the interfaces the scenario depends on', () => {
        expect(interfaces).toHaveLength(20);
        expect(byNameAndType('br-ex', 'ovs-bridge')).toBeDefined();
        expect(byNameAndType('br-ex', 'ovs-interface')).toBeDefined();
        expect(byNameAndType('ens224.456', 'vlan')).toBeDefined();
        expect(byNameAndType('example-p-cudn', 'vrf')).toBeDefined();
    });

    it('carries no cluster-identifying values', () => {
        const raw = fs.readFileSync(
            path.join(process.cwd(), 'test', 'fixtures', 'nns', 'primary-cudn-vrf.json'), 'utf-8');
        expect(raw).not.toMatch(/cnv-1/);
        expect(raw).not.toMatch(/192\.168\.4\./);
        // Vendor OUIs from the real capture; sanitised MACs are all 02:00:00:00:*.
        expect(raw).not.toMatch(/00:50:56/i);
    });
});

describe('ovs-interface shadowing a bridge of the same name', () => {
    it('is a distinct object from the bridge, and is the one holding the node IP', () => {
        const bridge = byNameAndType('br-ex', 'ovs-bridge')!;
        const ovsInterface = byNameAndType('br-ex', 'ovs-interface')!;

        // The bridge has ports; the interface has addresses. Same name, different roles.
        expect(bridge.bridge?.port).toBeDefined();
        expect(bridge.ipv4?.address).toBeUndefined();

        const addresses = (ovsInterface.ipv4?.address ?? []).map((a) => a.ip);
        expect(addresses).toContain('192.0.2.72');
        // OVN's masquerade address rides on the same interface.
        expect(addresses).toContain('169.254.0.2');
        expect(ovsInterface.controller).toBe('br-ex');
    });

    it('lists itself as a port of its own bridge', () => {
        const bridge = byNameAndType('br-ex', 'ovs-bridge')!;
        const portNames = (bridge.bridge?.port ?? []).map((p: { name: string }) => p.name);

        expect(portNames).toContain('br-ex');
        expect(portNames).toContain('ens192');
        expect(portNames.filter((n: string) => n.startsWith('patch-'))).toHaveLength(2);
    });
});

describe('linux VLAN interface', () => {
    it('records its base interface and tag', () => {
        const vlan = byNameAndType('ens224.456', 'vlan')!;

        expect(vlan.vlan?.['base-iface']).toBe('ens224');
        expect(vlan.vlan?.id).toBe(456);
        expect(vlan.state).toBe('up');
    });

    it('sits on a NIC that is itself enslaved to the other OVS bridge', () => {
        // The edge builder draws base-iface -> vlan, and controller -> bridge, so this
        // NIC ends up with edges in two directions.
        const baseNic = byNameAndType('ens224', 'ethernet')!;
        expect(baseNic.controller).toBe('br-vmdata');
    });

    it('is distinct from the OVS access port on the same bridge', () => {
        // ovs-vlan-1920 is an ovs-interface with an access tag on the bridge, not a
        // linux vlan device. The two must not be conflated.
        const ovsAccessPort = byNameAndType('ovs-vlan-1920', 'ovs-interface')!;
        expect(ovsAccessPort.vlan).toBeUndefined();
        expect(ovsAccessPort.controller).toBe('br-vmdata');

        const bridge = byNameAndType('br-vmdata', 'ovs-bridge')!;
        const port = (bridge.bridge?.port ?? []).find((p: { name: string }) => p.name === 'ovs-vlan-1920');
        expect(port?.vlan).toEqual({ mode: 'access', tag: 1920 });
    });
});

describe('VRF created by a Primary CUDN', () => {
    const vrf = () => byNameAndType('example-p-cudn', 'vrf')!;

    it('is named after the CUDN and owns a route table', () => {
        const cudn = cudns.find((c) => c.metadata?.name === 'example-p-cudn')!;

        expect(cudn.spec?.network?.topology).toBe('Layer2');
        expect(cudn.spec?.network?.layer2?.role).toBe('Primary');
        expect(vrf().vrf?.['route-table-id']).toBe(5775);
        expect(vrf().vrf?.port).toEqual(['ovn-k8s-mp3']);
    });

    it('resolves the routes in its table', () => {
        const routes = getVrfRoutesForInterface(vrf(), nns);

        // All four are matched by table id. Two would also match on port; the other two
        // leave via br-ex and are reachable only through the table.
        expect(routes).toHaveLength(4);
        expect(routes.map((r) => r.destination).sort()).toEqual(
            ['0.0.0.0/0', '169.254.0.16/32', '169.254.0.3/32', '172.30.0.0/16']);
        routes.forEach((route) => expect(route.tableId).toBe('5775'));

        const defaultRoute = routes.find((r) => r.destination === '0.0.0.0/0')!;
        expect(defaultRoute.nextHopInterface).toBe('br-ex');
        expect(defaultRoute.nextHopAddress).toBe('192.0.2.1');
    });

    it('finds its br-int port', () => {
        const { brIntPorts } = getVrfConnectionInfo(vrf(), interfaces);

        expect(brIntPorts.map((p) => p.name)).toEqual(['ovn-k8s-mp3']);
        expect(brIntPorts[0].ipv4?.address?.[0].ip).toBe('10.1.2.2');
    });

    it('is the only VRF, and the localnet CUDNs produce none', () => {
        expect(interfaces.filter((i) => i.type === 'vrf')).toHaveLength(1);
        expect(cudns.filter((c) => c.spec?.network?.topology === 'Localnet')).toHaveLength(3);
    });
});

describe('localnet CUDNs and bridge mappings', () => {
    it('maps each localnet to its bridge', () => {
        expect(bridgeMappings).toEqual([
            { bridge: 'br-ex', localnet: 'physnet' },
            { bridge: 'br-vmdata', localnet: 'physnet-vmdata' }
        ]);
    });

    it('resolves every localnet CUDN to a mapping present on this node', () => {
        const localnets = new Set(bridgeMappings.map((m) => m.localnet));

        cudns
            .filter((c) => c.spec?.network?.topology === 'Localnet')
            .forEach((cudn) => {
                const physical = cudn.spec?.network?.localnet?.physicalNetworkName
                    ?? cudn.spec?.network?.localNet?.physicalNetworkName;
                expect(localnets.has(physical as string)).toBe(true);
            });
    });

    it('carries two CUDNs sharing one physical network, distinguished by VLAN', () => {
        const onVmdata = cudns.filter((c) =>
            c.spec?.network?.localnet?.physicalNetworkName === 'physnet-vmdata');

        expect(onVmdata.map((c) => c.metadata?.name).sort()).toEqual(['vlan-1924', 'vlan-1926']);
        expect(onVmdata.map((c) => c.spec?.network?.localnet?.vlan?.access?.id).sort())
            .toEqual([1924, 1926]);
    });
});

describe('attachment namespaces scraped from CUDN status', () => {
    it('extracts namespaces from the NetworkCreated condition message', () => {
        const primary = cudns.find((c) => c.metadata?.name === 'example-p-cudn')!;
        expect(getCudnAssociatedNamespaces(primary)).toEqual(['demo-vm-primary-udn']);
    });

    it('returns an empty list for a CUDN attached nowhere', () => {
        // vlan-1926's message ends in "[]" -- the empty-bracket case the regex must not
        // turn into a single empty-string namespace.
        const unattached = cudns.find((c) => c.metadata?.name === 'vlan-1926')!;
        expect(getCudnAssociatedNamespaces(unattached)).toEqual([]);
    });
});

describe('interfaces that fall outside the lanes', () => {
    it('has no LLDP data, so the LLDP toggle stays hidden', () => {
        expect(hasLldpNeighbors(interfaces)).toBe(false);
        expect(extractLldpNeighbors(interfaces)).toEqual([]);
    });

    it('includes the tail types that land in the catch-all', () => {
        const types = new Set(interfaces.map((i) => i.type));
        expect(types.has('veth')).toBe(true);
        expect(types.has('loopback')).toBe(true);
        // The geneve tunnel reports as 'unknown' -- exactly the case a role table has
        // to give an explicit home rather than a negation. See ovn-recon-s3t.8.
        expect(interfaces.find((i) => i.name.startsWith('genev_sys_'))?.type).toBe('unknown');
    });

    it('marks the ignored OVN plumbing as such', () => {
        const ignored = interfaces.filter((i) => i.state === 'ignore').map((i) => i.name);
        expect(ignored).toContain('br-int');
        expect(ignored.filter((n) => n.startsWith('patch-'))).toHaveLength(4);
    });
});
