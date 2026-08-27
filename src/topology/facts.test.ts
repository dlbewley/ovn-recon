import fs from 'fs';
import path from 'path';

import { buildGraphContext } from './context';
import { descriptorFor } from './descriptors';
import { nodeKindRegistry } from './registry';
import { buildNodeViewModel } from './viewModel';
import { Fact, NodeKind } from './types';
import { ClusterUserDefinedNetwork, NodeNetworkState, RouteAdvertisements } from '../types';

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
            expect(selector.value).toBe('network/machine=');
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
