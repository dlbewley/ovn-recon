import fs from 'fs';
import path from 'path';

import { buildGraphContext, GraphContext, GraphContextInput } from '../topology/context';
import { descriptorFor, NodeTypeId } from '../topology/descriptors';
import { LaneViewState } from '../topology/lanes';
import { nodeKindRegistry } from '../topology/registry';
import { Fact, FactItem } from '../topology/types';
import { buildNodeViewModel } from '../topology/viewModel';
import { buildTopologyEdges, TopologyEdge } from './nodeVisualizationModel';
import {
    evpnVtepDeviceName,
    findEvpnNetworkForDevice,
    findVtepForDevice,
    getCudnsUsingVtep,
    getKnownVtepNames,
    parseEvpnNetworkDeviceName,
    parseNodeVteps
} from './nodeVisualizationSelectors';
import {
    ClusterUserDefinedNetwork, Interface, NetworkAttachmentDefinition, NodeNetworkState,
    UserDefinedNetwork, Vtep
} from '../types';

/**
 * An EVPN device says which VTEP and which network it belongs to (ovn-recon-s3t.53).
 *
 * ovn-recon-s3t.52 drew the VXLAN device and its underlay; nothing said WHICH VTEP it
 * was or which network rode on it. That link is in the device names: OVN-Kubernetes
 * derives them from the VTEP name (hashed when too long) and from the network's name
 * or ID. It is a naming convention, so what rests on it is inferred -- except where
 * the Node annotation states the VTEP's address outright and the device agrees.
 */
const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

const VIEW: LaneViewState = { showHiddenColumns: false, showNads: false, showLldp: false };
const REVEALED: LaneViewState = { ...VIEW, showHiddenColumns: true };

const VTEP = 'demo-evpn-vteps';
const CUDN = 'demo-evpn-vni10010';
const VXLAN_ID = 'iface:evx4.4a75265e';
const CUDN_ID = `cudn:${CUDN}`;
/** What the Node carries on the fixture's node: the address discovered for the VTEP. */
const NODE_ANNOTATION = JSON.stringify({ [VTEP]: { ips: ['192.0.2.72'] } });

const nns = fixture<NodeNetworkState>('nns', 'evpn-vxlan.json');
const cudns = fixture<ClusterUserDefinedNetwork[]>('cudn', 'evpn-vxlan.json');
const vteps = fixture<Vtep[]>('vtep', 'evpn-vxlan.json');
const nads = fixture<NetworkAttachmentDefinition[]>('nad', 'evpn-vxlan.json');

const ctxWith = (input: Partial<GraphContextInput> = {}): GraphContext => buildGraphContext({ nns, ...input });
/** Everything a live cluster provides. */
const full = ctxWith({ cudns, vteps, nads, nodeVtepsAnnotation: NODE_ANNOTATION });

const edgesOf = (ctx: GraphContext, rule: string, view = VIEW): TopologyEdge[] =>
    buildTopologyEdges(ctx, view).edges.filter((e) => e.rule === rule);

const ifaceNamed = (ctx: GraphContext, name: string): Interface => ctx.interfaces.find((i) => i.name === name)!;

const factsFor = (ctx: GraphContext, type: NodeTypeId, item: unknown): Fact[] => {
    const descriptor = descriptorFor(type)!;
    return nodeKindRegistry[descriptor.kind].facts!(buildNodeViewModel(item, descriptor, ctx), ctx);
};
const factOf = (facts: Fact[], label: string): Fact | undefined => facts.find((f) => f.label === label);
const texts = (fact: Fact | undefined): string[] => ((fact?.value ?? []) as FactItem[]).map((v) => v.text);

const cudnNamed = (name: string, vtep?: string) => ({
    apiVersion: 'k8s.ovn.org/v1',
    kind: 'ClusterUserDefinedNetwork',
    metadata: { name },
    spec: {
        network: {
            topology: 'Layer2',
            layer2: { role: 'Primary', subnets: ['10.9.0.0/16'] },
            ...(vtep ? { transport: 'EVPN', evpn: { vtep, macVRF: { vni: 100 } } } : {})
        }
    }
}) as unknown as ClusterUserDefinedNetwork;

