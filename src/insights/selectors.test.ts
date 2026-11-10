import { cudnRef, makeFinding, nadRef, nnceRef, nodeRef } from './refs';
import {
    countBySeverity, findingsForConstruct, findingsForGraphNode, findingsForNetwork, findingsForNode,
    findingsForSubject, highestSeverity
} from './selectors';
import type { Finding, FindingScope, FindingSubject, Severity } from './types';

const finding = (ruleId: string, subject: FindingSubject, scope: FindingScope, severity: Severity = 'warning'): Finding =>
    makeFinding({ ruleId, severity, subject, scope, summary: ruleId, evidence: [], remedy: { text: '', target: nodeRef('a') } });

const blue = cudnRef('blue');
const nad = nadRef({ metadata: { name: 'mirror', namespace: 'demo' } });

const findings: Finding[] = [
    finding('localnet-unmapped', { kind: 'k8s', ref: blue }, { network: blue }),
    finding('interface-down', { kind: 'graph-node', node: 'w1', graphNodeId: 'iface:ens224' }, { node: 'w1' }),
    finding('mtu-exceeds-uplink', { kind: 'graph-node', node: 'w2', graphNodeId: 'cudn:blue' }, { node: 'w2', network: blue }),
    finding('nnce-failing', { kind: 'k8s', ref: nnceRef({ metadata: { name: 'w1.p' } }) }, { node: 'w1' }),
    finding('nad-config-unparsed', { kind: 'k8s', ref: nad }, { network: nad }),
    finding('practice', { kind: 'construct', node: 'w1', constructKind: 'switch', name: 'w1' }, { node: 'w1' }, 'info')
];
const rules = (list: Finding[]) => list.map((f) => f.ruleId);

describe('findings selectors', () => {
    it('selects by exact subject', () => {
        expect(rules(findingsForSubject(findings, { kind: 'k8s', ref: cudnRef('blue') }))).toEqual(['localnet-unmapped']);
    });

    it('puts a network-wide finding on that network\'s graph node on every node', () => {
        expect(rules(findingsForGraphNode(findings, 'w1', 'cudn:blue'))).toEqual(['localnet-unmapped']);
        expect(rules(findingsForGraphNode(findings, 'w2', 'cudn:blue'))).toEqual(['localnet-unmapped', 'mtu-exceeds-uplink']);
        expect(rules(findingsForGraphNode(findings, 'w2', 'nad:demo/mirror'))).toEqual(['nad-config-unparsed']);
        expect(rules(findingsForGraphNode(findings, 'w2', 'iface:ens224'))).toEqual([]);
    });

    it('selects by node, network and construct', () => {
        expect(rules(findingsForNode(findings, 'w1'))).toEqual(['interface-down', 'nnce-failing', 'practice']);
        expect(rules(findingsForNetwork(findings, cudnRef('blue')))).toEqual(['localnet-unmapped', 'mtu-exceeds-uplink']);
        expect(rules(findingsForConstruct(findings, 'switch', 'w1'))).toEqual(['practice']);
        expect(rules(findingsForConstruct(findings, 'switch', 'w1', 'w2'))).toEqual([]);
    });

    it('counts by severity and names the worst', () => {
        expect(countBySeverity(findings)).toEqual({ warning: 5, info: 1, total: 6 });
        expect(highestSeverity(findings)).toBe('warning');
        expect(highestSeverity(findings.slice(5))).toBe('info');
        expect(highestSeverity([])).toBeUndefined();
    });
});
