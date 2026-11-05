import fs from 'fs';
import path from 'path';

import { buildGraphContext, GraphContext } from '../topology/context';
import { descriptorFor } from '../topology/descriptors';
import { LaneViewState } from '../topology/lanes';
import { nodeKindRegistry } from '../topology/registry';
import { Fact, NodeKind } from '../topology/types';
import { buildNodeViewModel } from '../topology/viewModel';
import { buildTopologyEdges, TopologyEdge } from './nodeVisualizationModel';
import {
    findPatchPortsForCudn,
    getNetworkPatchPorts,
    parsePatchPortName,
    patchPortNetworkName,
    resolvePatchPortCudn
} from './nodeVisualizationSelectors';
import { ClusterUserDefinedNetwork, Interface, NodeNetworkState } from '../types';

/**
 * An overlay CUDN is tied to the node by its patch port's NAME (ovn-recon-s3t.29).
 *
 * A Layer2 or Layer3 CUDN has no bridge mapping, so nothing in its spec or in
 * NodeNetworkState links it to anything drawn: it floated. What is observable is the
 * patch pair OVN-Kubernetes builds for the network's gateway, whose name embeds the
 * network name with dashes written as dots. That is name parsing of an implementation
 * detail, so everything resting on it is inferred -- and the transform is lossy, so
 * these tests are as much about the cases that must NOT match as the ones that do.
 */
const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

const VIEW: LaneViewState = { showHiddenColumns: false, showNads: false, showLldp: false };

const cudn = (name: string, topology: 'Layer2' | 'Layer3' | 'Localnet' = 'Layer2', physicalNetworkName?: string) => ({
    apiVersion: 'k8s.ovn.org/v1',
    kind: 'ClusterUserDefinedNetwork',
    metadata: { name },
    spec: {
        network: topology === 'Localnet'
            ? { topology, localnet: { role: 'Secondary', physicalNetworkName } }
            : { topology, [topology.toLowerCase()]: { role: 'Primary', subnets: ['10.9.0.0/16'] } }
    }
}) as unknown as ClusterUserDefinedNetwork;

const nnsOf = (interfaces: Partial<Interface>[], bridgeMappings: { bridge: string; localnet: string }[] = []) => ({
    apiVersion: 'nmstate.io/v1beta1',
    kind: 'NodeNetworkState',
    metadata: { name: 'node-a' },
    status: { currentState: { interfaces, ovn: { 'bridge-mappings': bridgeMappings } } }
}) as unknown as NodeNetworkState;

/** A provider bridge, br-int's side of one patch pair, and the provider side of it. */
const patchedNode = (portName: string, bridge: string | undefined = 'br-ex'): Partial<Interface>[] => [
    { name: 'br-ex', type: 'ovs-bridge', state: 'up' },
    { name: portName, type: 'ovs-interface', state: 'ignore', controller: bridge, patch: { peer: `peer-of-${portName}` } },
    { name: `peer-of-${portName}`, type: 'ovs-interface', state: 'ignore', controller: 'br-int', patch: { peer: portName } }
];

const primaryNns = fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json');
const primaryCudns = fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json');
const bondedNns = fixture<NodeNetworkState>('nns', 'bonded-lldp.json');
const evpnNns = fixture<NodeNetworkState>('nns', 'evpn-vxlan.json');

const interfacesOf = (nns: NodeNetworkState): Interface[] => nns.status?.currentState?.interfaces ?? [];
const patchEdges = (ctx: GraphContext): TopologyEdge[] =>
    buildTopologyEdges(ctx, VIEW).edges.filter((e) => e.rule === 'patch-port-cudn');

