import type { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';
import type {
    ClusterUserDefinedNetwork,
    LogicalDatabase,
    NetworkAttachmentDefinition,
    UserDefinedNetwork,
} from '../types';
import {
    classifyMasqueradeAddress,
    DEFAULT_MASQUERADE_SUBNETS,
    globalMasqueradeAddresses,
    masqueradeIpsForNetworkId,
    masqueradeRouteSubnets,
    masqueradeSubnets,
    nodeMasqueradeSubnets,
    ovnNetworkNameOf,
    primaryNetworkIds,
    resolveMasqueradeNetwork,
} from './masqueradeIps';

const node = (name: string, subnets?: Record<string, string> | string): K8sResourceCommon => ({
    metadata: {
        name,
        annotations: subnets === undefined
            ? {}
            : { 'k8s.ovn.org/node-masquerade-subnet': typeof subnets === 'string' ? subnets : JSON.stringify(subnets) },
    },
});

const nad = (
    namespace: string,
    name: string,
    networkName: string,
    networkId: string | undefined,
    role = 'primary',
): NetworkAttachmentDefinition => ({
    apiVersion: 'k8s.cni.cncf.io/v1',
    kind: 'NetworkAttachmentDefinition',
    metadata: {
        namespace,
        name,
        annotations: networkId === undefined ? {} : { 'k8s.ovn.org/network-id': networkId },
    },
    spec: { config: JSON.stringify({ name: networkName, role, topology: 'layer2', type: 'ovn-k8s-cni-overlay' }) },
} as NetworkAttachmentDefinition);

const cudn = (name: string) => ({ metadata: { name } }) as ClusterUserDefinedNetwork;
const udn = (namespace: string, name: string) => ({ metadata: { namespace, name } }) as UserDefinedNetwork;

describe('masqueradeSubnets', () => {
    it('falls back to the defaults with nothing to read', () => {
        expect(masqueradeSubnets().map((subnet) => [subnet.cidr, subnet.source])).toEqual([
            ['169.254.0.0/17', 'default'],
            ['fd69::/112', 'default'],
        ]);
    });

    it('reads the Node annotation, family by family', () => {
        const subnets = masqueradeSubnets({ nodes: [node('a', { ipv4: '100.254.0.0/16' })] });
        expect(subnets.map((subnet) => [subnet.cidr, subnet.source])).toEqual([
            ['100.254.0.0/16', 'node-annotation'],
            ['fd69::/112', 'default'],
        ]);
    });

    it('keeps each subnet nodes disagree on, once', () => {
        const subnets = masqueradeSubnets({
            nodes: [
                node('a', { ipv4: '169.254.0.0/17', ipv6: 'fd69::/112' }),
                node('b', { ipv4: '169.254.0.0/17', ipv6: 'fd69::/112' }),
                node('c', { ipv4: '100.254.0.0/16' }),
            ],
        });
        expect(subnets.map((subnet) => subnet.cidr)).toEqual(['169.254.0.0/17', '100.254.0.0/16', 'fd69::/112']);
    });

    it('ignores an annotation it cannot read', () => {
        expect(nodeMasqueradeSubnets(node('a', 'not json'))).toEqual([]);
        expect(nodeMasqueradeSubnets(node('a', { ipv4: 'nonsense' }))).toEqual([]);
        expect(nodeMasqueradeSubnets(node('a'))).toEqual([]);
        expect(masqueradeSubnets({ nodes: [node('a', 'not json')] })[0].source).toBe('default');
    });

    it('reads the subnet off a gateway router\'s static route when no Node says', () => {
        const database = cnv1.database as unknown as LogicalDatabase;
        expect(masqueradeRouteSubnets(database)).toEqual(['169.254.0.0/17']);
        expect(masqueradeSubnets({ databases: [database] }).map((subnet) => [subnet.cidr, subnet.source])).toEqual([
            ['169.254.0.0/17', 'static-route'],
            ['fd69::/112', 'default'],
        ]);
    });
});

describe('classifyMasqueradeAddress in the default subnets', () => {
    const roleOf = (address: string) => classifyMasqueradeAddress(address, DEFAULT_MASQUERADE_SUBNETS);

    it('names the global roles at offsets 1 to 5, IPv4 and IPv6', () => {
        const roles = ['ovn', 'host', 'host-etp-local', 'dummy-next-hop', 'service-hairpin'];
        expect([1, 2, 3, 4, 5].map((n) => roleOf(`169.254.0.${n}`)?.role)).toEqual(roles);
        expect([1, 2, 3, 4, 5].map((n) => roleOf(`fd69::${n}`)?.role)).toEqual(roles);
        expect(roleOf('169.254.0.2')).toEqual({ role: 'host', offset: 2, subnet: '169.254.0.0/17', family: 4 });
    });

    it('keeps 6 to 10 reserved', () => {
        for (const n of [6, 7, 8, 9, 10]) {
            expect(roleOf(`169.254.0.${n}`)).toMatchObject({ role: 'reserved' });
            expect(roleOf(`fd69::${n.toString(16)}`)).toMatchObject({ role: 'reserved' });
        }
        expect(roleOf('169.254.0.10')?.networkId).toBeUndefined();
    });

    it('reads a network\'s pair from 11 on', () => {
        expect(roleOf('169.254.0.11')).toMatchObject({ role: 'udn-gateway-router', networkId: 1 });
        expect(roleOf('169.254.0.12')).toMatchObject({ role: 'udn-management-port', networkId: 1 });
        expect(roleOf('169.254.0.15')).toMatchObject({ role: 'udn-gateway-router', networkId: 3, offset: 15 });
        expect(roleOf('169.254.0.16')).toMatchObject({ role: 'udn-management-port', networkId: 3 });
        expect(roleOf('169.254.1.1')).toMatchObject({ role: 'udn-gateway-router', networkId: 124 });
        expect(roleOf('fd69::f')).toMatchObject({ role: 'udn-gateway-router', networkId: 3, family: 6 });
        expect(roleOf('fd69::10')).toMatchObject({ role: 'udn-management-port', networkId: 3, subnet: 'fd69::/112' });
    });

    it('reads the address beside a mask, in any IPv6 spelling', () => {
        expect(roleOf('169.254.0.15/17')).toMatchObject({ role: 'udn-gateway-router', networkId: 3 });
        expect(roleOf('FD69:0:0:0:0:0:0:000F')).toMatchObject({ role: 'udn-gateway-router', networkId: 3 });
    });

    it('says nothing outside the subnet, for its base, or for IPv4 broadcast', () => {
        expect(roleOf('169.254.128.1')).toBeUndefined();
        expect(roleOf('10.128.0.1')).toBeUndefined();
        expect(roleOf('fd70::1')).toBeUndefined();
        expect(roleOf('169.254.0.0')).toBeUndefined();
        expect(roleOf('169.254.0.0/17')).toBeUndefined();
        expect(roleOf('fd69::')).toBeUndefined();
        expect(roleOf('169.254.127.255')).toBeUndefined();
        expect(roleOf('not an address')).toBeUndefined();
    });

    it('stops where the last pair no longer fits', () => {
        // IPv4: the last pair ends just before broadcast.
        expect(roleOf('169.254.127.253')).toMatchObject({ role: 'udn-gateway-router', networkId: 16378 });
        expect(roleOf('169.254.127.254')).toMatchObject({ role: 'udn-management-port', networkId: 16378 });
        // IPv6: fd69::ffff would be a gateway router whose management port falls outside.
        expect(roleOf('fd69::fffe')).toMatchObject({ role: 'udn-management-port', networkId: 32762 });
        expect(roleOf('fd69::ffff')).toBeUndefined();
    });
});

describe('classifyMasqueradeAddress in other subnets', () => {
    it('applies the same offsets to a custom subnet', () => {
        const custom = ['100.254.0.0/16', 'fd99::/64'];
        expect(classifyMasqueradeAddress('100.254.0.2', custom)).toMatchObject({ role: 'host', subnet: '100.254.0.0/16' });
        expect(classifyMasqueradeAddress('100.254.0.15', custom)).toMatchObject({ role: 'udn-gateway-router', networkId: 3 });
        expect(classifyMasqueradeAddress('fd99::10', custom)).toMatchObject({ role: 'udn-management-port', networkId: 3 });
        // The default subnet is not the masquerade subnet here.
        expect(classifyMasqueradeAddress('169.254.0.15', custom)).toBeUndefined();
    });

    it('holds only the global roles in the legacy /29 and /125', () => {
        const legacy = ['169.254.169.0/29', 'fd69::/125'];
        expect(classifyMasqueradeAddress('169.254.169.1', legacy)).toMatchObject({ role: 'ovn' });
        expect(classifyMasqueradeAddress('169.254.169.5', legacy)).toMatchObject({ role: 'service-hairpin' });
        expect(classifyMasqueradeAddress('169.254.169.6', legacy)).toMatchObject({ role: 'reserved' });
        expect(classifyMasqueradeAddress('169.254.169.7', legacy)).toBeUndefined();
        expect(classifyMasqueradeAddress('fd69::7', legacy)).toMatchObject({ role: 'reserved' });
        expect(classifyMasqueradeAddress('fd69::8', legacy)).toBeUndefined();
    });

    it('takes parsed subnets as well as CIDR text', () => {
        const subnets = masqueradeSubnets({ nodes: [node('a', { ipv4: '100.254.0.0/16' })] });
        expect(classifyMasqueradeAddress('100.254.0.16', subnets)).toMatchObject({ role: 'udn-management-port', networkId: 3 });
    });
});

describe('masqueradeIpsForNetworkId', () => {
    it('gives the pair in each default subnet', () => {
        expect(masqueradeIpsForNetworkId(3)).toEqual([
            { networkId: 3, family: 4, subnet: '169.254.0.0/17', gatewayRouter: '169.254.0.15', managementPort: '169.254.0.16' },
            { networkId: 3, family: 6, subnet: 'fd69::/112', gatewayRouter: 'fd69::f', managementPort: 'fd69::10' },
        ]);
        expect(masqueradeIpsForNetworkId(1, ['169.254.0.0/17']).map((pair) => [pair.gatewayRouter, pair.managementPort]))
            .toEqual([['169.254.0.11', '169.254.0.12']]);
    });

    it('gives the pair in a custom subnet', () => {
        expect(masqueradeIpsForNetworkId(200, ['100.254.0.0/16'])).toEqual([{
            networkId: 200,
            family: 4,
            subnet: '100.254.0.0/16',
            gatewayRouter: '100.254.1.153',
            managementPort: '100.254.1.154',
        }]);
    });

    it('gives nothing in the legacy /29 and /125', () => {
        expect(masqueradeIpsForNetworkId(1, ['169.254.169.0/29', 'fd69::/125'])).toEqual([]);
    });

    it('gives nothing for an ID out of range', () => {
        for (const id of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
            expect(masqueradeIpsForNetworkId(id)).toEqual([]);
        }
        // The last ID that fits the /17 still has its pair; the next has none there.
        expect(masqueradeIpsForNetworkId(16378, ['169.254.0.0/17'])[0].managementPort).toBe('169.254.127.254');
        expect(masqueradeIpsForNetworkId(16379, ['169.254.0.0/17'])).toEqual([]);
        // IPv6's /112 holds more than IPv4's /17.
        expect(masqueradeIpsForNetworkId(16379).map((pair) => pair.family)).toEqual([6]);
    });

    it('agrees with classifyMasqueradeAddress', () => {
        for (const id of [1, 2, 3, 77, 16378]) {
            for (const pair of masqueradeIpsForNetworkId(id)) {
                expect(classifyMasqueradeAddress(pair.gatewayRouter)).toMatchObject({ role: 'udn-gateway-router', networkId: id });
                expect(classifyMasqueradeAddress(pair.managementPort)).toMatchObject({ role: 'udn-management-port', networkId: id });
            }
        }
    });
});

describe('globalMasqueradeAddresses', () => {
    it('lists offsets 1 to 5 of each subnet', () => {
        expect(globalMasqueradeAddresses().map(({ address, role }) => `${address} ${role}`)).toEqual([
            '169.254.0.1 ovn',
            '169.254.0.2 host',
            '169.254.0.3 host-etp-local',
            '169.254.0.4 dummy-next-hop',
            '169.254.0.5 service-hairpin',
            'fd69::1 ovn',
            'fd69::2 host',
            'fd69::3 host-etp-local',
            'fd69::4 dummy-next-hop',
            'fd69::5 service-hairpin',
        ]);
    });
});

describe('the network behind a network ID', () => {
    const networks = {
        cudns: [cudn('blue'), cudn('green')],
        udns: [udn('tenant-c', 'red'), udn('tenant-d', 'purple')],
        nads: [
            // A CUDN has a NAD per namespace, all with its one ID.
            nad('tenant-a', 'blue', 'cluster_udn_blue', '3'),
            nad('tenant-b', 'blue', 'cluster_udn_blue', '3'),
            nad('tenant-c', 'red', 'tenant-c_red', '4'),
            // Two networks claiming one ID.
            nad('tenant-e', 'green', 'cluster_udn_green', '5'),
            nad('tenant-d', 'purple', 'tenant-d_purple', '5'),
            nad('tenant-f', 'secondary', 'tenant-f_secondary', '6', 'secondary'),
            nad('tenant-g', 'no-id', 'tenant-g_no-id', undefined),
        ],
    };

    it('names a CUDN and a UDN', () => {
        expect(resolveMasqueradeNetwork(3, networks)).toEqual({
            networkId: 3,
            network: { kind: 'cudn', name: 'blue' },
            ovnNetwork: 'cluster_udn_blue',
            nad: { namespace: 'tenant-a', name: 'blue' },
        });
        expect(resolveMasqueradeNetwork(4, networks)).toMatchObject({
            network: { kind: 'udn', namespace: 'tenant-c', name: 'red' },
            ovnNetwork: 'tenant-c_red',
        });
    });

    it('keeps an ID two networks claim ambiguous', () => {
        expect(resolveMasqueradeNetwork(5, networks)).toEqual({
            networkId: 5,
            ambiguous: ['CUDN green', 'UDN tenant-d/purple'],
        });
    });

    it('names nothing for an ID no NAD carries', () => {
        expect(resolveMasqueradeNetwork(42, networks)).toEqual({ networkId: 42 });
        expect(resolveMasqueradeNetwork(3, {})).toEqual({ networkId: 3 });
    });

    it('lists the IDs of primary networks only', () => {
        expect(primaryNetworkIds(networks.nads)).toEqual([3, 4, 5]);
        expect(primaryNetworkIds()).toEqual([]);
    });

    it('spells the OVN network identity', () => {
        expect(ovnNetworkNameOf({ kind: 'cudn', name: 'blue' })).toBe('cluster_udn_blue');
        expect(ovnNetworkNameOf({ kind: 'udn', namespace: 'tenant-c', name: 'red' })).toBe('tenant-c_red');
    });
});
