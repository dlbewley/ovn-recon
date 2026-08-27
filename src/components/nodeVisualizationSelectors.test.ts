import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';

import { Interface, NodeNetworkState } from '../types';
import {
    extractLldpNeighbors,
    formatLabelSelector,
    getIpv4Addresses,
    getVrfConnectionInfo,
    getVrfRoutesForInterface,
    hasLldpNeighbors
} from './nodeVisualizationSelectors';

const loadFixture = (name: string): NodeNetworkState => {
    const fixturePath = path.join(process.cwd(), 'test', 'fixtures', 'nns', `${name}.json`);
    const fixtureContent = fs.readFileSync(fixturePath, 'utf-8');
    try {
        return JSON.parse(fixtureContent) as NodeNetworkState;
    } catch {
        return yaml.load(fixtureContent) as NodeNetworkState;
    }
};

const findInterfaceByName = (nns: NodeNetworkState, name: string): Interface => {
    const iface = nns.status?.currentState?.interfaces?.find((candidate) => candidate.name === name);
    if (!iface) {
        throw new Error(`interface ${name} not found`);
    }
    return iface;
};

describe('nodeVisualizationSelectors fixture coverage', () => {
    it('extracts only VRF ports that are attached to br-int', () => {
        const nns = loadFixture('vrf-mixed-routes');
        const vrf = findInterfaceByName(nns, 'vrf-blue');
        const interfaces = nns.status?.currentState?.interfaces || [];

        const connectionInfo = getVrfConnectionInfo(vrf, interfaces);

        expect(connectionInfo.brIntPorts.map((port) => port.name)).toEqual(['ovn-k8s-mp0', 'ovn-k8s-mp1']);
    });

    it('associates routes by table id and next-hop interface while deduping duplicates', () => {
        const nns = loadFixture('vrf-mixed-routes');
        const vrf = findInterfaceByName(nns, 'vrf-blue');

        const routes = getVrfRoutesForInterface(vrf, nns);

        expect(routes).toHaveLength(2);
        expect(routes.map((route) => route.destination).sort()).toEqual(['10.128.0.0/14', '172.30.0.0/16']);
        expect(routes.find((route) => route.destination === '172.30.0.0/16')?.nextHopInterface).toBe('ovn-k8s-mp1');
        expect(routes.every((route) => route.destination !== '198.51.100.0/24')).toBe(true);
    });

    it('accepts dotted route keys and ignores partial route entries without destination', () => {
        const nns = loadFixture('partial-missing-fields');
        const vrf = findInterfaceByName(nns, 'vrf-edge');

        const routes = getVrfRoutesForInterface(vrf, nns);

        expect(routes).toHaveLength(1);
        expect(routes[0]).toMatchObject({
            destination: '203.0.113.0/24',
            nextHopInterface: 'ovn-k8s-mp2'
        });
    });

    it('extracts LLDP neighbors from interfaces and normalizes key fields', () => {
        const nns = loadFixture('host-lldp');
        const interfaces = nns.status?.currentState?.interfaces || [];

        const neighbors = extractLldpNeighbors(interfaces);

        expect(neighbors).toHaveLength(2);
        expect(neighbors.map((neighbor) => neighbor.localInterface).sort()).toEqual(['enp44s0', 'enp45s0']);
        expect(neighbors[0]).toMatchObject({
            label: 'USWEnterprise48PoE',
            systemName: 'USWEnterprise48PoE',
            chassisId: '28:70:4E:D4:53:B0'
        });
        expect(neighbors[0].capabilities).toEqual(['MAC Bridge component', 'Router']);
    });

    it('reports LLDP availability when interfaces include enabled LLDP and neighbors data', () => {
        const lldpNns = loadFixture('host-lldp');
        const basicNns = loadFixture('basic-host');

        expect(hasLldpNeighbors(lldpNns.status?.currentState?.interfaces || [])).toBe(true);
        expect(hasLldpNeighbors(basicNns.status?.currentState?.interfaces || [])).toBe(false);
    });

    it('does not report LLDP availability when LLDP is enabled but no neighbors are present', () => {
        const interfaces: Interface[] = [
            {
                name: 'ens192',
                type: 'ethernet',
                state: 'up',
                lldp: {
                    enabled: true
                }
            }
        ];

        expect(hasLldpNeighbors(interfaces)).toBe(false);
    });

    it('reports LLDP availability when LLDP enabled and neighbors are present on different interfaces', () => {
        const interfaces: Interface[] = [
            {
                name: 'ens192',
                type: 'ethernet',
                state: 'up',
                lldp: {
                    enabled: true
                }
            },
            {
                name: 'ens224',
                type: 'ethernet',
                state: 'up',
                lldp: {
                    enabled: false,
                    neighbors: [[{ 'system-name': 'switch-1', type: 5 }]]
                }
            }
        ];

        expect(hasLldpNeighbors(interfaces)).toBe(true);
    });
});

describe('getIpv4Addresses', () => {
    it('reads the hyphenated spelling nmstate actually emits', () => {
        expect(getIpv4Addresses({ ipv4: { address: [{ ip: '192.0.2.72', 'prefix-length': 24 }] } }))
            .toEqual(['192.0.2.72/24']);
    });

    it('reads the underscored spelling too', () => {
        // Regression: the interface Details panel read only prefix_length, so a real
        // capture rendered "192.0.2.72/undefined".
        expect(getIpv4Addresses({ ipv4: { address: [{ ip: '192.0.2.72', prefix_length: 24 }] } }))
            .toEqual(['192.0.2.72/24']);
    });

    it('returns every address, not just the first', () => {
        expect(getIpv4Addresses({ ipv4: { address: [
            { ip: '192.0.2.72', 'prefix-length': 24 },
            { ip: '169.254.0.2', 'prefix-length': 17 }
        ] } })).toEqual(['192.0.2.72/24', '169.254.0.2/17']);
    });

    it('degrades gracefully on missing or malformed input', () => {
        expect(getIpv4Addresses(undefined)).toEqual([]);
        expect(getIpv4Addresses({})).toEqual([]);
        expect(getIpv4Addresses({ ipv4: { address: [] } })).toEqual([]);
        expect(getIpv4Addresses({ ipv4: { address: [{ ip: '10.0.0.1' }] } })).toEqual(['10.0.0.1']);
    });
});

describe('formatLabelSelector', () => {
    it('renders matchLabels in kubectl form, empty values included', () => {
        expect(formatLabelSelector({ matchLabels: { 'network/machine': '' } }))
            .toBe('network/machine=');
        expect(formatLabelSelector({ matchLabels: { tier: 'web', env: 'prod' } }))
            .toBe('tier=web, env=prod');
    });

    it('renders each matchExpressions operator', () => {
        expect(formatLabelSelector({
            matchExpressions: [
                { key: 'tier', operator: 'In', values: ['web', 'api'] },
                { key: 'env', operator: 'NotIn', values: ['dev'] },
                { key: 'owned', operator: 'Exists' },
                { key: 'legacy', operator: 'DoesNotExist' }
            ]
        })).toBe('tier in (web, api), env notin (dev), owned, !legacy');
    });

    it('combines labels and expressions, and is empty for an empty selector', () => {
        expect(formatLabelSelector({
            matchLabels: { app: 'vm' },
            matchExpressions: [{ key: 'tier', operator: 'In', values: ['web'] }]
        })).toBe('app=vm, tier in (web)');
        expect(formatLabelSelector({})).toBe('');
        expect(formatLabelSelector(undefined)).toBe('');
    });
});