describe('reading a patch port name', () => {
    it('reads the gateway form: bridge, network, node', () => {
        expect(parsePatchPortName('patch-br-ex_cluster_udn_example.p.cudn_worker-1-to-br-int')).toEqual({
            form: 'gateway',
            side: 'provider',
            networkName: 'cluster_udn_example.p.cudn',
            bridge: 'br-ex',
            node: 'worker-1'
        });
    });

    it('reads the unqualified gateway pair as naming no network: the cluster default', () => {
        expect(parsePatchPortName('patch-br-ex_worker-1-to-br-int'))
            .toEqual({ form: 'gateway', side: 'provider', bridge: 'br-ex', node: 'worker-1' });
    });

    it('keeps a fully qualified node name whole', () => {
        // Dots and dashes in the node are not separators; only the last underscore is.
        expect(parsePatchPortName('patch-br-ex_worker-2.example.com-to-br-int'))
            .toMatchObject({ form: 'gateway', bridge: 'br-ex', node: 'worker-2.example.com' });
        expect(parsePatchPortName('patch-br-ex_cluster_udn_demo.evpn.vni10010_worker-evpn-to-br-int'))
            .toMatchObject({ networkName: 'cluster_udn_demo.evpn.vni10010', node: 'worker-evpn' });
    });

    it('reads the localnet form, which names a network and no bridge', () => {
        expect(parsePatchPortName('patch-tenant.b.db_ovn_localnet_port-to-br-int'))
            .toEqual({ form: 'localnet', side: 'provider', networkName: 'tenant.b.db' });
    });

    it('does not mistake a CUDN localnet port for a gateway port on a bridge called "cluster"', () => {
        expect(parsePatchPortName('patch-cluster_udn_vlan.1924_ovn_localnet_port-to-br-int'))
            .toEqual({ form: 'localnet', side: 'provider', networkName: 'cluster_udn_vlan.1924' });
    });

    it('reads the br-int end of either form to the same network', () => {
        expect(parsePatchPortName('patch-br-int-to-br-ex_cluster_udn_example.p.cudn_worker-1')).toEqual({
            form: 'gateway',
            side: 'integration',
            networkName: 'cluster_udn_example.p.cudn',
            bridge: 'br-ex',
            node: 'worker-1'
        });
        expect(parsePatchPortName('patch-br-int-to-tenant.b.db_ovn_localnet_port'))
            .toEqual({ form: 'localnet', side: 'integration', networkName: 'tenant.b.db' });
    });

    it('takes the bridge from the controller when the bridge name has an underscore in it', () => {
        // Splitting at the first underscore would call the bridge "br" and the network "ex1".
        expect(parsePatchPortName('patch-br_ex1_worker-1-to-br-int', 'br_ex1'))
            .toEqual({ form: 'gateway', side: 'provider', bridge: 'br_ex1', node: 'worker-1' });
    });

    it('is undefined for anything that is not one of the two forms', () => {
        ['br-ex', 'ovn-k8s-mp0', 'patch-a-to-b', 'patch-noseparator-to-br-int',
            'patch-_ovn_localnet_port-to-br-int', 'patch-br-ex__worker-1-to-br-int',
            'patch-br-ex_-to-br-int']
            .forEach((name) => expect(parsePatchPortName(name)).toBeUndefined());
    });

    it('writes a network name the way OVN-Kubernetes does, which loses information', () => {
        expect(patchPortNetworkName('example-p-cudn')).toBe('example.p.cudn');
        // The whole reason nothing here runs the transform backwards.
        expect(patchPortNetworkName('a-b')).toBe(patchPortNetworkName('a.b'));
    });
});

