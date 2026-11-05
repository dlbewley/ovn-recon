import fs from 'fs';
import path from 'path';

import { buildGraphContext, GraphContext, GraphContextInput } from '../topology/context';
import { descriptorFor } from '../topology/descriptors';
import { LaneViewState } from '../topology/lanes';
import { nodeKindRegistry } from '../topology/registry';
import { Fact } from '../topology/types';
import { buildNodeViewModel } from '../topology/viewModel';
import { buildTopologyEdges, TopologyEdge } from './nodeVisualizationModel';
import {
    findNetworkByNetworkId,
    findPrimaryNetworkForVrf,
    parseNetworkIdFromVrfName
} from './nodeVisualizationSelectors';
import {
    ClusterUserDefinedNetwork, Interface, NetworkAttachmentDefinition, NodeNetworkState, UserDefinedNetwork
} from '../types';

/**
 * A VRF named for a network ID still finds its network (ovn-recon-s3t.57).
 *
 * OVN-Kubernetes names a Primary network's VRF after the CUDN only when that name fits
 * in a 15-character interface name. Otherwise -- and always for a namespaced UDN -- the
 * VRF is `mp<network ID>-udn-vrf`, which shares nothing with the network's name, so the
 * name match missed it and the VRF and its network looked unrelated. Two things can
 * close the gap: the network's own status.vrfName, on releases that publish it, and
 * the network ID carried by its NetworkAttachmentDefinition, on those that do not.
 */
const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

const VIEW: LaneViewState = { showHiddenColumns: false, showNads: false, showLldp: false };
const CUDN = 'demo-evpn-vni10010';
const VRF_ID = 'vrf:mp9-udn-vrf';
const CUDN_ID = `cudn:${CUDN}`;

const nns = fixture<NodeNetworkState>('nns', 'evpn-vxlan.json');
const cudns = fixture<ClusterUserDefinedNetwork[]>('cudn', 'evpn-vxlan.json');
const nads = fixture<NetworkAttachmentDefinition[]>('nad', 'evpn-vxlan.json');
const interfaces = nns.status!.currentState!.interfaces;
const vrf = interfaces.find((i) => i.name === 'mp9-udn-vrf')!;

/** The same CUDN as a release that publishes the VRF name would report it. */
const withStatusVrfName = (name: string): ClusterUserDefinedNetwork[] =>
    cudns.map((cudn) => ({ ...cudn, status: { ...cudn.status, vrfName: name } }));

const ctxWith = (input: Partial<GraphContextInput> = {}): GraphContext => buildGraphContext({ nns, ...input });
const primaryEdges = (ctx: GraphContext): TopologyEdge[] =>
    buildTopologyEdges(ctx, VIEW).edges.filter((e) => e.rule === 'primary-network');
const servesFact = (ctx: GraphContext): Fact | undefined => {
    const descriptor = descriptorFor('vrf')!;
    const item = ctx.interfaces.find((i) => i.name === 'mp9-udn-vrf')!;
    return nodeKindRegistry.vrf.facts!(buildNodeViewModel(item, descriptor, ctx), ctx)
        .find((f) => f.label === 'Serves Primary Network');
};

const primaryCudn = (name: string, role: 'Primary' | 'Secondary' = 'Primary') => ({
    apiVersion: 'k8s.ovn.org/v1',
    kind: 'ClusterUserDefinedNetwork',
    metadata: { name },
    spec: { network: { topology: 'Layer2', layer2: { role, subnets: ['10.9.0.0/16'] } } }
}) as unknown as ClusterUserDefinedNetwork;

const nadWithId = (namespace: string, name: string, networkId: string, networkName?: string) => ({
    apiVersion: 'k8s.cni.cncf.io/v1',
    kind: 'NetworkAttachmentDefinition',
    metadata: { namespace, name, annotations: { 'k8s.ovn.org/network-id': networkId } },
    spec: { config: JSON.stringify({ name: networkName ?? `cluster_udn_${name}`, type: 'ovn-k8s-cni-overlay' }) }
}) as unknown as NetworkAttachmentDefinition;

const vrfNamed = (name: string): Interface => ({ name, type: 'vrf', state: 'up' });

describe('reading a network ID out of a VRF name', () => {
    it('reads the ID-derived form', () => {
        expect(parseNetworkIdFromVrfName('mp9-udn-vrf')).toBe('9');
        expect(parseNetworkIdFromVrfName('mp200-udn-vrf')).toBe('200');
    });

    it('reads nothing from a VRF named after its network, or from anything else', () => {
        ['example-p-cudn', 'mp-udn-vrf', 'mp9-udn-vrf2', 'xmp9-udn-vrf', 'mpx-udn-vrf', 'ovn-k8s-mp9', '', undefined]
            .forEach((name) => expect(parseNetworkIdFromVrfName(name)).toBeUndefined());
    });
});