const nadWithId = (namespace: string, name: string, networkId: string, networkName?: string) => ({
    apiVersion: 'k8s.cni.cncf.io/v1',
    kind: 'NetworkAttachmentDefinition',
    metadata: { namespace, name, annotations: { 'k8s.ovn.org/network-id': networkId } },
    spec: { config: JSON.stringify({ name: networkName ?? `cluster_udn_${name}`, type: 'ovn-k8s-cni-overlay' }) }
}) as unknown as NetworkAttachmentDefinition;

describe('the name OVN-Kubernetes gives a VTEP device', () => {
    it('spells the VTEP name out when it fits in 15 characters', () => {
        expect(evpnVtepDeviceName('evbr', 'myvtep')).toBe('evbr-myvtep');
        expect(evpnVtepDeviceName('evx4', 'myvtep')).toBe('evx4-myvtep');
        expect(evpnVtepDeviceName('evx6', 'myvtep')).toBe('evx6-myvtep');
    });

    it('switches to the hash exactly where the readable form stops fitting', () => {
        // prefix (4) + '-' + 10 characters is 15, the limit; an 11th tips it over.
        expect(evpnVtepDeviceName('evx4', 'abcdefghij')).toBe('evx4-abcdefghij');
        expect(evpnVtepDeviceName('evx4', 'abcdefghijk')).toMatch(/^evx4\.[0-9a-f]{8}$/);
    });

    it('reproduces the names on the captured node', () => {
        const names = ctxWith().interfaces.map((i) => i.name);
        expect(names).toContain(evpnVtepDeviceName('evx4', VTEP));
        expect(names).toContain(evpnVtepDeviceName('evbr', VTEP));
    });
});

describe('matching a device back to its VTEP', () => {
    it('matches the hash form', () => {
        expect(findVtepForDevice('evx4.4a75265e', [VTEP])).toEqual({ prefix: 'evx4', vtepName: VTEP, how: 'hash' });
        expect(findVtepForDevice('evbr.4a75265e', ['other', VTEP])).toEqual({ prefix: 'evbr', vtepName: VTEP, how: 'hash' });
    });

    it('matches the readable form of a short VTEP name', () => {
        expect(findVtepForDevice('evx6-myvtep', ['myvtep'])).toEqual({ prefix: 'evx6', vtepName: 'myvtep', how: 'name' });
    });

    it('matches nothing when no known VTEP would produce the name', () => {
        expect(findVtepForDevice('evx4.4a75265e', ['some-other-vtep-name'])).toBeUndefined();
        expect(findVtepForDevice('evx4.4a75265e', [])).toBeUndefined();
    });

    it('does not mistake other devices for a VTEP\'s', () => {
        ['br-ex', 'ens192', 'svl2.9', 'evx4', 'evx4_myvtep', 'vxlan-myvtep', undefined].forEach((name) => {
            expect(findVtepForDevice(name, ['myvtep', VTEP])).toBeUndefined();
        });
    });

    it('does not read a long name\'s readable spelling as a match', () => {
        // OVN-Kubernetes would never create evx4-<16 chars>: it cannot be an interface name.
        expect(findVtepForDevice(`evx4-${VTEP}`, [VTEP])).toBeUndefined();
    });

    it('refuses to choose when two names produce the same device', () => {
        // Reachable only through a hash collision; a wrong VTEP is worse than none.
        expect(findVtepForDevice('evx4-myvtep', ['myvtep', 'myvtep'])).toBeUndefined();
    });
});

describe('where VTEP names come from', () => {
    it('reads the Node annotation', () => {
        expect(parseNodeVteps(NODE_ANNOTATION)).toEqual({ [VTEP]: ['192.0.2.72'] });
    });

    it('treats an absent or unreadable annotation as no information', () => {
        [undefined, '', 'not json', '[]', '"text"', 'null', '{"a":null}', '{"a":{"ips":"1.2.3.4"}}'].forEach((value) => {
            expect(parseNodeVteps(value)).toEqual({});
        });
    });

    it('takes the union of VTEP resources, CUDN specs and the Node annotation', () => {
        expect(getKnownVtepNames(vteps, [], {})).toEqual([VTEP]);
        expect(getKnownVtepNames([], cudns, {})).toEqual([VTEP]);
        expect(getKnownVtepNames([], [], { [VTEP]: [] })).toEqual([VTEP]);
        expect(getKnownVtepNames(vteps, [cudnNamed('blue', 'b-vtep'), cudnNamed('plain')], { 'a-vtep': [] }))
            .toEqual(['a-vtep', 'b-vtep', VTEP]);
    });

    it('finds the CUDNs riding on a VTEP', () => {
        const all = [...cudns, cudnNamed('blue', 'other-vtep'), cudnNamed('plain')];
        expect(getCudnsUsingVtep(VTEP, all).map((c) => c.metadata?.name)).toEqual([CUDN]);
        expect(getCudnsUsingVtep(undefined, all)).toEqual([]);
    });
});