describe('the patch pairs on each real capture', () => {
    it('primary-cudn-vrf: the Primary CUDN, the default network, and one Localnet CUDN', () => {
        expect(getNetworkPatchPorts(interfacesOf(primaryNns))).toEqual([
            {
                form: 'gateway',
                networkName: 'cluster_udn_example.p.cudn',
                isDefaultNetwork: false,
                bridge: 'br-ex',
                node: 'worker-1',
                portName: 'patch-br-ex_cluster_udn_example.p.cudn_worker-1-to-br-int',
                peerName: 'patch-br-int-to-br-ex_cluster_udn_example.p.cudn_worker-1'
            },
            {
                form: 'gateway',
                networkName: undefined,
                isDefaultNetwork: true,
                bridge: 'br-ex',
                node: 'worker-1',
                portName: 'patch-br-ex_worker-1-to-br-int',
                peerName: 'patch-br-int-to-br-ex_worker-1'
            },
            {
                form: 'localnet',
                networkName: 'cluster_udn_vlan.1924',
                isDefaultNetwork: false,
                bridge: 'br-vmdata',
                node: undefined,
                portName: 'patch-cluster_udn_vlan.1924_ovn_localnet_port-to-br-int',
                peerName: 'patch-br-int-to-cluster_udn_vlan.1924_ovn_localnet_port'
            }
        ]);
    });

    it('evpn-vxlan: the EVPN CUDN and the default network, both onto br-ex', () => {
        const ports = getNetworkPatchPorts(interfacesOf(evpnNns));
        expect(ports.map((p) => [p.networkName, p.bridge, p.node, p.isDefaultNetwork])).toEqual([
            ['cluster_udn_demo.evpn.vni10010', 'br-ex', 'worker-evpn', false],
            [undefined, 'br-ex', 'worker-evpn', true]
        ]);
    });

    it('bonded-lldp: one default pair and six localnet ports, one of them on no bridge', () => {
        const ports = getNetworkPatchPorts(interfacesOf(bondedNns));
        expect(ports.filter((p) => p.isDefaultNetwork).map((p) => [p.bridge, p.node]))
            .toEqual([['br-ex', 'worker-2.example.com']]);

        const localnet = ports.filter((p) => p.form === 'localnet');
        expect(localnet.map((p) => p.networkName).sort()).toEqual([
            'shared.infra.sec', 'shared.infra.sys', 'tenant.a.infra', 'tenant.b.db', 'tenant.d.app', 'tenant.d.db'
        ]);
        // Five reach ovs-vm. The sixth is a half-configured mapping's leftover: down,
        // no controller, no peer. Parsing must not invent a bridge for it.
        expect(localnet.filter((p) => p.bridge === 'ovs-vm')).toHaveLength(5);
        expect(localnet.find((p) => p.networkName === 'tenant.a.infra')).toMatchObject({
            bridge: undefined,
            peerName: undefined,
            portName: 'patch-tenant.a.infra_ovn_localnet_port-to-br-int'
        });
    });

    it('counts each pair once, from the provider end', () => {
        // Six patch ports in the capture, three pairs.
        const all = interfacesOf(primaryNns).filter((i) => i.name.startsWith('patch-'));
        expect(all).toHaveLength(6);
        expect(getNetworkPatchPorts(interfacesOf(primaryNns))).toHaveLength(3);
    });
});