describe('resolving a network ID', () => {
    it('finds the network whose NAD carries it', () => {
        expect(findNetworkByNetworkId('9', cudns, [], nads)).toMatchObject({
            network: { kind: 'cudn', name: CUDN },
            nad: { metadata: { namespace: 'demo-evpn', name: CUDN } }
        });
    });

    it('finds nothing for an ID no NAD carries', () => {
        expect(findNetworkByNetworkId('31', cudns, [], nads)).toEqual({ network: undefined, nad: undefined });
        expect(findNetworkByNetworkId('9', cudns, [], [])).toEqual({ network: undefined, nad: undefined });
    });

    it('matches neither when two networks claim one ID', () => {
        const clash = [nadWithId('ns-a', 'blue', '7'), nadWithId('ns-b', 'green', '7')];
        expect(findNetworkByNetworkId('7', [primaryCudn('blue'), primaryCudn('green')], [], clash))
            .toEqual({ ambiguous: ['CUDN blue', 'CUDN green'] });
    });
});

describe('a VRF named for a network ID finds its network', () => {
    it('matches through the NAD carrying the ID, corroborated by the subnet', () => {
        expect(findPrimaryNetworkForVrf(vrf, cudns, [], interfaces, nads)).toEqual({
            kind: 'cudn',
            name: CUDN,
            namespace: undefined,
            signals: ['network-id', 'subnet'],
            corroboration: { port: 'ovn-k8s-mp9', address: '10.10.10.2/24', subnet: '10.10.10.0/24' },
            networkId: '9',
            nad: { namespace: 'demo-evpn', name: CUDN }
        });
    });

    it('still says nothing when the NADs were not loaded', () => {
        // The subnet agrees, but subnets are not unique: on its own it identifies nothing.
        expect(findPrimaryNetworkForVrf(vrf, cudns, [], interfaces)).toBeUndefined();
        expect(findPrimaryNetworkForVrf(vrf, cudns, [], interfaces, [])).toBeUndefined();
    });

    it('matches nothing when the ID belongs to another network', () => {
        const other = [nadWithId('demo-evpn', CUDN, '31')];
        expect(findPrimaryNetworkForVrf(vrf, cudns, [], interfaces, other)).toBeUndefined();
    });

    it('matches nothing when two networks claim the ID', () => {
        const clash = [nadWithId('ns-a', 'blue', '9'), nadWithId('ns-b', 'green', '9')];
        expect(findPrimaryNetworkForVrf(vrfNamed('mp9-udn-vrf'), [primaryCudn('blue'), primaryCudn('green')], [], [], clash))
            .toBeUndefined();
    });

    it('never matches a Secondary network, whatever its ID', () => {
        const secondary = [primaryCudn('a-long-secondary-network', 'Secondary')];
        const nad = [nadWithId('ns-a', 'a-long-secondary-network', '9')];
        expect(findPrimaryNetworkForVrf(vrfNamed('mp9-udn-vrf'), secondary, [], [], nad)).toBeUndefined();
    });

    it('matches a namespaced UDN, whose VRF is always ID-derived', () => {
        const udn = {
            metadata: { namespace: 'tenant', name: 'blue' },
            spec: { topology: 'Layer3', layer3: { role: 'Primary', subnets: [{ cidr: '10.9.0.0/16' }] } }
        } as UserDefinedNetwork;
        const nad = [nadWithId('tenant', 'blue', '12', 'tenant_blue')];
        expect(findPrimaryNetworkForVrf(vrfNamed('mp12-udn-vrf'), [], [udn], [], nad)).toMatchObject({
            kind: 'udn', name: 'blue', namespace: 'tenant', signals: ['network-id'], networkId: '12'
        });
    });

    it('does not confuse a CUDN with a same-named UDN in another network', () => {
        // CUDN `blue` and UDN `tenant/blue` are both Primary; ID 12 is the UDN's.
        const udn = {
            metadata: { namespace: 'tenant', name: 'blue' },
            spec: { topology: 'Layer2', layer2: { role: 'Primary', subnets: ['10.8.0.0/16'] } }
        } as UserDefinedNetwork;
        const nad = [nadWithId('tenant', 'blue', '12', 'tenant_blue')];
        expect(findPrimaryNetworkForVrf(vrfNamed('mp12-udn-vrf'), [primaryCudn('blue')], [udn], [], nad))
            .toMatchObject({ kind: 'udn', namespace: 'tenant' });
    });
});

