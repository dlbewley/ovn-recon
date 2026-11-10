import fs from 'fs';
import path from 'path';

import { buildGraphContext } from './context';
import { descriptorFor } from './descriptors';
import { groupBridgePorts, nodeKindRegistry } from './registry';
import { buildNodeViewModel } from './viewModel';
import { Fact, KernelRoutesTable, NodeKind } from './types';
import { buildKernelRouteTables, routeTablesVia } from '../components/kernelRoutes';
import {
    ClusterUserDefinedNetwork, NodeNetworkConfigurationEnactment, NodeNetworkState, RouteAdvertisements
} from '../types';

/**
 * Unit tests for the per-kind facts() builders (ovn-recon-s3t.12).
 *
 * The point of the Fact model is that this file can exist: drawer content used
 * to be JSX closed over `any`, assertable only by rendering the component.
 * These tests pin the CONTRACT the acceptance names -- every heuristic-derived
 * value is marked inferred and carries a hint naming its rule.
 */
const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

const nns = fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json');
const cudns = fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json');

// The fixture set carries no RouteAdvertisements, so the VRF matching heuristic
// is exercised with a hand-built one whose name equals the VRF interface name.
const routeAdvertisements: RouteAdvertisements[] = [
    { apiVersion: 'k8s.ovn.org/v1', kind: 'RouteAdvertisements', metadata: { name: 'example-p-cudn' }, spec: {} } as RouteAdvertisements
];

const ctx = buildGraphContext({ nns, cudns, routeAdvertisements });

const factsFor = (kind: NodeKind, item: unknown, type = kind): Fact[] => {
    const node = buildNodeViewModel(item, descriptorFor(type as never)!, ctx);
    return nodeKindRegistry[kind].facts!(node, ctx);
};

const byLabel = (facts: Fact[], label: string): Fact => {
    const fact = facts.find((f) => f.label === label);
    if (!fact) throw new Error(`no fact labelled "${label}". Present: ${facts.map((f) => f.label).join(', ')}`);
    return fact;
};

