import type { MultiNetworkPolicy, NetworkAttachmentDefinition } from '../../types';
import { loadItems, loadSnapshot, logicalContext } from '../testing';
import { mnpMissingNad, policyForTargets, POLICY_FOR_ANNOTATION } from './mnpMissingNad';

const nads = loadItems<NetworkAttachmentDefinition>('nad', 'cluster-localnet-coverage.json');
const snapshot = loadSnapshot('cnv-1');

/** No MultiNetworkPolicy capture exists yet, so the policy is written here. */
const policy = (policyFor: string | undefined, namespace = 'demo-mirror'): MultiNetworkPolicy => ({
    apiVersion: 'k8s.cni.cncf.io/v1beta1',
    kind: 'MultiNetworkPolicy',
    metadata: {
        name: 'deny-all',
        namespace,
        ...(policyFor !== undefined ? { annotations: { [POLICY_FOR_ANNOTATION]: policyFor } } : {})
    },
    spec: { podSelector: {}, policyTypes: ['Ingress'] }
});

const evaluate = (policies: MultiNetworkPolicy[]) =>
    mnpMissingNad.evaluate(logicalContext(snapshot, { cluster: { nads, multiNetworkPolicies: policies } }));

describe('mnp-missing-nad', () => {
    it('fires once per named NetworkAttachmentDefinition that does not exist', () => {
        const findings = evaluate([policy('vlan-1924, vlan-2000,other/vlan-1924')]);

        expect(findings.map((finding) => finding.scope.network?.name)).toEqual(['vlan-2000', 'vlan-1924']);
        expect(findings[0]).toEqual(expect.objectContaining({
            ruleId: 'mnp-missing-nad',
            subject: { kind: 'k8s', ref: expect.objectContaining({ kind: 'MultiNetworkPolicy', namespace: 'demo-mirror', name: 'deny-all' }) },
            summary: 'MultiNetworkPolicy demo-mirror/deny-all applies to NetworkAttachmentDefinition demo-mirror/vlan-2000, which does not exist.'
        }));
        expect(findings[1].summary).toContain('other/vlan-1924');
        expect(findings[0].remedy.path).toBe(`metadata.annotations["${POLICY_FOR_ANNOTATION}"]`);
    });

    it('stays quiet when every name resolves, bare or namespaced, or none is given', () => {
        expect(evaluate([policy('vlan-1924,default/machinenet'), policy(undefined)])).toEqual([]);
    });

    it('stays quiet until both lists have loaded', () => {
        expect(mnpMissingNad.evaluate(logicalContext(snapshot))).toEqual([]);
    });

    it('reads policy-for entries as name or namespace/name', () => {
        expect(policyForTargets(' a , b/c ,', 'ns')).toEqual([
            { namespace: 'ns', name: 'a' },
            { namespace: 'b', name: 'c' }
        ]);
    });
});