describe('reading a per-network device name', () => {
    it('reads the network-ID form', () => {
        expect(parseEvpnNetworkDeviceName('svl2.9')).toEqual({ prefix: 'svl2', how: 'network-id', key: '9' });
        expect(parseEvpnNetworkDeviceName('ovl2.42')).toEqual({ prefix: 'ovl2', how: 'network-id', key: '42' });
    });

    it('reads the CUDN-name form', () => {
        expect(parseEvpnNetworkDeviceName('svl3-blue')).toEqual({ prefix: 'svl3', how: 'name', key: 'blue' });
    });

    it('rejects everything else', () => {
        ['svl2', 'svl2.', 'svl2-', 'svl2.blue', 'svl2_9', 'ens224.456', 'evx4.4a75265e', undefined].forEach((name) => {
            expect(parseEvpnNetworkDeviceName(name)).toBeUndefined();
        });
    });
});

describe('matching a per-network device to its network', () => {
    it('resolves a network ID through the NAD that carries it', () => {
        expect(findEvpnNetworkForDevice('svl2.9', cudns, [], nads)).toEqual({
            prefix: 'svl2',
            how: 'network-id',
            key: '9',
            network: { kind: 'cudn', name: CUDN },
            nad: { namespace: 'demo-evpn', name: CUDN },
            vid: 2
        });
    });

    it('treats a CUDN\'s NADs in several namespaces as one network', () => {
        const everywhere = [nadWithId('ns-a', 'blue', '7'), nadWithId('ns-b', 'blue', '7')];
        expect(findEvpnNetworkForDevice('ovl2.7', [cudnNamed('blue', 'v')], [], everywhere)).toMatchObject({
            network: { kind: 'cudn', name: 'blue' }, nad: { namespace: 'ns-a', name: 'blue' }
        });
    });

    it('resolves a CUDN name directly', () => {
        expect(findEvpnNetworkForDevice('svl3-blue', [cudnNamed('blue', 'v')], [], [])).toMatchObject({
            how: 'name', network: { kind: 'cudn', name: 'blue' }
        });
    });

    it('resolves a namespaced UDN, which always gets the ID form', () => {
        const udn = { metadata: { namespace: 'tenant', name: 'blue' } } as UserDefinedNetwork;
        const nad = nadWithId('tenant', 'blue', '12', 'tenant_blue');
        expect(findEvpnNetworkForDevice('svl2.12', [], [udn], [nad])).toMatchObject({
            network: { kind: 'udn', namespace: 'tenant', name: 'blue' }
        });
    });

    it('prefers the network name in the NAD config over a CUDN that shares the NAD\'s name', () => {
        // A CUDN `blue` and a UDN `tenant/blue` both exist; the NAD is the UDN's.
        const udn = { metadata: { namespace: 'tenant', name: 'blue' } } as UserDefinedNetwork;
        const nad = nadWithId('tenant', 'blue', '12', 'tenant_blue');
        expect(findEvpnNetworkForDevice('svl2.12', [cudnNamed('blue', 'v')], [udn], [nad])?.network)
            .toEqual({ kind: 'udn', namespace: 'tenant', name: 'blue' });
    });

    it('says what the device is but not whose, when the ID resolves to nothing', () => {
        expect(findEvpnNetworkForDevice('svl2.9', cudns, [], [])).toEqual({
            prefix: 'svl2', how: 'network-id', key: '9', network: undefined, nad: undefined, vid: undefined
        });
        expect(findEvpnNetworkForDevice('svl2.31', cudns, [], nads)?.network).toBeUndefined();
        expect(findEvpnNetworkForDevice('svl2-nosuch', cudns, [], nads)?.network).toBeUndefined();
    });

    it('matches neither when two networks claim one ID', () => {
        const clash = [nadWithId('ns-a', 'blue', '7'), nadWithId('ns-b', 'green', '7')];
        const result = findEvpnNetworkForDevice('svl2.7', [cudnNamed('blue', 'v'), cudnNamed('green', 'v')], [], clash);
        expect(result?.network).toBeUndefined();
        expect(result?.ambiguous).toEqual(['CUDN blue', 'CUDN green']);
    });
});