describe('facts builders', () => {
    const vrf = ctx.interfaces.find((i) => i.type === 'vrf')!;
    const vlan = ctx.interfaces.find((i) => i.type === 'vlan')!;
    const bridge = ctx.interfaces.find((i) => i.name === 'br-vmdata' && i.type === 'ovs-bridge')!;
    const cudn = ctx.cudns.find((c) => c.metadata?.name === 'machinenet')!;

    describe('every kind marks its heuristics inferred, with a hint naming the rule', () => {
        it('VRF: br-int ports come from set intersection', () => {
            const fact = byLabel(factsFor('vrf', vrf), 'br-int Ports');
            expect(fact.provenance).toBe('inferred');
            expect(fact.hint).toContain('intersection');
            expect(fact.value).toEqual([{ text: 'ovn-k8s-mp3 10.1.2.2/24' }]);
        });

        it('VRF: the RouteAdvertisements association is a name-truncation guess', () => {
            const facts = factsFor('vrf', vrf);
            const ra = byLabel(facts, 'Route Advertisement');
            expect(ra.provenance).toBe('inferred');
            expect(ra.hint).toContain('15 characters');
            expect(ra.value).toEqual([{
                text: 'example-p-cudn',
                ref: { apiVersion: 'k8s.ovn.org/v1', kind: 'RouteAdvertisements', name: 'example-p-cudn' }
            }]);
            expect(byLabel(facts, 'Matched CUDNs').provenance).toBe('inferred');
        });

        it('CUDN: the namespaceSelector is the declared rule beside the inferred outcome', () => {
            const facts = factsFor('cudn', cudn);
            const selector = byLabel(facts, 'Namespace Selector');
            expect(selector.provenance).toBe('declared');
            expect(selector.value).toEqual([{
                text: 'network/machine=',
                href: '/api-resource/cluster/core~v1~Namespace/instances?label=network%2Fmachine%3D'
            }]);
            expect(selector.hint).toContain('namespaceSelector');
            // The declared rule reads directly above its outcome.
            expect(facts.findIndex((f) => f.label === 'Namespace Selector'))
                .toBe(facts.findIndex((f) => f.label === 'Namespaces') - 1);
        });

        it('CUDN: namespaces are scraped out of a condition message', () => {
            const fact = byLabel(factsFor('cudn', cudn), 'Namespaces');
            expect(fact.provenance).toBe('inferred');
            expect(fact.hint).toContain('condition message');
            expect(fact.value).toEqual([{
                text: 'demo-mirror',
                ref: {
                    apiVersion: 'k8s.cni.cncf.io/v1', kind: 'NetworkAttachmentDefinition',
                    name: 'machinenet', namespace: 'demo-mirror'
                }
            }]);
        });

        it('NAD: an unparseable config falls back to pattern extraction', () => {
            const nad = {
                metadata: { name: 'vm-net', namespace: 'ns1' },
                // Trailing comma: invalid JSON, so only the regex fallback can read it.
                spec: { config: '{"type": "cnv-bridge", "bridge": "br-vmdata",}' }
            };
            const facts = factsFor('nad', nad);
            const bridgeFact = byLabel(facts, 'Bridge');
            expect(bridgeFact.provenance).toBe('inferred');
            expect(bridgeFact.hint).toContain('did not parse');
            expect(bridgeFact.value).toEqual([{ text: 'br-vmdata' }]);
            expect(byLabel(facts, 'CNI Type').provenance).toBe('inferred');
        });

        it('NAD: a parseable config is declared, not inferred', () => {
            const nad = {
                metadata: { name: 'vm-net', namespace: 'ns1' },
                spec: { config: '{"type": "cnv-bridge", "bridge": "br-vmdata", "name": "vmnet"}' }
            };
            const facts = factsFor('nad', nad);
            expect(byLabel(facts, 'Bridge').provenance).toBe('declared');
            expect(byLabel(facts, 'CNI Type').value).toBe('cnv-bridge');
            expect(byLabel(facts, 'Network Name').value).toBe('vmnet');
        });
    });

    describe('observed values stay observed', () => {
        it('interface facts read straight off NNS', () => {
            const facts = factsFor('interface', vlan, 'vlan' as NodeKind);
            expect(byLabel(facts, 'Type').provenance).toBe('observed');
            const vlanFact = byLabel(facts, 'VLAN');
            expect(vlanFact.provenance).toBe('observed');
            expect(vlanFact.value).toEqual([{ text: 'Base: ens224' }, { text: 'ID: 456' }]);
        });

        it('a bridge groups its ports by role (ovn-recon-dp7.1)', () => {
            const fact = byLabel(factsFor('interface', bridge, 'bridge' as NodeKind), 'Uplink');
            expect(fact.provenance).toBe('observed');
            expect((fact.value as { text: string }[]).map((v) => v.text)).toContain('ens224');
        });

        it('VRF routes are a kernel route table of the VRF\'s own table', () => {
            const fact = byLabel(factsFor('vrf', vrf), 'Routes');
            expect(fact.provenance).toBe('observed');
            const value = fact.value as KernelRoutesTable;
            expect(value.table).toBe('kernel-routes');
            expect(value.viaInterface).toBeUndefined();
            expect(value.routes.map((route) => route.destination).sort())
                .toEqual(['0.0.0.0/0', '169.254.0.16/32', '169.254.0.3/32', '172.30.0.0/16']);
            expect(value.routes.find((route) => route.destination === '0.0.0.0/0')).toMatchObject({
                nextHopAddress: '192.0.2.1', nextHopInterface: 'br-ex', tableId: 5775
            });
        });

        it('a bridge lists the routes leaving through it, from every table', () => {
            const brEx = ctx.interfaces.find((i) => i.name === 'br-ex' && i.type === 'ovs-bridge')!;
            const fact = byLabel(factsFor('interface', brEx, 'bridge' as NodeKind), 'Routes via this interface');
            expect(fact.provenance).toBe('observed');
            expect(fact.hint).toContain('next-hop-interface is br-ex');
            const value = fact.value as KernelRoutesTable;
            expect(value).toMatchObject({ table: 'kernel-routes', viaInterface: 'br-ex' });
            const tables = routeTablesVia(buildKernelRouteTables(value.routes), 'br-ex');
            expect(tables.map((table) => table.tableId)).toEqual([254, 5775]);
        });

        it('an interface no route leaves through has no routes fact', () => {
            const facts = factsFor('interface', vlan, 'vlan' as NodeKind);
            expect(facts.some((f) => f.label === 'Routes via this interface')).toBe(false);
        });
    });

    describe('Configured By: which NNCP made this (ovn-recon-s3t.34)', () => {
        const enactments = fixture<NodeNetworkConfigurationEnactment[]>('nnce', 'primary-cudn-vrf.json');
        const nncpCtx = buildGraphContext({ nns, cudns, enactments });
        const nncpFactsFor = (kind: NodeKind, item: unknown, type = kind): Fact[] => {
            const node = buildNodeViewModel(item, descriptorFor(type as never)!, nncpCtx);
            return nodeKindRegistry[kind].facts!(node, nncpCtx);
        };

        it('a claimed interface links to its policy, observed off the enactment', () => {
            const iface = nncpCtx.interfaces.find((i) => i.name === 'ens224.456')!;
            const fact = byLabel(nncpFactsFor('interface', iface, 'vlan' as NodeKind), 'Configured By');
            expect(fact.provenance).toBe('observed');
            expect(fact.value).toEqual([{
                text: 'storage-vlan',
                ref: { apiVersion: 'nmstate.io/v1', kind: 'NodeNetworkConfigurationPolicy', name: 'storage-vlan' }
            }]);
        });

        it('a claimed bridge mapping links to its policy', () => {
            const mapping = nncpCtx.bridgeMappings.find((m) => m.localnet === 'physnet-vmdata')!;
            const fact = byLabel(nncpFactsFor('ovn-mapping', mapping), 'Configured By');
            expect(fact.provenance).toBe('observed');
            expect((fact.value as { text: string }[]).map((v) => v.text)).toEqual(['br-vmdata']);
        });

        it('an unclaimed interface reads as installer or OVN-Kubernetes created', () => {
            const iface = nncpCtx.interfaces.find((i) => i.name === 'ens192')!;
            const fact = byLabel(nncpFactsFor('interface', iface, 'physical' as NodeKind), 'Configured By');
            expect(fact.provenance).toBe('inferred');
            expect(fact.value).toContain('installer or OVN-Kubernetes');
        });

        it('the OVN-created VRF is likewise unclaimed', () => {
            const vrfIface = nncpCtx.interfaces.find((i) => i.type === 'vrf')!;
            const fact = byLabel(nncpFactsFor('vrf', vrfIface), 'Configured By');
            expect(fact.value).toContain('installer or OVN-Kubernetes');
        });

        it('a policy that is not Available shows its condition, not just its name', () => {
            const failing = JSON.parse(JSON.stringify(enactments)) as NodeNetworkConfigurationEnactment[];
            failing[1].status!.conditions = [
                { type: 'Available', status: 'False' },
                { type: 'Failing', status: 'True', reason: 'FailedToConfigure' }
            ];
            const failCtx = buildGraphContext({ nns, cudns, enactments: failing });
            const iface = failCtx.interfaces.find((i) => i.name === 'ens224.456')!;
            const node = buildNodeViewModel(iface, descriptorFor('vlan')!, failCtx);
            const fact = byLabel(nodeKindRegistry.interface.facts!(node, failCtx), 'Configured By');
            expect((fact.value as { text: string }[])[0].text).toBe('storage-vlan — Failing');
        });

        it('two policies claiming one interface both show, flagged as overlap', () => {
            const overlapping = [
                ...enactments,
                {
                    apiVersion: 'nmstate.io/v1beta1',
                    kind: 'NodeNetworkConfigurationEnactment',
                    metadata: {
                        name: 'worker-1.storage-vlan-copy',
                        labels: { 'nmstate.io/node': 'worker-1', 'nmstate.io/policy': 'storage-vlan-copy' }
                    },
                    status: {
                        desiredState: { interfaces: [{ name: 'ens224.456', type: 'vlan' }] },
                        conditions: [{ type: 'Available', status: 'True' }]
                    }
                } as NodeNetworkConfigurationEnactment
            ];
            const overlapCtx = buildGraphContext({ nns, cudns, enactments: overlapping });
            const iface = overlapCtx.interfaces.find((i) => i.name === 'ens224.456')!;
            const node = buildNodeViewModel(iface, descriptorFor('vlan')!, overlapCtx);
            const fact = byLabel(nodeKindRegistry.interface.facts!(node, overlapCtx), 'Configured By');
            const texts = (fact.value as { text: string }[]).map((v) => v.text);
            expect(texts).toContain('storage-vlan');
            expect(texts).toContain('storage-vlan-copy');
            expect(texts.some((t) => t.includes('more than one policy'))).toBe(true);
        });

        it('with no enactments at all, nothing is claimed either way', () => {
            // ctx (module scope) has none: imported NNS, or no nmstate operator.
            const iface = ctx.interfaces.find((i) => i.name === 'ens192')!;
            const facts = factsFor('interface', iface, 'physical' as NodeKind);
            expect(facts.some((f) => f.label === 'Configured By')).toBe(false);
        });
    });

    describe('a VRF serves its Primary network (ovn-recon-s3t.28)', () => {
        it('links the VRF to the same-name Primary CUDN, matched by subnet and name', () => {
            const facts = factsFor('vrf', vrf);
            const serves = byLabel(facts, 'Serves Primary Network');
            expect(serves.provenance).toBe('inferred');
            expect(serves.hint).toContain('side effect');
            expect(serves.hint).toContain('subnet and name');
            expect(serves.value).toEqual([{
                text: 'example-p-cudn (ClusterUserDefinedNetwork)',
                ref: { apiVersion: 'k8s.ovn.org/v1', kind: 'ClusterUserDefinedNetwork', name: 'example-p-cudn' }
            }]);
        });

        it('shows no State row and no Matched CUDNs row without a RouteAdvertisement', () => {
            const bare = buildGraphContext({ nns, cudns });
            const bareVrf = bare.interfaces.find((i) => i.type === 'vrf')!;
            const node = buildNodeViewModel(bareVrf, descriptorFor('vrf')!, bare);
            const facts = nodeKindRegistry.vrf.facts!(node, bare);

            expect(facts.some((f) => f.label === 'State')).toBe(false);
            expect(facts.some((f) => f.label === 'Matched CUDNs')).toBe(false);
            expect(facts.some((f) => f.label === 'Serves Primary Network')).toBe(true);
        });
    });

    describe('findPrimaryNetworkForVrf', () => {
        const { findPrimaryNetworkForVrf } = jest.requireActual('../components/nodeVisualizationSelectors');
        const primaryLayer2 = (name: string, subnets: string[]) => ({
            metadata: { name },
            spec: { network: { topology: 'Layer2', layer2: { role: 'Primary', subnets } } }
        });

        it('survives a network name longer than the 15-character interface limit', () => {
            const long = primaryLayer2('a-very-long-network-name', ['192.0.2.0/24']);
            const shortVrf = { name: 'a-very-long-net', type: 'vrf' };
            const match = findPrimaryNetworkForVrf(shortVrf, [long], [], []);
            expect(match).toMatchObject({ kind: 'cudn', name: 'a-very-long-network-name', signals: ['name'] });
        });

        it('never matches Localnet or Secondary networks, whatever their name', () => {
            const localnet = {
                metadata: { name: 'vrfname' },
                spec: { network: { topology: 'Localnet', localnet: { physicalNetworkName: 'p', role: 'Secondary' } } }
            };
            const secondary = {
                metadata: { name: 'vrfname' },
                spec: { network: { topology: 'Layer2', layer2: { role: 'Secondary', subnets: ['10.0.0.0/24'] } } }
            };
            expect(findPrimaryNetworkForVrf({ name: 'vrfname', type: 'vrf' }, [localnet, secondary], [], []))
                .toBeUndefined();
        });

        it('never matches on subnet alone: UDN/CUDN subnets are not unique', () => {
            // Networks map to OVS switches behind OVN routers that NAT
            // overlapping ranges apart, so subnet containment cannot identify
            // a network by itself.
            const otherName = primaryLayer2('some-other-network', ['10.1.2.0/24']);
            const brIntPort = {
                name: 'ovn-k8s-mp9', type: 'ovs-interface', controller: 'br-int',
                ipv4: { address: [{ ip: '10.1.2.2', 'prefix-length': 24 }] }
            };
            const vrfIface = { name: 'unrelated-vrf', type: 'vrf', vrf: { port: ['ovn-k8s-mp9'] } };
            expect(findPrimaryNetworkForVrf(vrfIface, [otherName], [], [brIntPort])).toBeUndefined();
        });

        it('breaks a truncated-prefix tie with the subnet signal', () => {
            const contender = primaryLayer2('shared-prefix-xx-one', ['192.0.2.0/24']);
            const winner = primaryLayer2('shared-prefix-xx-two', ['10.1.2.0/24']);
            const brIntPort = {
                name: 'ovn-k8s-mp9', type: 'ovs-interface', controller: 'br-int',
                ipv4: { address: [{ ip: '10.1.2.2', 'prefix-length': 24 }] }
            };
            const vrfIface = { name: 'shared-prefix-x', type: 'vrf', vrf: { port: ['ovn-k8s-mp9'] } };
            expect(findPrimaryNetworkForVrf(vrfIface, [contender, winner], [], [brIntPort]))
                .toMatchObject({ name: 'shared-prefix-xx-two', signals: ['subnet', 'name'] });
        });

        it('matches a Primary UDN too', () => {
            const udn = {
                metadata: { name: 'blue', namespace: 'ns1' },
                spec: { topology: 'Layer3', layer3: { role: 'Primary', subnets: ['10.9.0.0/16'] } }
            };
            expect(findPrimaryNetworkForVrf({ name: 'blue', type: 'vrf' }, [], [udn], []))
                .toMatchObject({ kind: 'udn', name: 'blue', namespace: 'ns1', signals: ['name'] });
        });
    });

    describe('Type rows link to the API resource reference (ovn-recon-s3t.39)', () => {
        it('names the CUDN kind alone, without the topology prefix', () => {
            expect(byLabel(factsFor('cudn', cudn), 'Type').value).toEqual([{
                text: 'ClusterUserDefinedNetwork',
                href: '/api-resource/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/'
            }]);
        });

        it('links interface-family kinds to NodeNetworkState, their data source', () => {
            const typeFact = byLabel(factsFor('interface', vlan, 'vlan' as NodeKind), 'Type');
            expect(typeFact.value).toEqual([{
                text: 'vlan',
                href: '/api-resource/cluster/nmstate.io~v1beta1~NodeNetworkState/'
            }]);
        });
    });

    describe('the synthesized integration bridge (ovn-recon-s3t.46)', () => {
        it('is derived from the ports declaring it as controller', () => {
            expect(ctx.integrationBridge?.name).toBe('br-int');
            expect(ctx.integrationBridge?.ports.map((p) => p.name).sort()).toEqual([
                'br-int', 'ovn-k8s-mp0', 'ovn-k8s-mp3',
                'patch-br-int-to-br-ex_cluster_udn_example.p.cudn_worker-1',
                'patch-br-int-to-br-ex_worker-1',
                'patch-br-int-to-cluster_udn_vlan.1924_ovn_localnet_port'
            ]);
        });

        it('shows management ports with addresses and their network association', () => {
            const facts = factsFor('integration-bridge', ctx.integrationBridge!);
            const management = byLabel(facts, 'Management Ports');
            expect(management.provenance).toBe('observed');
            expect((management.value as { text: string }[]).map((v) => v.text)).toEqual([
                'ovn-k8s-mp0 10.131.0.2/23 — default network',
                'ovn-k8s-mp3 10.1.2.2/24 — VRF example-p-cudn'
            ]);
        });

        it('pairs each patch port with its provider bridge', () => {
            const facts = factsFor('integration-bridge', ctx.integrationBridge!);
            const patches = byLabel(facts, 'Patch Ports');
            const texts = (patches.value as { text: string }[]).map((v) => v.text);
            // Two to br-ex (default network and the Primary CUDN's gateway), one to
            // br-vmdata for the localnet network.
            expect(texts).toHaveLength(3);
            expect(texts.filter((t) => t.startsWith('br-ex: '))).toHaveLength(2);
            texts.filter((t) => t.startsWith('br-ex: '))
                .forEach((text) => expect(text).toMatch(/^br-ex: patch-br-int-to-.+ ↔ patch-br-ex.+/));
            expect(texts.filter((t) => t.startsWith('br-vmdata: '))).toEqual([
                'br-vmdata: patch-br-int-to-cluster_udn_vlan.1924_ovn_localnet_port'
                + ' ↔ patch-cluster_udn_vlan.1924_ovn_localnet_port-to-br-int'
            ]);
        });

        it('shows the internal port as an attribute, per the s3t.26 rule', () => {
            const facts = factsFor('integration-bridge', ctx.integrationBridge!);
            expect(byLabel(facts, 'Internal Port').value).toBe('br-int (no address)');
            expect(byLabel(facts, 'Type').hint).toContain('derived from their controller fields');
        });
    });

    describe('the mapping kind has no State fact', () => {
        it('shows its bridge under a Bridge label instead', () => {
            const mapping = ctx.bridgeMappings.find((m) => m.localnet === 'physnet')!;
            const facts = factsFor('ovn-mapping', mapping);
            expect(byLabel(facts, 'Bridge').value).toBe('br-ex');
            expect(facts.some((f) => f.label === 'State')).toBe(false);
        });
    });

    it('every fact marked inferred carries a hint naming its rule', () => {
        const allFacts = [
            ...factsFor('vrf', vrf),
            ...factsFor('cudn', cudn),
            ...factsFor('interface', vlan, 'vlan' as NodeKind)
        ];
        allFacts
            .filter((fact) => fact.provenance === 'inferred')
            .forEach((fact) => expect(fact.hint?.length ?? 0).toBeGreaterThan(10));
    });

    describe('bridge ports by role (ovn-recon-dp7.1, dp7.9 item 5)', () => {
        const brEx = ctx.interfaces.find((i) => i.name === 'br-ex' && i.type === 'ovs-bridge')!;
        const brExFacts = () => factsFor('interface', brEx, 'bridge' as NodeKind);
        const items = (fact: Fact) => fact.value as { text: string; detail?: string; ref?: unknown }[];

        it('keeps every port reachable, each in exactly one group', () => {
            const groups = groupBridgePorts(brEx, ctx);
            const grouped = [
                ...groups.uplinks,
                ...(groups.internal ? [groups.internal] : []),
                ...groups.patches.map((port) => port.portName),
                ...groups.other
            ];
            expect(grouped.sort()).toEqual([
                'br-ex', 'ens192', 'patch-br-ex_cluster_udn_example.p.cudn_worker-1-to-br-int', 'patch-br-ex_worker-1-to-br-int'
            ]);
            expect(new Set(grouped).size).toBe(grouped.length);
        });

        it('names the uplink and the internal port with its addresses', () => {
            const facts = brExFacts();
            expect(items(byLabel(facts, 'Uplink'))).toEqual([{ text: 'ens192' }]);
            const internal = items(byLabel(facts, 'Internal Port'));
            expect(internal).toHaveLength(1);
            expect(internal[0].text).toBe('br-ex');
            expect(internal[0].detail).toContain('192.0.2.72');
            expect(facts.some((fact) => fact.label === 'Ports')).toBe(false);
            expect(facts.some((fact) => fact.label === 'Other Ports')).toBe(true);
            expect(items(byLabel(facts, 'Other Ports'))).toEqual([]);
        });

        it('labels each patch port with the network it serves, inferred from its name, keeping the raw name', () => {
            const patches = byLabel(brExFacts(), 'Patch Ports');
            expect(patches.provenance).toBe('inferred');
            expect(patches.hint).toContain('Read out of the patch port names');
            expect(items(patches)).toEqual([
                {
                    text: 'CUDN example-p-cudn',
                    ref: { apiVersion: 'k8s.ovn.org/v1', kind: 'ClusterUserDefinedNetwork', name: 'example-p-cudn' },
                    detail: 'patch-br-ex_cluster_udn_example.p.cudn_worker-1-to-br-int'
                },
                { text: 'cluster default network', detail: 'patch-br-ex_worker-1-to-br-int' }
            ]);
        });

        it('lists the bridge mappings that name the bridge', () => {
            expect(items(byLabel(brExFacts(), 'Bridge Mappings'))).toEqual([{ text: 'physnet' }]);
            const vmdata = factsFor('interface', bridge, 'bridge' as NodeKind);
            expect(items(byLabel(vmdata, 'Bridge Mappings'))).toEqual([{ text: 'physnet-vmdata' }]);
            expect(items(byLabel(vmdata, 'Patch Ports'))[0]).toMatchObject({
                text: 'CUDN vlan-1924 (localnet)',
                detail: 'patch-cluster_udn_vlan.1924_ovn_localnet_port-to-br-int'
            });
        });
    });
});