describe('resolving a patch pair to a CUDN', () => {
    const ports = getNetworkPatchPorts(interfacesOf(primaryNns));

    it('matches the Primary CUDN through the dash-to-dot transform', () => {
        expect(resolvePatchPortCudn(ports[0], primaryCudns)).toBe('example-p-cudn');
    });

    it('matches a Localnet CUDN through its localnet-form port', () => {
        expect(resolvePatchPortCudn(ports[2], primaryCudns)).toBe('vlan-1924');
    });

    it('matches the cluster default network to no CUDN', () => {
        expect(resolvePatchPortCudn(ports[1], primaryCudns)).toBeUndefined();
    });

    it('matches nothing when no CUDN carries the name', () => {
        expect(resolvePatchPortCudn(ports[0], [])).toBeUndefined();
        expect(resolvePatchPortCudn(ports[0], [cudn('example-q-cudn')])).toBeUndefined();
    });

    it('does not match a CUDN to a network that merely shares its name', () => {
        // tenant.b.db carries no cluster_udn_ prefix: it is a network some
        // NetworkAttachmentDefinition named, not the CUDN called tenant-b-db.
        const legacy = getNetworkPatchPorts(interfacesOf(bondedNns)).find((p) => p.networkName === 'tenant.b.db')!;
        expect(legacy.bridge).toBe('ovs-vm');
        expect(resolvePatchPortCudn(legacy, [cudn('tenant-b-db', 'Localnet', 'tenant-b-db')])).toBeUndefined();
    });

    describe('when two CUDN names collide after the transform', () => {
        // a-b and a.b are both valid resource names, and both become a.b.
        const colliding = [cudn('a-b'), cudn('a.b')];
        const interfaces = patchedNode('patch-br-ex_cluster_udn_a.b_node-a-to-br-int') as Interface[];
        const [port] = getNetworkPatchPorts(interfaces);

        it('matches neither, rather than guessing', () => {
            expect(port).toMatchObject({ networkName: 'cluster_udn_a.b', bridge: 'br-ex' });
            expect(resolvePatchPortCudn(port, colliding)).toBeUndefined();
        });

        it('reports the pair as ambiguous to both, and matched to neither', () => {
            colliding.forEach((c) => {
                const found = findPatchPortsForCudn(c.metadata?.name, colliding, interfaces);
                expect(found.matched).toEqual([]);
                expect(found.ambiguous).toEqual([{ port, candidates: ['a-b', 'a.b'] }]);
            });
        });

        it('matches again once only one of them exists', () => {
            expect(resolvePatchPortCudn(port, [cudn('a.b')])).toBe('a.b');
            expect(resolvePatchPortCudn(port, [cudn('a-b')])).toBe('a-b');
        });

        it('draws no edge to either', () => {
            const ctx = buildGraphContext({ nns: nnsOf(interfaces), cudns: colliding });
            expect(patchEdges(ctx)).toEqual([]);
        });
    });

    describe('when the patch port is on no bridge', () => {
        const interfaces = [
            { name: 'patch-br-ex_cluster_udn_orphan_node-a-to-br-int', type: 'ovs-interface', state: 'down' }
        ] as Interface[];
        const orphaned = [cudn('orphan')];

        it('matches nothing: there is no bridge to link the network to', () => {
            const [port] = getNetworkPatchPorts(interfaces);
            // The name still spells a bridge; the port is on none, and that is what counts.
            expect(port).toMatchObject({ networkName: 'cluster_udn_orphan', bridge: undefined });
            expect(resolvePatchPortCudn(port, orphaned)).toBeUndefined();
            expect(findPatchPortsForCudn('orphan', orphaned, interfaces)).toEqual({ matched: [], ambiguous: [] });
        });

        it('draws no edge and reports nothing dangling', () => {
            const result = buildTopologyEdges(buildGraphContext({ nns: nnsOf(interfaces), cudns: orphaned }), VIEW);
            expect(result.edges).toEqual([]);
            expect(result.unresolved).toEqual([]);
        });
    });
});

