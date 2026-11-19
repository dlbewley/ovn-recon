import { DEFAULT_ANNOTATION, LEGACY_ANNOTATION, masqueradeNode } from '../masqueradeTesting';
import { clusterContext } from '../testing';
import { masqueradeSubnetDisagreement } from './masqueradeSubnetDisagreement';

describe('masquerade-subnet-disagreement', () => {
    it('is quiet when every Node agrees, however the annotation is spelled', () => {
        const nodes = [
            masqueradeNode('w1', DEFAULT_ANNOTATION),
            masqueradeNode('w2', '{"ipv6":"fd69::/112","ipv4":"169.254.0.0/17"}'),
            masqueradeNode('w3', undefined)
        ];
        expect(masqueradeSubnetDisagreement.evaluate(clusterContext({ nodes }))).toEqual([]);
    });

    it('fires once, on the network configuration, naming each group of Nodes', () => {
        const nodes = [
            masqueradeNode('w1', DEFAULT_ANNOTATION),
            masqueradeNode('w2', DEFAULT_ANNOTATION),
            masqueradeNode('w3', LEGACY_ANNOTATION)
        ];
        const findings = masqueradeSubnetDisagreement.evaluate(clusterContext({ nodes }));
        expect(findings).toHaveLength(1);
        expect(findings[0]).toEqual(expect.objectContaining({
            severity: 'warning',
            subject: { kind: 'k8s', ref: expect.objectContaining({ group: 'operator.openshift.io', kind: 'Network', name: 'cluster' }) },
            scope: {},
            summary: 'Nodes disagree on the masquerade subnet: 169.254.0.0/17, fd69::/112 on 2 nodes; '
                + '169.254.169.0/29, fd69::/125 on 1 node.'
        }));
        expect(findings[0].evidence.map((evidence) => evidence.fact)).toEqual([
            '2 Nodes (w1 and w2) report 169.254.0.0/17, fd69::/112.',
            '1 Node (w3) reports 169.254.169.0/29, fd69::/125.'
        ]);
    });

    it('is quiet without Nodes', () => {
        expect(masqueradeSubnetDisagreement.evaluate(clusterContext({}))).toEqual([]);
    });
});
