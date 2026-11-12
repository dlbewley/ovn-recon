import type { LogicalRule } from './types';
import { createLogicalEvaluator, evaluateLogical } from './evaluate';
import { makeFinding } from './refs';
import { loadSnapshot, logicalContext } from './testing';

const stub = (id: string, scope: LogicalRule['scope'], evaluate: LogicalRule['evaluate'], section?: 'policy'): LogicalRule =>
    ({ id, severity: 'warning', scope, domain: 'logical', title: id, evaluate, section });

describe('the logical evaluator', () => {
    it('reports nothing on the real zone captures as taken', () => {
        ['cnv-1', 'cnv-2', 'ctrl-1', 'default'].forEach((name) =>
            expect(evaluateLogical(logicalContext(loadSnapshot(name), { pods: [], now: 0 }))).toEqual([]));
    });

    it('hands network rules only the cluster inputs and zone rules none, and caches by identity', () => {
        const seen: string[] = [];
        const evaluate = createLogicalEvaluator({
            rules: [
                stub('zone', 'node', (ctx) => {
                    seen.push(`zone:${ctx.nodeName}:${ctx.cluster === undefined}`);
                    return [];
                }),
                stub('net', 'network', (ctx) => {
                    seen.push(`net:${ctx.nodeName}:${ctx.cluster !== undefined}`);
                    return [];
                })
            ]
        });
        const cluster = { nads: [], multiNetworkPolicies: [] };
        const ctx = logicalContext(loadSnapshot('cnv-1'), { cluster });
        expect(evaluate(ctx)).toBe(evaluate(ctx));
        expect(seen).toEqual(['zone:cnv-1:true', 'net::true']);
    });

    it('runs only the section rules over a database the drawer loaded', () => {
        const snapshot = loadSnapshot('cnv-1');
        const evaluate = createLogicalEvaluator({
            rules: [
                stub('plain', 'node', () => { throw new Error('not a section rule'); }),
                stub('policy', 'node', ({ nodeName }) => [makeFinding({
                    ruleId: 'policy', severity: 'warning',
                    subject: { kind: 'construct', node: nodeName, constructKind: 'switch', name: 'cnv-1' },
                    scope: { node: nodeName }, summary: 'x', evidence: [],
                    remedy: { text: 'x', target: { group: '', version: 'v1', kind: 'Node', name: nodeName } }
                })], 'policy')
            ]
        });
        const findings = evaluate.sections(snapshot.database!, 'cnv-1');
        expect(findings.map((finding) => finding.ruleId)).toEqual(['policy']);
        expect(evaluate.sections(snapshot.database!, 'cnv-1')).toBe(findings);
    });
});