describe('an overlay CUDN is linked to the bridge its patch pair reaches', () => {
    const ctx = buildGraphContext({ nns: primaryNns, cudns: primaryCudns });
    const edges = buildTopologyEdges(ctx, VIEW).edges;

    it('draws one inferred reference edge from the bridge to the Primary CUDN', () => {
        expect(patchEdges(ctx)).toHaveLength(1);
        expect(patchEdges(ctx)[0]).toMatchObject({
            source: 'iface:br-ex',
            target: 'cudn:example-p-cudn',
            rule: 'patch-port-cudn',
            kind: 'reference',
            provenance: 'inferred'
        });
    });

    it('says which port it read and what it did to the name', () => {
        const { rationale } = patchEdges(ctx)[0];
        expect(rationale).toContain('patch-br-ex_cluster_udn_example.p.cudn_worker-1-to-br-int');
        expect(rationale).toContain('cluster_udn_example.p.cudn');
        expect(rationale).toContain('dashes written as dots');
        expect(rationale).toContain('Inferred');
    });

    it('agrees with the integration bridge about which bridge the pair reaches', () => {
        // The CUDN edge follows the provider port's controller; br-int's patch-peer
        // edge follows patch.peer from the other end. Same pair, same bridge.
        const peer = edges.find((e) => e.rule === 'patch-peer' && e.rationale.includes('cluster_udn_example.p.cudn'));
        expect(peer).toMatchObject({ source: 'iface:br-ex', target: 'intbr:br-int' });
        expect(patchEdges(ctx)[0].source).toBe(peer!.source);
    });

    it('gives the Primary CUDN something to hang from besides its VRF', () => {
        const into = edges.filter((e) => e.target === 'cudn:example-p-cudn').map((e) => e.rule).sort();
        expect(into).toEqual(['patch-port-cudn', 'primary-network']);
    });

    it('draws no second edge for a Localnet CUDN: its patch pair corroborates the mapping', () => {
        // vlan-1924 has a localnet-form pair onto br-vmdata, the bridge its mapping
        // already names. One attachment, one line.
        const into = edges.filter((e) => e.target === 'cudn:vlan-1924').map((e) => [e.source, e.rule]);
        expect(into).toEqual([['ovn:physnet-vmdata', 'physical-network-name']]);
    });

    it('draws nothing for the cluster default network, which is not a CUDN', () => {
        expect(patchEdges(ctx).some((e) => e.rationale.includes('patch-br-ex_worker-1-to-br-int'))).toBe(false);
    });

    it('links the EVPN CUDN on the EVPN capture', () => {
        // The capture has no companion CUDN fixture, so the CUDN is supplied here;
        // its name is the patch port's with the dots read as dashes.
        const evpn = buildGraphContext({ nns: evpnNns, cudns: [cudn('demo-evpn-vni10010')] });
        expect(patchEdges(evpn)).toEqual([expect.objectContaining({
            source: 'iface:br-ex',
            target: 'cudn:demo-evpn-vni10010',
            provenance: 'inferred'
        })]);
        expect(patchEdges(evpn)[0].rationale)
            .toContain('patch-br-ex_cluster_udn_demo.evpn.vni10010_worker-evpn-to-br-int');
    });

    it('still floats a CUDN the node has no patch pair for', () => {
        const evpn = buildGraphContext({ nns: evpnNns, cudns: [cudn('not-on-this-node')] });
        expect(patchEdges(evpn)).toEqual([]);
    });

    it('draws nothing on the bonded capture, with or without namesake CUDNs', () => {
        expect(patchEdges(buildGraphContext({ nns: bondedNns }))).toEqual([]);
        const namesakes = ['tenant-a-infra', 'tenant-b-db', 'shared-infra-sec']
            .map((name) => cudn(name, 'Localnet', name));
        expect(patchEdges(buildGraphContext({ nns: bondedNns, cudns: namesakes }))).toEqual([]);
    });

    it('reports a bridge nmstate does not list instead of dropping the edge', () => {
        const interfaces = patchedNode('patch-br-phantom_cluster_udn_blue_node-a-to-br-int', 'br-phantom');
        const result = buildTopologyEdges(
            buildGraphContext({ nns: nnsOf(interfaces), cudns: [cudn('blue')] }), VIEW);
        expect(result.edges.filter((e) => e.rule === 'patch-port-cudn')).toEqual([]);
        expect(result.unresolved).toContainEqual({
            rule: 'patch-port-cudn', reference: 'br-phantom', from: 'cudn:blue'
        });
    });
});