describe('the VXLAN device reaches the networks riding on it', () => {
    it('draws a reference edge to the CUDN that names its VTEP', () => {
        expect(edgesOf(full, 'evpn-vtep')).toEqual([expect.objectContaining({
            source: VXLAN_ID, target: CUDN_ID, kind: 'reference'
        })]);
    });

    it('is declared when the Node annotation gives the VTEP this device\'s address', () => {
        const [edge] = edgesOf(full, 'evpn-vtep');
        expect(edge.provenance).toBe('declared');
        expect(edge.rationale).toBe(
            `CUDN ${CUDN} declares spec.network.evpn.vtep: ${VTEP}, and the Node's k8s.ovn.org/vteps annotation `
            + 'gives that VTEP the address 192.0.2.72, which is evx4.4a75265e\'s vxlan.local. The device name agrees: '
            + `evx4.4a75265e is evx4 plus the first 8 hex digits of sha256("${VTEP}").`
        );
    });

    it('is inferred from the name alone when no Node annotation was read', () => {
        const [edge] = edgesOf(ctxWith({ cudns, vteps, nads }), 'evpn-vtep');
        expect(edge).toMatchObject({ source: VXLAN_ID, target: CUDN_ID, provenance: 'inferred' });
        expect(edge.rationale).toMatch(/first 8 hex digits of sha256\("demo-evpn-vteps"\)\. Inferred: /);
    });

    it('stays inferred when the annotation names a different address', () => {
        const elsewhere = JSON.stringify({ [VTEP]: { ips: ['192.0.2.99'] } });
        expect(edgesOf(ctxWith({ cudns, vteps, nodeVtepsAnnotation: elsewhere }), 'evpn-vtep')[0].provenance)
            .toBe('inferred');
    });

    it('needs no VTEP resource: the CUDN names the VTEP', () => {
        // A reader who may not list VTEPs, or an NNS read beside CUDNs only.
        expect(edgesOf(ctxWith({ cudns }), 'evpn-vtep')).toHaveLength(1);
    });

    it('draws one edge per CUDN on the VTEP', () => {
        const two = [...cudns, cudnNamed('second-evpn-network', VTEP)];
        expect(edgesOf(ctxWith({ cudns: two }), 'evpn-vtep').map((e) => e.target).sort())
            .toEqual([CUDN_ID, 'cudn:second-evpn-network']);
    });

    it('draws nothing from the VTEP\'s bridge, which reaches the networks through its port', () => {
        expect(edgesOf(full, 'evpn-vtep').map((e) => e.source)).toEqual([VXLAN_ID]);
    });

    it('draws nothing when the VTEP exists but no CUDN names it', () => {
        expect(edgesOf(ctxWith({ vteps, cudns: [cudnNamed('plain')] }), 'evpn-vtep')).toEqual([]);
    });

    it('draws nothing when the only known VTEP is not this device\'s', () => {
        const other = [{ ...vteps[0], metadata: { name: 'some-other-vtep-name' } }];
        const ctx = ctxWith({ vteps: other, cudns: [cudnNamed('blue', 'some-other-vtep-name')] });
        expect(edgesOf(ctx, 'evpn-vtep')).toEqual([]);
    });

    it('agrees with the patch-port route to the same CUDN', () => {
        // ovn-recon-s3t.29 reaches the network from br-ex through its gateway patch
        // pair; this reaches it from the tunnel. Two independent readings, one CUDN.
        expect(edgesOf(full, 'patch-port-cudn').map((e) => e.target)).toEqual([CUDN_ID]);
        expect(edgesOf(full, 'evpn-vtep').map((e) => e.target)).toEqual([CUDN_ID]);
    });
});

