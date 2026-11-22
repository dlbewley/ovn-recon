import { cnoWith, CNO_NOW, networkConfigOf } from '../cnoTesting';
import { clusterContext } from '../testing';
import { cnoOperatorUnhealthy } from './cnoOperatorUnhealthy';

const setCondition = (conditions: { type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string }[] | undefined,
    type: string, status: string, extra: Record<string, string> = {}) => {
    const condition = conditions!.find((c) => c.type === type)!;
    Object.assign(condition, { status, ...extra });
};

describe('cno-operator-unhealthy', () => {
    it('fires when the network ClusterOperator is Degraded', () => {
        const data = cnoWith((d) => setCondition(d.clusterOperator.status!.conditions, 'Degraded', 'True',
            { reason: 'RolloutHung', message: 'DaemonSet ovnkube-node is not available' }));
        const findings = cnoOperatorUnhealthy.evaluate(clusterContext({ networkConfig: networkConfigOf(data) }));
        expect(findings).toHaveLength(1);
        expect(findings[0].summary).toBe('The Cluster Network Operator is Degraded.');
        expect(findings[0].subject).toEqual({ kind: 'k8s', ref: expect.objectContaining({ kind: 'ClusterOperator', name: 'network' }) });
        expect(findings[0].evidence[0].fact).toContain('RolloutHung: DaemonSet ovnkube-node is not available');
        expect(findings[0].remedy.verb).toBe('view');
    });

    it('fires when Progressing has been True for longer than the threshold, not before', () => {
        const progressingSince = (iso: string) => cnoWith((d) => setCondition(d.operatorNetwork.status!.conditions, 'Progressing', 'True',
            { lastTransitionTime: iso }));
        const long = cnoOperatorUnhealthy.evaluate(clusterContext({
            networkConfig: networkConfigOf(progressingSince(new Date(CNO_NOW - 2 * 3600 * 1000).toISOString()))
        }));
        expect(long.map((f) => f.summary)).toEqual(['The Cluster Network Operator is Progressing (for 2 h).']);
        expect(cnoOperatorUnhealthy.evaluate(clusterContext({
            networkConfig: networkConfigOf(progressingSince(new Date(CNO_NOW - 5 * 60 * 1000).toISOString()))
        }))).toEqual([]);
    });

    it('fires when the operator is not Managed', () => {
        const data = cnoWith((d) => { d.operatorNetwork.spec!.managementState = 'Unmanaged'; });
        const [finding] = cnoOperatorUnhealthy.evaluate(clusterContext({ networkConfig: networkConfigOf(data) }));
        expect(finding.summary).toBe('The Cluster Network Operator is Unmanaged.');
        expect(finding.remedy).toEqual(expect.objectContaining({ path: 'spec.managementState' }));
    });

    it('is quiet on a healthy cluster', () => {
        expect(cnoOperatorUnhealthy.evaluate(clusterContext({ networkConfig: networkConfigOf() }))).toEqual([]);
        expect(cnoOperatorUnhealthy.evaluate(clusterContext({}))).toEqual([]);
    });
});
