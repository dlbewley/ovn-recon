import type { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import type { ClusterUserDefinedNetwork, NetworkAttachmentDefinition, UserDefinedNetwork } from '../types';
import { buildMasqueradeLayout, masqueradeCapacity } from './masqueradeLayoutModel';

/**
 * The masquerade subnet's capacity and address layout (ovn-recon-n7r.4), over the
 * masquerade model of ovn-recon-2n6.1.
 */

const node = (name: string, subnets?: Record<string, string>): K8sResourceCommon => ({
    metadata: {
        name,
        annotations: subnets ? { 'k8s.ovn.org/node-masquerade-subnet': JSON.stringify(subnets) } : {},
    },
});

const nad = (namespace: string, name: string, networkName: string, networkId: string, role = 'primary'): NetworkAttachmentDefinition => ({
    apiVersion: 'k8s.cni.cncf.io/v1',
    kind: 'NetworkAttachmentDefinition',
    metadata: { namespace, name, annotations: { 'k8s.ovn.org/network-id': networkId } },
    spec: { config: JSON.stringify({ name: networkName, role, topology: 'layer2', type: 'ovn-k8s-cni-overlay' }) },
});

const cudn = (name: string) => ({ metadata: { name } }) as ClusterUserDefinedNetwork;
const udn = (namespace: string, name: string) => ({ metadata: { namespace, name } }) as UserDefinedNetwork;

const networks = {
    cudns: [cudn('blue')],
    udns: [udn('tenant-c', 'red')],
    nads: [
        nad('default', 'cluster-default', 'ovn-kubernetes', '0'),
        nad('tenant-a', 'blue', 'cluster_udn_blue', '3'),
        nad('tenant-b', 'blue', 'cluster_udn_blue', '3'),
        nad('tenant-c', 'red', 'tenant-c_red', '4'),
        nad('tenant-e', 'storage', 'tenant-e_storage', '7', 'secondary'),
    ],
};

const V4 = { ipv4: true, ipv6: false };
const DUAL = { ipv4: true, ipv6: true };

describe('masqueradeCapacity', () => {
    it('is the highest network ID with a pair', () => {
        expect(masqueradeCapacity('169.254.0.0/17')).toEqual({ capacity: 16378, unbounded: false });
        expect(masqueradeCapacity('fd69::/112')).toEqual({ capacity: 32762, unbounded: false });
        expect(masqueradeCapacity('100.254.0.0/24')).toEqual({ capacity: 122, unbounded: false });
    });

    it('is nothing for the legacy subnets', () => {
        expect(masqueradeCapacity('169.254.169.0/29').capacity).toBe(0);
        expect(masqueradeCapacity('fd69::/125').capacity).toBe(0);
    });

    it('does not count what cannot be counted', () => {
        expect(masqueradeCapacity('fd69::/64').unbounded).toBe(true);
    });
});

describe('buildMasqueradeLayout', () => {
    it('draws the default /17 when no node reports a subnet', () => {
        const layout = buildMasqueradeLayout({ families: V4, ...networks });
        expect(layout.families).toHaveLength(1);
        const [family] = layout.families;
        expect(family).toMatchObject({ family: 4, name: 'IPv4', disagree: false });
        expect(family.notes.map((note) => note.id)).toEqual(['no-node-report']);
        const [subnet] = family.subnets;
        expect(subnet).toMatchObject({
            cidr: '169.254.0.0/17',
            source: 'default',
            sourceText: 'Platform default',
            nodes: 0,
            capacity: 16378,
            capacityText: 'Room for network IDs 1 to 16378',
            firstPair: { gatewayRouter: '169.254.0.11', managementPort: '169.254.0.12' },
            notes: [],
        });
        expect(subnet.globals).toEqual([
            { address: '169.254.0.1', label: 'OVN masquerade' },
            { address: '169.254.0.2', label: 'Host masquerade' },
            { address: '169.254.0.3', label: 'Host masquerade for externalTrafficPolicy=Local' },
            { address: '169.254.0.4', label: 'Dummy next hop' },
            { address: '169.254.0.5', label: 'OVN service hairpin masquerade' },
        ]);
    });

    it('lists the primary networks with their pairs and where they live', () => {
        const layout = buildMasqueradeLayout({ families: V4, ...networks });
        expect(layout.families[0].subnets[0].networks).toEqual([
            {
                networkId: 3,
                label: 'CUDN blue',
                target: { kind: 'cudn', name: 'blue' },
                gatewayRouter: '169.254.0.15',
                managementPort: '169.254.0.16',
            },
            {
                networkId: 4,
                label: 'UDN tenant-c/red',
                target: { kind: 'udn', namespace: 'tenant-c', name: 'red' },
                gatewayRouter: '169.254.0.17',
                managementPort: '169.254.0.18',
            },
        ]);
    });

    it('counts every network ID, and the highest, not only the primary ones', () => {
        const layout = buildMasqueradeLayout({ families: V4, ...networks });
        expect(layout.networkIds).toEqual([3, 4, 7]);
        expect(layout.primaryNetworkIds).toEqual([3, 4]);
        expect(layout.highestNetworkId).toBe(7);
        expect(layout.usageText).toBe('3 network IDs in use (highest 7), 2 by primary networks, which hold a pair each');
        expect(layout.userDefinedNetworks).toBe(2);
        expect(layout.immutableText).toContain('and 2 exist');
    });

    it('says so when nothing is in use', () => {
        const layout = buildMasqueradeLayout({ families: V4 });
        expect(layout.networkIds).toEqual([]);
        expect(layout.highestNetworkId).toBeUndefined();
        expect(layout.usageText).toContain('No network ID is in use');
        expect(layout.immutableText).toContain('none exists yet');
        expect(layout.families[0].subnets[0].networks).toEqual([]);
    });

    it('reads a custom subnet from the nodes', () => {
        const layout = buildMasqueradeLayout({
            families: V4,
            nodes: [node('a', { ipv4: '100.254.0.0/24' }), node('b', { ipv4: '100.254.0.0/24' }), node('c')],
            ...networks,
        });
        const [family] = layout.families;
        expect(family.notes.map((note) => note.id)).toEqual(['not-in-spec']);
        expect(family.subnets).toHaveLength(1);
        expect(family.subnets[0]).toMatchObject({
            cidr: '100.254.0.0/24',
            source: 'node-annotation',
            sourcePath: 'k8s.ovn.org/node-masquerade-subnet',
            nodes: 2,
            capacity: 122,
        });
        expect(family.subnets[0].networks[0]).toMatchObject({ gatewayRouter: '100.254.0.15', managementPort: '100.254.0.16' });
    });

    it('takes the operator configuration when no node reports, and compares it when one does', () => {
        const configured = { ipv4: '100.254.0.0/24' };
        const fromSpec = buildMasqueradeLayout({ families: V4, configured });
        expect(fromSpec.families[0].subnets[0]).toMatchObject({
            cidr: '100.254.0.0/24',
            source: 'spec',
            sourcePath: 'spec.defaultNetwork.ovnKubernetesConfig.gatewayConfig.ipv4.internalMasqueradeSubnet',
        });
        expect(fromSpec.families[0].notes).toEqual([]);

        const agreeing = buildMasqueradeLayout({ families: V4, configured, nodes: [node('a', { ipv4: '100.254.0.0/24' })] });
        expect(agreeing.families[0].subnets[0].source).toBe('node-annotation');
        expect(agreeing.families[0].notes.map((note) => note.id)).toEqual(['matches-spec']);

        const differing = buildMasqueradeLayout({ families: V4, configured, nodes: [node('a', { ipv4: '169.254.0.0/17' })] });
        expect(differing.families[0].subnets[0].cidr).toBe('169.254.0.0/17');
        expect(differing.families[0].notes).toEqual([
            { id: 'differs-from-spec', severity: 'warning', text: 'The operator configuration names 100.254.0.0/24, which no node reports.' },
        ]);
    });

    it('holds no network at all in the legacy /29', () => {
        const nodes = [node('a', { ipv4: '169.254.169.0/29' })];
        const empty = buildMasqueradeLayout({ families: V4, nodes });
        const [subnet] = empty.families[0].subnets;
        expect(subnet).toMatchObject({ capacity: 0, capacityText: 'No room for any network' });
        expect(subnet.firstPair).toBeUndefined();
        expect(subnet.globals.map((global) => global.address)).toEqual([
            '169.254.169.1', '169.254.169.2', '169.254.169.3', '169.254.169.4', '169.254.169.5',
        ]);
        expect(subnet.notes).toEqual([{
            id: 'too-small',
            severity: 'info',
            text: 'Too small for any network: it holds the global addresses only, so a primary user-defined network cannot work on it.',
        }]);

        const used = buildMasqueradeLayout({ families: V4, nodes, ...networks });
        expect(used.families[0].subnets[0].notes[0]).toMatchObject({ id: 'too-small', severity: 'warning' });
        expect(used.families[0].subnets[0].notes[0].text).toContain('and 2 primary networks exist');
        expect(used.families[0].subnets[0].networks[0]).toEqual({ networkId: 3, label: 'CUDN blue', target: { kind: 'cudn', name: 'blue' } });
    });

    it('names the network IDs a subnet has no room for', () => {
        const layout = buildMasqueradeLayout({
            families: V4,
            nodes: [node('a', { ipv4: '100.254.0.0/27' })],
            nads: [nad('tenant-a', 'blue', 'tenant-a_blue', '3'), nad('tenant-b', 'far', 'tenant-b_far', '40')],
        });
        const [subnet] = layout.families[0].subnets;
        expect(subnet.capacity).toBe(10);
        expect(subnet.notes).toEqual([{
            id: 'over-capacity',
            severity: 'warning',
            text: 'No room for network ID 40: the subnet has pairs for IDs up to 10.',
        }]);
        expect(subnet.networks.map((network) => [network.networkId, network.gatewayRouter])).toEqual([[3, '100.254.0.15'], [40, undefined]]);
        // No CUDN or UDN is visible, so the NAD carrying the ID is the link.
        expect(subnet.networks[0]).toMatchObject({ label: 'NAD tenant-a/blue', target: { kind: 'nad', namespace: 'tenant-a', name: 'blue' } });
    });

    it('lays out both families of a dual-stack cluster', () => {
        const layout = buildMasqueradeLayout({
            families: DUAL,
            nodes: [node('a', { ipv4: '169.254.0.0/17', ipv6: 'fd69::/112' })],
            ...networks,
        });
        expect(layout.families.map((family) => [family.name, family.subnets[0].cidr, family.subnets[0].capacity])).toEqual([
            ['IPv4', '169.254.0.0/17', 16378],
            ['IPv6', 'fd69::/112', 32762],
        ]);
        expect(layout.families[1].subnets[0].networks[0]).toMatchObject({ gatewayRouter: 'fd69::f', managementPort: 'fd69::10' });
        expect(layout.families[1].subnets[0].globals[0]).toEqual({ address: 'fd69::1', label: 'OVN masquerade' });
    });

    it('leaves out a family the cluster does not have', () => {
        expect(buildMasqueradeLayout({ families: V4 }).families.map((family) => family.name)).toEqual(['IPv4']);
        expect(buildMasqueradeLayout({ families: { ipv4: false, ipv6: true } }).families.map((family) => family.name)).toEqual(['IPv6']);
    });

    it('draws only what the nodes report when the families are unknown', () => {
        expect(buildMasqueradeLayout({}).families).toEqual([]);
        expect(buildMasqueradeLayout({ nodes: [node('a', { ipv4: '169.254.0.0/17' })] }).families.map((family) => family.name)).toEqual(['IPv4']);
    });

    it('flags nodes that disagree, and lays out each subnet', () => {
        const layout = buildMasqueradeLayout({
            families: V4,
            nodes: [
                node('a', { ipv4: '169.254.0.0/17' }),
                node('b', { ipv4: '169.254.0.0/17' }),
                node('c', { ipv4: '169.254.169.0/29' }),
            ],
            ...networks,
        });
        const [family] = layout.families;
        expect(family.disagree).toBe(true);
        expect(family.subnets.map((subnet) => [subnet.cidr, subnet.nodes, subnet.capacity])).toEqual([
            ['169.254.0.0/17', 2, 16378],
            ['169.254.169.0/29', 1, 0],
        ]);
        expect(family.notes[0]).toEqual({
            id: 'nodes-disagree',
            severity: 'warning',
            text: 'Nodes disagree: 169.254.0.0/17 on 2 nodes, 169.254.169.0/29 on 1 node.',
        });
    });

    it('does not pick a network for an ID two claim', () => {
        const layout = buildMasqueradeLayout({
            families: V4,
            cudns: [cudn('green')],
            udns: [udn('tenant-d', 'purple')],
            nads: [nad('tenant-x', 'green', 'cluster_udn_green', '5'), nad('tenant-d', 'purple', 'tenant-d_purple', '5')],
        });
        const [row] = layout.families[0].subnets[0].networks;
        expect(row.target).toBeUndefined();
        expect(row.label).toBe('Claimed by CUDN green, UDN tenant-d/purple');
        expect(row.gatewayRouter).toBe('169.254.0.19');
    });
});