describe('the underlay edge cites the Node annotation', () => {
    const underlay = (ctx: GraphContext) => edgesOf(ctx, 'vxlan-local')[0];

    it('adds the discovery when the annotation and vxlan.local agree', () => {
        expect(underlay(full)).toMatchObject({ source: 'iface:br-ex', target: VXLAN_ID, provenance: 'observed' });
        expect(underlay(full).rationale).toBe(
            'evx4.4a75265e tunnels over br-ex: vxlan.local 192.0.2.72 is an address of br-ex. '
            + `OVN-Kubernetes recorded the same address for VTEP ${VTEP} in the Node's k8s.ovn.org/vteps annotation.`
        );
    });

    it('says only what NodeNetworkState says without it', () => {
        expect(underlay(ctxWith({ cudns, vteps })).rationale).toBe(
            'evx4.4a75265e tunnels over br-ex: vxlan.local 192.0.2.72 is an address of br-ex.'
        );
    });
});

describe('the per-network devices reach their network', () => {
    it('links the Layer 2 SVI to the CUDN whose NAD carries its network ID', () => {
        const edge = edgesOf(full, 'evpn-network').find((e) => e.source === 'iface:svl2.9')!;
        expect(edge).toMatchObject({ target: CUDN_ID, kind: 'reference', provenance: 'inferred' });
        expect(edge.rationale).toBe(
            `svl2.9 is the Layer 2 SVI (MAC-VRF) of CUDN ${CUDN}: its name is svl2 plus network ID 9, which `
            + `NetworkAttachmentDefinition demo-evpn/${CUDN} carries as k8s.ovn.org/network-id. `
            + 'Its VLAN id 2 is the vid that network\'s EVPN config assigns. '
            + 'Inferred: the naming is an OVN-Kubernetes implementation detail.'
        );
    });

    it('links the OVS port too', () => {
        // ovl2.9 is an OVS internal port, so its node is in the lane that is hidden by
        // default. The model carries the edge either way; the canvas draws only edges
        // whose two ends are placed, so this one appears when that lane is revealed.
        const edge = edgesOf(full, 'evpn-network').find((e) => e.source === 'iface:ovl2.9')!;
        expect(edge).toMatchObject({ target: CUDN_ID, kind: 'reference', provenance: 'inferred' });
        expect(edge.rationale).toBe(
            `ovl2.9 is the OVS Layer 2 port of CUDN ${CUDN}: its name is ovl2 plus network ID 9, which `
            + `NetworkAttachmentDefinition demo-evpn/${CUDN} carries as k8s.ovn.org/network-id. `
            + 'Inferred: the naming is an OVN-Kubernetes implementation detail.'
        );
        expect(edgesOf(full, 'evpn-network')).toHaveLength(2);
    });

    it('draws nothing when no NAD carries the ID', () => {
        expect(edgesOf(ctxWith({ cudns, vteps }), 'evpn-network', REVEALED)).toEqual([]);
        const wrongId = [nadWithId('demo-evpn', CUDN, '31')];
        expect(edgesOf(ctxWith({ cudns, nads: wrongId }), 'evpn-network', REVEALED)).toEqual([]);
    });

    it('draws nothing when the NAD\'s network is not among the CUDNs', () => {
        expect(edgesOf(ctxWith({ nads }), 'evpn-network', REVEALED)).toEqual([]);
    });
});

describe('nothing changes without EVPN resources', () => {
    const before = buildTopologyEdges(ctxWith(), REVEALED);

    it('draws the same edges for an NNS read on its own', () => {
        expect(before.edges.some((e) => e.rule.startsWith('evpn-'))).toBe(false);
    });

    it('draws the same edges when the cluster has no VTEPs and no EVPN CUDNs', () => {
        const plain = buildTopologyEdges(ctxWith({ vteps: [], nads: [], nodeVtepsAnnotation: undefined }), REVEALED);
        expect(plain).toEqual(before);
    });

    it('adds no drawer facts either', () => {
        const ctx = ctxWith();
        const labels = (name: string, type: NodeTypeId) =>
            factsFor(ctx, type, ifaceNamed(ctx, name)).map((f) => f.label);
        ['VTEP', 'EVPN Networks', 'EVPN Network'].forEach((label) => {
            expect(labels('evx4.4a75265e', 'vxlan')).not.toContain(label);
            expect(labels('evbr.4a75265e', 'bridge')).not.toContain(label);
            expect(labels('svl2.9', 'vlan')).not.toContain(label);
        });
    });

    it('points no edge backwards', () => {
        const lanes = ['lldp:', 'iface:', 'vrf:', 'ovn:', 'cudn:', 'udn:', 'attachment:', 'nad:'];
        const laneOf = (id: string) => lanes.findIndex((prefix) => id.startsWith(prefix));
        const backwards = buildTopologyEdges(full, VIEW).edges
            .filter((e) => laneOf(e.source) > laneOf(e.target) && laneOf(e.target) >= 0);
        expect(backwards.map((e) => `${e.source} -> ${e.target} (${e.rule})`)).toEqual([]);
    });
});

