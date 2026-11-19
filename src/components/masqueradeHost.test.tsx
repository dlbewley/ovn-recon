import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

import { buildGraphContext, GraphContext, GraphContextInput } from '../topology/context';
import { descriptorFor, NodeTypeId } from '../topology/descriptors';
import { nodeKindRegistry } from '../topology/registry';
import { Fact, FactItem } from '../topology/types';
import { buildNodeViewModel } from '../topology/viewModel';
import type {
    ClusterUserDefinedNetwork, Interface, NetworkAttachmentDefinition, NodeNetworkState
} from '../types';
import { KernelRouteTable } from './KernelRouteTable';
import { describeMasqueradeAddress, MASQUERADE_SUBNET_HELP, vrfManagementPortRoutes } from './masqueradeHost';
import { masqueradeSubnets } from './masqueradeIps';
import {
    findPrimaryNetworkForVrf, getRunningRoutes, getVrfRoutesForInterface
} from './nodeVisualizationSelectors';
import { renderHook } from './testHookHarness';
import { routed } from './testRouter';
import { routeMasqueradeOwner, useNodeAddressOwners } from './useNodeAddressOwners';

/**
 * Masquerade addresses on a node's physical view and routes (ovn-recon-2n6.4).
 *
 * The node below is what a primary CUDN leaves behind: br-ex carries the host
 * masquerade address (offset 2), and the network's VRF routes its
 * management-port masquerade address (network ID 3: offset 16) to ovn-k8s-mp3
 * and the service CIDR via the dummy next hop (offset 4) from the host
 * masquerade address.
 */

const NODE = 'worker-a';

const ipv4 = (...addresses: Array<[string, number]>) => ({
    enabled: true,
    address: addresses.map(([ip, length]) => ({ ip, 'prefix-length': length })),
});

const interfaces = [
    { name: 'br-ex', type: 'ovs-bridge', state: 'up', bridge: { port: [{ name: 'ens3' }, { name: 'br-ex' }] } },
    { name: 'br-ex', type: 'ovs-interface', state: 'up', controller: 'br-ex', ipv4: ipv4(['192.0.2.10', 24], ['169.254.0.2', 17]) },
    { name: 'ens3', type: 'ethernet', state: 'up', controller: 'br-ex' },
    { name: 'blue', type: 'vrf', state: 'up', vrf: { port: ['ovn-k8s-mp3'], 'route-table-id': 1003 } },
    { name: 'ovn-k8s-mp3', type: 'ovs-interface', state: 'up', controller: 'br-int', ipv4: ipv4(['10.9.0.2', 16]) },
] as unknown as Interface[];

const nns = {
    apiVersion: 'nmstate.io/v1beta1',
    kind: 'NodeNetworkState',
    metadata: { name: NODE },
    status: {
        currentState: {
            interfaces,
            routes: {
                running: [
                    { destination: '169.254.0.1/32', 'next-hop-interface': 'br-ex', 'table-id': 254 },
                    { destination: '169.254.0.16/32', 'next-hop-interface': 'ovn-k8s-mp3', 'table-id': 1003 },
                    {
                        destination: '172.30.0.0/16', 'next-hop-address': '169.254.0.4',
                        'next-hop-interface': 'br-ex', 'table-id': 1003, source: '169.254.0.2',
                    },
                    { destination: '169.254.0.0/17', 'next-hop-interface': 'br-ex', 'table-id': 1003 },
                ],
            },
        },
    },
} as unknown as NodeNetworkState;

const primaryCudn = (name: string, subnet: string): ClusterUserDefinedNetwork => ({
    apiVersion: 'k8s.ovn.org/v1',
    kind: 'ClusterUserDefinedNetwork',
    metadata: { name },
    spec: { network: { topology: 'Layer2', layer2: { role: 'Primary', subnets: [subnet] } } },
}) as unknown as ClusterUserDefinedNetwork;

const nadFor = (cudn: string, networkId: number): NetworkAttachmentDefinition => ({
    apiVersion: 'k8s.cni.cncf.io/v1',
    kind: 'NetworkAttachmentDefinition',
    metadata: { namespace: 'team', name: cudn, annotations: { 'k8s.ovn.org/network-id': String(networkId) } },
    spec: {
        config: JSON.stringify({ name: `cluster_udn_${cudn}`, type: 'ovn-k8s-cni-overlay', role: 'primary' }),
    },
}) as unknown as NetworkAttachmentDefinition;

const cudns = [primaryCudn('blue', '10.9.0.0/16'), primaryCudn('red', '10.8.0.0/16')];
/** blue carries network ID 3, the ID the VRF's management-port route names. */
const agreeingNads = [nadFor('blue', 3), nadFor('red', 5)];
/** blue carries 5 and red 3: the route names red while the VRF's name says blue. */
const disagreeingNads = [nadFor('blue', 5), nadFor('red', 3)];

