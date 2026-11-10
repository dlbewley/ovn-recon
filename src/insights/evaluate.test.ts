import { buildGraphContext } from '../topology/context';
import type {
    ClusterUserDefinedNetwork, NetworkAttachmentDefinition, NodeNetworkConfigurationEnactment, NodeNetworkState
} from '../types';
import { createPhysicalEvaluator, evaluatePhysical } from './evaluate';
import { makeFinding } from './refs';
import { loadFixture, loadItems } from './testing';
import type { ClusterNetworkInputs, PhysicalRule } from './types';

const coverage: ClusterNetworkInputs = {
    cudns: loadItems<ClusterUserDefinedNetwork>('cudn', 'cluster-localnet-coverage.json'),
    udns: [],
    nads: loadItems<NetworkAttachmentDefinition>('nad', 'cluster-localnet-coverage.json'),
    nodeNetworkStates: loadItems<NodeNetworkState>('nns', 'cluster-localnet-coverage.json')
};

const stubRule = (id: string, scope: PhysicalRule['scope'], evaluate: PhysicalRule['evaluate']): PhysicalRule =>
    ({ id, severity: 'warning', scope, domain: 'physical', title: id, evaluate });

describe('the physical evaluator', () => {
    it('on the real ten-node capture, reports the three unmapped networks and nothing else', () => {
        const graphs = coverage.nodeNetworkStates!.map((nns) =>
            buildGraphContext({ nns, cudns: coverage.cudns, nads: coverage.nads }));
        const findings = evaluatePhysical.cluster(coverage, graphs);
        expect(findings.map((f) => `${f.ruleId} ${f.subject.kind === 'k8s' ? f.subject.ref.name : ''}`)).toEqual([
            'localnet-unmapped vlan-333',
            'localnet-unmapped vlan-333-again',
            'localnet-unmapped vlan-999'
        ]);
    });

    it('on the real EVPN worker, reports the down SVI and nothing else', () => {
        const nns = loadFixture<NodeNetworkState>('nns', 'evpn-vxlan.json');
        const cudns = loadItems<ClusterUserDefinedNetwork>('cudn', 'evpn-vxlan.json');
        const nads = loadItems<NetworkAttachmentDefinition>('nad', 'evpn-vxlan.json');
        const findings = evaluatePhysical({
            domain: 'physical',
            node: buildGraphContext({ nns, cudns, nads }),
            cluster: { cudns, udns: [], nads, nodeNetworkStates: [nns] }
        });
        expect(findings.map((f) => f.summary)).toEqual(['Interface svl2.9 on worker-evpn is down.']);
    });

    it('on the real CNV worker with its enactments, reports nothing', () => {
        const nns = loadFixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json');
        const cudns = loadItems<ClusterUserDefinedNetwork>('cudn', 'primary-cudn-vrf.json');
        const enactments = loadItems<NodeNetworkConfigurationEnactment>('nnce', 'primary-cudn-vrf.json');
        expect(evaluatePhysical({
            domain: 'physical',
            node: buildGraphContext({ nns, cudns, enactments }),
            cluster: { cudns, udns: [], nads: [], nodeNetworkStates: [nns] }
        })).toEqual([]);
    });

    it('returns the same array for the same inputs, and recomputes for new ones', () => {
        const calls: string[] = [];
        const evaluate = createPhysicalEvaluator({
            rules: [
                stubRule('n', 'node', () => { calls.push('node'); return []; }),
                stubRule('c', 'network', () => { calls.push('network'); return []; })
            ]
        });
        const node = buildGraphContext({ nns: loadFixture<NodeNetworkState>('nns', 'basic-host.json') });
        const ctx = { domain: 'physical' as const, node, cluster: coverage };

        const first = evaluate(ctx);
        expect(evaluate({ ...ctx })).toBe(first);
        expect(calls).toEqual(['node', 'network']);

        // A new cluster input re-runs the network rules only.
        evaluate({ ...ctx, cluster: { ...coverage } });
        expect(calls).toEqual(['node', 'network', 'network']);
    });

    it('hands node rules no cluster data and network rules no node', () => {
        const seen: unknown[] = [];
        const evaluate = createPhysicalEvaluator({
            rules: [
                stubRule('n', 'node-network', (ctx) => { seen.push(ctx.cluster.nodeNetworkStates); return []; }),
                stubRule('c', 'network', (ctx) => { seen.push(ctx.node); return []; })
            ]
        });
        const node = buildGraphContext({ nns: loadFixture<NodeNetworkState>('nns', 'basic-host.json') });
        evaluate({ domain: 'physical', node, cluster: coverage });
        expect(seen).toEqual([undefined, undefined]);
    });

    it('drops the findings of a rule that throws and keeps the others', () => {
        const errors: string[] = [];
        const finding = makeFinding({
            ruleId: 'ok', severity: 'warning', subject: { kind: 'k8s', ref: { group: '', version: 'v1', kind: 'Node', name: 'a' } },
            scope: {}, summary: 's', evidence: [], remedy: { text: 't', target: { group: '', version: 'v1', kind: 'Node', name: 'a' } }
        });
        const evaluate = createPhysicalEvaluator({
            rules: [
                stubRule('boom', 'network', () => { throw new Error('bad'); }),
                stubRule('ok', 'network', () => [finding, finding])
            ],
            onRuleError: (id) => errors.push(id)
        });
        expect(evaluate({ domain: 'physical', cluster: coverage })).toEqual([finding]);
        expect(errors).toEqual(['boom']);
    });

    it('sorts warnings before info', () => {
        const ref = { group: '', version: 'v1', kind: 'Node', name: 'a' };
        const make = (ruleId: string, severity: 'warning' | 'info') => makeFinding({
            ruleId, severity, subject: { kind: 'k8s', ref }, scope: {}, summary: ruleId, evidence: [], remedy: { text: '', target: ref }
        });
        const evaluate = createPhysicalEvaluator({
            rules: [stubRule('x', 'network', () => [make('a-info', 'info'), make('z-warning', 'warning')])]
        });
        expect(evaluate({ domain: 'physical', cluster: coverage }).map((f) => f.ruleId)).toEqual(['z-warning', 'a-info']);
    });
});