describe('the drawer names the VTEP', () => {
    const vxlanFacts = (ctx: GraphContext) => factsFor(ctx, 'vxlan', ifaceNamed(ctx, 'evx4.4a75265e'));
    const bridgeFacts = (ctx: GraphContext) => factsFor(ctx, 'bridge', ifaceNamed(ctx, 'evbr.4a75265e'));

    it('links the VXLAN device to its cluster-scoped VTEP, with what the VTEP reports', () => {
        const fact = factOf(vxlanFacts(full), 'VTEP')!;
        expect((fact.value as FactItem[])[0]).toEqual({
            text: VTEP, ref: { apiVersion: 'k8s.ovn.org/v1', kind: 'VTEP', name: VTEP }
        });
        expect(texts(fact)).toEqual([
            VTEP,
            'This device: VXLAN device (IPv4)',
            'Mode: Unmanaged',
            'CIDRs: 192.0.2.0/24',
            'Accepted: True — Allocated',
            'Address on this node: 192.0.2.72 — equals vxlan.local'
        ]);
    });

    it('is declared when the Node annotation agrees, and says why', () => {
        const fact = factOf(vxlanFacts(full), 'VTEP')!;
        expect(fact.provenance).toBe('declared');
        expect(fact.hint).toContain('k8s.ovn.org/vteps');
        expect(fact.hint).toContain(`sha256("${VTEP}")`);
    });

    it('is inferred, naming the hash rule, when only the name links them', () => {
        const fact = factOf(vxlanFacts(ctxWith({ vteps })), 'VTEP')!;
        expect(fact.provenance).toBe('inferred');
        expect(fact.hint).toMatch(/^Matched by name: evx4\.4a75265e is evx4 plus the first 8 hex digits of sha256\("demo-evpn-vteps"\)/);
        expect(texts(fact)).not.toContain('Address on this node: 192.0.2.72 — equals vxlan.local');
    });

    it('flags an annotation that disagrees with the device', () => {
        const elsewhere = JSON.stringify({ [VTEP]: { ips: ['192.0.2.99'] } });
        const fact = factOf(vxlanFacts(ctxWith({ vteps, nodeVtepsAnnotation: elsewhere })), 'VTEP')!;
        expect(fact.provenance).toBe('inferred');
        expect(texts(fact)).toContain('⚠ Address on this node: 192.0.2.99 — but vxlan.local is 192.0.2.72');
    });

    it('flags a VTEP that was not accepted', () => {
        const rejected = [{
            ...vteps[0],
            status: { conditions: [{ type: 'Accepted', status: 'False', reason: 'NoAddress', message: 'no node address in cidrs' }] }
        }];
        expect(texts(factOf(vxlanFacts(ctxWith({ vteps: rejected })), 'VTEP')))
            .toContain('⚠ Accepted: False — NoAddress: no node address in cidrs');
    });

    it('still links the VTEP when only a CUDN names it', () => {
        const fact = factOf(vxlanFacts(ctxWith({ cudns })), 'VTEP')!;
        expect(texts(fact)).toEqual([
            VTEP,
            'This device: VXLAN device (IPv4)',
            'VTEP resource not read — its name is known from a CUDN or the Node annotation'
        ]);
    });

    it('shows the same VTEP on the EVPN bridge', () => {
        const fact = factOf(bridgeFacts(full), 'VTEP')!;
        expect(texts(fact).slice(0, 2)).toEqual([VTEP, 'This device: EVPN bridge']);
        // A bridge has no vxlan.local to compare, so the name is all that links it.
        expect(fact.provenance).toBe('inferred');
        expect(texts(fact)).toContain('Address on this node: 192.0.2.72');
    });

    it('lists the networks on the VTEP, with their VNIs', () => {
        const fact = factOf(vxlanFacts(full), 'EVPN Networks')!;
        expect(fact.provenance).toBe('declared');
        expect(fact.value).toEqual([{
            text: `${CUDN} — MAC-VRF VNI 10010 (RT 65002:10010)`,
            ref: { apiVersion: 'k8s.ovn.org/v1', kind: 'ClusterUserDefinedNetwork', name: CUDN }
        }]);
    });

    it('says so when no CUDN uses the VTEP', () => {
        const fact = factOf(vxlanFacts(ctxWith({ vteps })), 'EVPN Networks')!;
        expect(fact.value).toEqual([]);
        expect(fact.emptyText).toBe('No CUDN names this VTEP');
    });
});