const vrf = interfaces.find((iface) => iface.name === 'blue')!;
const vrfRoutes = getVrfRoutesForInterface(vrf, nns);
const subnets = masqueradeSubnets();

const ctxWith = (input: Partial<GraphContextInput> = {}): GraphContext =>
    buildGraphContext({ nns, cudns, nads: agreeingNads, ...input });

const DESCRIPTORS: Record<string, NodeTypeId> = { vrf: 'vrf', 'ovs-bridge': 'bridge', 'ovs-interface': 'bridge-port' };
const factsOf = (ctx: GraphContext, name: string, type: string): Fact[] => {
    const raw = ctx.interfaces.find((iface) => iface.name === name && iface.type === type)!;
    const node = buildNodeViewModel(raw, descriptorFor(DESCRIPTORS[type])!, ctx);
    return nodeKindRegistry[node.kind].facts!(node, ctx);
};
const factNamed = (facts: Fact[], label: string): Fact | undefined => facts.find((fact) => fact.label === label);

describe('masquerade roles in words', () => {
    it('names the host masquerade address on br-ex', () => {
        expect(describeMasqueradeAddress('169.254.0.2/17', subnets))
            .toBe('Host masquerade: source for host-to-service traffic');
    });

    it('names the dummy next hop and a network\'s management port', () => {
        expect(describeMasqueradeAddress('169.254.0.4', subnets)).toMatch(/^Dummy next hop: /);
        expect(describeMasqueradeAddress('169.254.0.16/32', subnets))
            .toMatch(/^Management port masquerade of network ID 3: /);
    });

    it('says nothing outside the subnet, and follows the Node\'s annotation', () => {
        expect(describeMasqueradeAddress('192.0.2.10/24', subnets)).toBeUndefined();
        const moved = buildGraphContext({ nns, nodeMasqueradeSubnetAnnotation: '{"ipv4":"100.64.0.0/16"}' });
        expect(describeMasqueradeAddress('169.254.0.2', moved.masqueradeSubnets)).toBeUndefined();
        expect(describeMasqueradeAddress('100.64.0.2', moved.masqueradeSubnets)).toMatch(/^Host masquerade/);
    });
});

describe('br-ex in the drawer', () => {
    it('labels the masquerade address on the interface and keeps the node IP plain', () => {
        const fact = factNamed(factsOf(ctxWith(), 'br-ex', 'ovs-interface'), 'IPv4')!;
        expect(fact.value).toEqual([
            { text: '192.0.2.10/24' },
            { text: '169.254.0.2/17', detail: 'Host masquerade: source for host-to-service traffic' },
        ]);
        expect(fact.hint).toContain(MASQUERADE_SUBNET_HELP);
    });

    it('labels it under the bridge\'s internal port', () => {
        const ports = factNamed(factsOf(ctxWith(), 'br-ex', 'ovs-bridge'), 'Internal Port')!;
        expect((ports.value as FactItem[])[0].detail)
            .toBe('192.0.2.10/24, 169.254.0.2/17 (Host masquerade: source for host-to-service traffic)');
    });

    it('keeps a plain address list on an interface with no masquerade address', () => {
        expect(factNamed(factsOf(ctxWith(), 'ovn-k8s-mp3', 'ovs-interface'), 'IPv4')?.value).toBe('10.9.0.2/16');
    });
});

