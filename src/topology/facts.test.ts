import fs from 'fs';
import path from 'path';

import { buildGraphContext } from './context';
import { descriptorFor } from './descriptors';
import { nodeKindRegistry } from './registry';
import { buildNodeViewModel } from './viewModel';
import { Fact, NodeKind } from './types';
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

        it('a bridge lists its ports with an explicit empty state available', () => {
            const fact = byLabel(factsFor('interface', bridge, 'bridge' as NodeKind), 'Ports');
            expect(fact.provenance).toBe('observed');
            expect((fact.value as { text: string }[]).map((v) => v.text)).toContain('ens224');
        });

        it('VRF routes carry the full route sentence', () => {
            const fact = byLabel(factsFor('vrf', vrf), 'Routes');
            expect(fact.provenance).toBe('observed');
            expect((fact.value as { text: string }[]).map((v) => v.text))
                .toContain('0.0.0.0/0 via 192.0.2.1 dev br-ex');
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
});