describe('the drawer names the network of a per-network device', () => {
    const sviFacts = (ctx: GraphContext) => factsFor(ctx, 'vlan', ifaceNamed(ctx, 'svl2.9'));

    it('links the SVI to its CUDN and the NAD carrying the ID', () => {
        const fact = factOf(sviFacts(full), 'EVPN Network')!;
        expect(fact.provenance).toBe('inferred');
        expect(fact.hint).toContain('k8s.ovn.org/network-id');
        expect(fact.value).toEqual([
            { text: `CUDN ${CUDN}`, ref: { apiVersion: 'k8s.ovn.org/v1', kind: 'ClusterUserDefinedNetwork', name: CUDN } },
            { text: 'This device: Layer 2 SVI (MAC-VRF)' },
            {
                text: `Network ID 9: NetworkAttachmentDefinition demo-evpn/${CUDN}`,
                ref: { apiVersion: 'k8s.cni.cncf.io/v1', kind: 'NetworkAttachmentDefinition', name: CUDN, namespace: 'demo-evpn' }
            },
            { text: 'VLAN 2 equals the vid in the network\'s EVPN config' }
        ]);
    });

    it('covers the OVS port, which has no VLAN of its own to compare', () => {
        const ctx = full;
        const fact = factOf(factsFor(ctx, 'bridge-port', ifaceNamed(ctx, 'ovl2.9')), 'EVPN Network')!;
        expect(texts(fact)).toEqual([
            `CUDN ${CUDN}`,
            'This device: OVS Layer 2 port',
            `Network ID 9: NetworkAttachmentDefinition demo-evpn/${CUDN}`
        ]);
    });

    it('admits an ID that no NAD carries', () => {
        const ctx = ctxWith({ cudns, nads: [nadWithId('demo-evpn', CUDN, '31')] });
        expect(texts(factOf(sviFacts(ctx), 'EVPN Network'))).toEqual([
            'This device: Layer 2 SVI (MAC-VRF)',
            '⚠ No NetworkAttachmentDefinition carries k8s.ovn.org/network-id: 9'
        ]);
    });

    it('flags a VLAN that is not the one the network assigns', () => {
        const ctx = full;
        const moved = { ...ifaceNamed(ctx, 'svl2.9'), vlan: { 'base-iface': 'evbr.4a75265e', id: 7 } };
        expect(texts(factOf(factsFor(ctx, 'vlan', moved), 'EVPN Network')))
            .toContain('⚠ VLAN 7, but the network\'s EVPN config assigns vid 2');
    });

    it('says nothing when no NADs were loaded at all', () => {
        expect(factOf(sviFacts(ctxWith({ cudns })), 'EVPN Network')).toBeUndefined();
    });
});

describe('the CUDN drawer declares its side of the link', () => {
    it('links the VTEP and lists the VRF', () => {
        const fact = factOf(factsFor(full, 'cudn', full.cudns[0]), 'EVPN')!;
        expect(fact.provenance).toBe('declared');
        expect(fact.value).toEqual([
            { text: `VTEP: ${VTEP}`, ref: { apiVersion: 'k8s.ovn.org/v1', kind: 'VTEP', name: VTEP } },
            { text: 'MAC-VRF VNI 10010 (RT 65002:10010)' }
        ]);
    });

    it('is absent from a CUDN with no EVPN config', () => {
        const ctx = ctxWith({ cudns: [cudnNamed('plain')] });
        expect(factOf(factsFor(ctx, 'cudn', ctx.cudns[0]), 'EVPN')).toBeUndefined();
    });
});