describe('the VRF\'s management-port masquerade route', () => {
    it('is read out of the VRF\'s table: one /32 to a management port, nothing else', () => {
        expect(vrfManagementPortRoutes(vrfRoutes, subnets)).toEqual([
            { destination: '169.254.0.16/32', networkId: 3, interface: 'ovn-k8s-mp3' },
        ]);
        expect(vrfManagementPortRoutes(getRunningRoutes(nns).filter((r) => r.tableId === 254), subnets)).toEqual([]);
    });

    const masqueradeRoutes = vrfManagementPortRoutes(vrfRoutes, subnets);

    it('corroborates the network the VRF\'s name points at', () => {
        const match = findPrimaryNetworkForVrf(vrf, cudns, [], interfaces, agreeingNads, { masqueradeRoutes })!;
        expect(match.name).toBe('blue');
        expect(match.signals).toEqual(['subnet', 'name', 'masquerade-route']);
        expect(match.masqueradeRoute).toEqual(masqueradeRoutes[0]);
        expect(match.masqueradeConflicts).toBeUndefined();
    });

    it('is not looked for unless the caller passes the routes', () => {
        const match = findPrimaryNetworkForVrf(vrf, cudns, [], interfaces, agreeingNads)!;
        expect(match.signals).toEqual(['subnet', 'name']);
    });

    it('is never the only signal', () => {
        const nameless = { ...vrf, name: 'vrf-x' } as Interface;
        // The port's address still lies in blue's subnet; route and subnet together identify nothing.
        expect(findPrimaryNetworkForVrf(nameless, cudns, [], interfaces, agreeingNads, { masqueradeRoutes }))
            .toBeUndefined();
    });

    it('reports a route naming another network as a conflict, not a signal', () => {
        const match = findPrimaryNetworkForVrf(vrf, cudns, [], interfaces, disagreeingNads, { masqueradeRoutes })!;
        expect(match.name).toBe('blue');
        expect(match.signals).not.toContain('masquerade-route');
        expect(match.masqueradeConflicts).toEqual([{
            destination: '169.254.0.16/32', networkId: 3, interface: 'ovn-k8s-mp3', network: { kind: 'cudn', name: 'red' },
        }]);
    });

    it('reports an ID nothing claims only when the network\'s own ID is known', () => {
        const unknownId = [{ destination: '169.254.0.30/32', networkId: 10, interface: 'ovn-k8s-mp10' }];
        expect(findPrimaryNetworkForVrf(vrf, cudns, [], interfaces, agreeingNads, { masqueradeRoutes: unknownId })!
            .masqueradeConflicts).toEqual(unknownId);
        expect(findPrimaryNetworkForVrf(vrf, cudns, [], interfaces, [], { masqueradeRoutes: unknownId })!
            .masqueradeConflicts).toBeUndefined();
    });

    it('agrees in the drawer, with the route in the hint', () => {
        const fact = factNamed(factsOf(ctxWith(), 'blue', 'vrf'), 'Serves Primary Network')!;
        expect((fact.value as FactItem[]).map((item) => item.text)).toEqual([
            'blue (ClusterUserDefinedNetwork)',
            'Agrees with route 169.254.0.16/32 dev ovn-k8s-mp3: this network\'s management-port masquerade address '
                + '(network ID 3)',
        ]);
        expect(fact.provenance).toBe('inferred');
        expect(fact.hint).toContain('Its table routes 169.254.0.16/32 dev ovn-k8s-mp3');
    });

    it('warns in the drawer when the route names another network', () => {
        const fact = factNamed(factsOf(ctxWith({ nads: disagreeingNads }), 'blue', 'vrf'), 'Serves Primary Network')!;
        expect((fact.value as FactItem[]).map((item) => item.text)).toEqual([
            'blue (ClusterUserDefinedNetwork)',
            '⚠ route 169.254.0.16/32 dev ovn-k8s-mp3 is the management-port masquerade address of network ID 3 '
                + '(CUDN red), not of this network',
        ]);
        expect(fact.hint).not.toContain('Its table routes');
    });
});

describe('route addresses name their masquerade role', () => {
    let container: HTMLDivElement;
    let root: Root;
    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const Routes = routed(KernelRouteTable);
    const cellsOf = (label: string) => [...container.querySelectorAll(`td[data-label="${label}"]`)];

    it('shows the management port\'s network, linked, and the dummy next hop', () => {
        const ownersOf = renderHook(() => useNodeAddressOwners({
            nodeName: NODE, nodeNetworkStates: [nns], cudns, nads: agreeingNads,
        }));
        act(() => root.render(<Routes routes={vrfRoutes} gatewayOwners={ownersOf} />));

        const management = cellsOf('Destination').find((cell) => cell.textContent?.startsWith('169.254.0.16/32'))!;
        const owner = management.querySelector('[data-testid="address-owner"]')!;
        expect(owner.textContent).toBe('Management port masquerade of blue');
        expect(owner.querySelector('a')).not.toBeNull();

        const gateway = cellsOf('Gateway').find((cell) => cell.querySelector('code')?.textContent === '169.254.0.4')!;
        expect(gateway.querySelector('[data-testid="address-owner"]')?.textContent).toBe('Dummy next hop');

        // A subnet route is no one host's: no owner under it.
        const subnetRoute = cellsOf('Destination').find((cell) => cell.textContent?.startsWith('169.254.0.0/17'))!;
        expect(subnetRoute.querySelector('[data-testid^="address-owner"]')).toBeNull();
    });

    it('names a management port the book does not derive from the route alone', () => {
        // No NAD says blue is primary, so the book derives no pair; the route is the evidence.
        expect(routeMasqueradeOwner('169.254.0.16/32', NODE, subnets, {})).toMatchObject({
            kind: 'masquerade',
            label: 'Management port masquerade of network ID 3',
            masquerade: { role: 'udn-management-port', networkId: 3, basis: 'observed' },
        });
        expect(routeMasqueradeOwner('192.0.2.10', NODE, subnets, {})).toBeUndefined();
        const ownersOf = renderHook(() => useNodeAddressOwners({ nodeName: NODE, nodeNetworkStates: [nns] }));
        expect(ownersOf('169.254.0.16/32').map((owner) => owner.label)).toEqual(['Management port masquerade of network ID 3']);
    });
});