describe('a network that publishes its VRF name', () => {
    it('is matched by status.vrfName, with no NADs needed', () => {
        expect(findPrimaryNetworkForVrf(vrf, withStatusVrfName('mp9-udn-vrf'), [], interfaces)).toMatchObject({
            kind: 'cudn', name: CUDN, signals: ['status', 'subnet']
        });
    });

    it('carries both signals when the NADs are loaded too', () => {
        expect(findPrimaryNetworkForVrf(vrf, withStatusVrfName('mp9-udn-vrf'), [], interfaces, nads)?.signals)
            .toEqual(['status', 'network-id', 'subnet']);
    });

    it('is preferred over a network that merely shares the VRF\'s name', () => {
        const named = primaryCudn('shared-name');
        const declared = { ...primaryCudn('some-long-network-name'), status: { vrfName: 'shared-name' } };
        expect(findPrimaryNetworkForVrf(vrfNamed('shared-name'), [named, declared], [], []))
            .toMatchObject({ name: 'some-long-network-name', signals: ['status'] });
    });

    it('does not match a VRF it does not name', () => {
        expect(findPrimaryNetworkForVrf(vrf, withStatusVrfName('mp31-udn-vrf'), [], interfaces)).toBeUndefined();
    });
});

describe('the name match is unchanged', () => {
    it('still matches a VRF carrying its network\'s name, with or without NADs', () => {
        const primaryNns = fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json');
        const primaryCudns = fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json');
        const all = primaryNns.status!.currentState!.interfaces;
        const named = all.find((i) => i.type === 'vrf')!;
        const expected = { kind: 'cudn', name: 'example-p-cudn', signals: ['subnet', 'name'] };
        expect(findPrimaryNetworkForVrf(named, primaryCudns, [], all)).toMatchObject(expected);
        expect(findPrimaryNetworkForVrf(named, primaryCudns, [], all, nads)).toMatchObject(expected);
    });
});

describe('the graph draws the VRF to its network', () => {
    it('adds the edge once the NADs are loaded, citing the ID and the NAD', () => {
        const edges = primaryEdges(ctxWith({ cudns, nads }));
        expect(edges).toEqual([expect.objectContaining({
            source: VRF_ID, target: CUDN_ID, kind: 'reference', provenance: 'inferred'
        })]);
        expect(edges[0].rationale).toBe(
            `VRF mp9-udn-vrf is named for network ID 9, which NetworkAttachmentDefinition demo-evpn/${CUDN} `
            + `of Primary CUDN ${CUDN} carries as k8s.ovn.org/network-id; port ovn-k8s-mp9 address 10.10.10.2/24 `
            + 'lies inside its subnet 10.10.10.0/24. Inferred: the naming is an OVN-Kubernetes implementation '
            + 'detail; NodeNetworkState does not record which network a VRF serves.'
        );
    });

    it('draws nothing without the NADs', () => {
        expect(primaryEdges(ctxWith({ cudns }))).toEqual([]);
        expect(primaryEdges(ctxWith())).toEqual([]);
    });

    it('is declared when the network reports the VRF name itself', () => {
        const [edge] = primaryEdges(ctxWith({ cudns: withStatusVrfName('mp9-udn-vrf') }));
        expect(edge).toMatchObject({ source: VRF_ID, target: CUDN_ID, provenance: 'declared' });
        expect(edge.rationale).toBe(
            `Primary CUDN ${CUDN} reports status.vrfName: mp9-udn-vrf; port ovn-k8s-mp9 address 10.10.10.2/24 `
            + 'lies inside its subnet 10.10.10.0/24.'
        );
    });
});

describe('the VRF drawer says how it found the network', () => {
    it('names the network ID and the NAD, inferred', () => {
        const fact = servesFact(ctxWith({ cudns, nads }))!;
        expect(fact.provenance).toBe('inferred');
        expect(fact.value).toEqual([{
            text: `${CUDN} (ClusterUserDefinedNetwork)`,
            ref: { apiVersion: 'k8s.ovn.org/v1', kind: 'ClusterUserDefinedNetwork', name: CUDN }
        }]);
        expect(fact.hint).toContain('Matched by network ID');
        expect(fact.hint).toContain(`NetworkAttachmentDefinition demo-evpn/${CUDN} carries k8s.ovn.org/network-id: 9.`);
        expect(fact.hint).toContain('Port ovn-k8s-mp9 address 10.10.10.2/24 lies inside its subnet 10.10.10.0/24.');
    });

    it('is declared when the network reports the VRF name', () => {
        const fact = servesFact(ctxWith({ cudns: withStatusVrfName('mp9-udn-vrf') }))!;
        expect(fact.provenance).toBe('declared');
        expect(fact.hint).toContain('The network\'s status.vrfName names this VRF.');
    });

    it('is absent when nothing identifies the network', () => {
        expect(servesFact(ctxWith({ cudns }))).toBeUndefined();
    });
});