describe('the drawer names the patch pair', () => {
    const factsFor = (ctx: GraphContext, kind: NodeKind, item: unknown): Fact[] => {
        const node = buildNodeViewModel(item, descriptorFor(kind as never)!, ctx);
        return nodeKindRegistry[kind].facts!(node, ctx);
    };
    const cudnFact = (ctx: GraphContext, name: string): Fact | undefined =>
        factsFor(ctx, 'cudn', ctx.cudns.find((c) => c.metadata?.name === name))
            .find((f) => f.label === 'Patch Ports');
    const texts = (fact: Fact | undefined) => (fact?.value as { text: string }[]).map((v) => v.text);

    const ctx = buildGraphContext({ nns: primaryNns, cudns: primaryCudns });

    it('on the overlay CUDN, with the same provenance as its edge', () => {
        const fact = cudnFact(ctx, 'example-p-cudn')!;
        expect(fact.provenance).toBe('inferred');
        expect(texts(fact)).toEqual([
            'br-ex: patch-br-ex_cluster_udn_example.p.cudn_worker-1-to-br-int'
            + ' ↔ patch-br-int-to-br-ex_cluster_udn_example.p.cudn_worker-1'
        ]);
        expect(fact.hint).toContain('Matched by name');
        expect(fact.hint).toContain('dashes written as dots');
        expect(fact.hint).toContain('matched to neither');
    });

    it('on a Localnet CUDN, as corroboration of its bridge mapping', () => {
        expect(texts(cudnFact(ctx, 'vlan-1924'))).toEqual([
            'br-vmdata: patch-cluster_udn_vlan.1924_ovn_localnet_port-to-br-int'
            + ' ↔ patch-br-int-to-cluster_udn_vlan.1924_ovn_localnet_port',
            'Agrees with bridge mapping physnet-vmdata → br-vmdata'
        ]);
    });

    it('flags a Localnet patch pair that reaches a different bridge than the mapping names', () => {
        const interfaces = patchedNode('patch-cluster_udn_red_ovn_localnet_port-to-br-int', 'br-ex');
        const disagreeing = buildGraphContext({
            nns: nnsOf(interfaces, [{ bridge: 'br-other', localnet: 'physnet-red' }]),
            cudns: [cudn('red', 'Localnet', 'physnet-red')]
        });
        expect(texts(cudnFact(disagreeing, 'red'))[1])
            .toBe('⚠ bridge mapping physnet-red names br-other, not br-ex');
    });

    it('says nothing on a CUDN with no patch pair on this node', () => {
        // machinenet and vlan-1926 are Localnet CUDNs the capture shows no pair for.
        // Absence is not a finding, so there is no fact rather than an empty one.
        expect(cudnFact(ctx, 'machinenet')).toBeUndefined();
        expect(cudnFact(ctx, 'vlan-1926')).toBeUndefined();
    });

    it('says so when the name fits two CUDNs', () => {
        const colliding = buildGraphContext({
            nns: nnsOf(patchedNode('patch-br-ex_cluster_udn_a.b_node-a-to-br-int')),
            cudns: [cudn('a-b'), cudn('a.b')]
        });
        ['a-b', 'a.b'].forEach((name) => {
            const fact = cudnFact(colliding, name)!;
            expect(fact.provenance).toBe('inferred');
            expect(texts(fact)).toEqual([
                '⚠ patch-br-ex_cluster_udn_a.b_node-a-to-br-int on br-ex fits a-b and a.b alike — matched to neither'
            ]);
        });
    });

    describe('on the integration bridge', () => {
        const patched = (ctxFor: GraphContext): Fact =>
            factsFor(ctxFor, 'integration-bridge', ctxFor.integrationBridge)
                .find((f) => f.label === 'Patched Networks')!;

        it('identifies the unqualified pair as the cluster default network', () => {
            const fact = patched(ctx);
            expect(fact.provenance).toBe('inferred');
            expect(fact.hint).toContain('cluster default network');
            expect(texts(fact)).toEqual([
                'br-ex: CUDN example-p-cudn',
                'br-ex: cluster default network',
                'br-vmdata: CUDN vlan-1924 (localnet)'
            ]);
        });

        it('names a network no CUDN accounts for by its embedded name', () => {
            expect(texts(patched(buildGraphContext({ nns: evpnNns })))).toEqual([
                'br-ex: network cluster_udn_demo.evpn.vni10010',
                'br-ex: cluster default network'
            ]);
        });

        it('shows the half-configured localnet port as being on no bridge', () => {
            const lines = texts(patched(buildGraphContext({ nns: bondedNns })));
            expect(lines).toHaveLength(7);
            expect(lines).toContain('br-ex: cluster default network');
            expect(lines).toContain('ovs-vm: network tenant.b.db (localnet)');
            expect(lines).toContain(
                'no bridge: network tenant.a.infra (localnet)'
                + ' — patch-tenant.a.infra_ovn_localnet_port-to-br-int is on no bridge');
        });
    });
});
