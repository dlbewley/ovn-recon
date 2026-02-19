import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';

import { Interface, NodeNetworkState } from '../types';
import { extractLldpNeighbors, getVrfConnectionInfo, getVrfRoutesForInterface, hasLldpNeighbors } from './nodeVisualizationSelectors';

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

    it('reports LLDP availability only when at least one interface has neighbors', () => {
        const lldpNns = loadFixture('host-lldp');
        const basicNns = loadFixture('basic-host');

        expect(hasLldpNeighbors(lldpNns.status?.currentState?.interfaces || [])).toBe(true);
        expect(hasLldpNeighbors(basicNns.status?.currentState?.interfaces || [])).toBe(false);
    });
});
