import { DEFAULT_ANNOTATION, LEGACY_ANNOTATION, masqueradeNode, nadFor, primaryNad } from '../masqueradeTesting';
import { masqueradeCapacity } from '../masquerade';
import { parsePrefix } from '../../components/ipPrefix';
import { clusterContext } from '../testing';
import { masqueradeSubnetTooSmall } from './masqueradeSubnetTooSmall';

const capacity = (cidr: string): number => masqueradeCapacity(parsePrefix(cidr)!);

describe('masquerade-subnet-too-small', () => {
    it('counts the networks a subnet holds', () => {
        expect(capacity('169.254.0.0/17')).toBe(16378);
        expect(capacity('fd69::/112')).toBe(32762);
        expect(capacity('169.254.169.0/29')).toBe(0);
        expect(capacity('fd69::/125')).toBe(0);
        // A /27 has offsets 1..30: ID 10 needs 30.
        expect(capacity('169.254.0.0/27')).toBe(10);
    });

    it('is quiet on the default /17 with a primary network', () => {
        const nodes = ['w1', 'w2'].map((name) => masqueradeNode(name, DEFAULT_ANNOTATION));
        expect(masqueradeSubnetTooSmall.evaluate(clusterContext({ nodes, nads: [primaryNad] }))).toEqual([]);
    });

    it('warns once per family when a primary network needs a pair the legacy subnet cannot hold', () => {
        const nodes = ['w1', 'w2'].map((name) => masqueradeNode(name, LEGACY_ANNOTATION));
        const findings = masqueradeSubnetTooSmall.evaluate(clusterContext({ nodes, nads: [primaryNad] }));

        expect(findings.map((finding) => [finding.severity, finding.summary])).toEqual([
            ['warning', 'The masquerade subnet 169.254.169.0/29 can hold the masquerade addresses of 0 user-defined networks, '
                + 'but network ID 3 is in use by a primary network; it cannot be changed once a user-defined network exists.'],
            ['warning', 'The masquerade subnet fd69::/125 can hold the masquerade addresses of 0 user-defined networks, '
                + 'but network ID 3 is in use by a primary network; it cannot be changed once a user-defined network exists.']
        ]);
        expect(findings[0].subject).toEqual({ kind: 'k8s', ref: expect.objectContaining({ kind: 'Network', name: 'cluster' }) });
        expect(findings[0].scope).toEqual({});
        expect(findings[0].evidence[0].fact).toBe('2 Nodes (w1 and w2) report the masquerade subnet 169.254.169.0/29.');
        expect(findings[0].evidence[1].inferred).toMatch(/upstream implementation detail/);
        expect(findings[0].remedy.path).toBe('spec.defaultNetwork.ovnKubernetesConfig.gatewayConfig.ipv4.internalMasqueradeSubnet');
    });

    it('is info, naming the first network ID, when no primary network exists yet', () => {
        const nodes = [masqueradeNode('w1', '{"ipv4":"169.254.169.0/29"}')];
        const findings = masqueradeSubnetTooSmall.evaluate(clusterContext({ nodes, nads: [nadFor('sec', 'ns', 2, 'secondary')] }));
        expect(findings).toHaveLength(1);
        expect(findings[0].severity).toBe('info');
        expect(findings[0].summary).toBe('The masquerade subnet 169.254.169.0/29 can hold the masquerade addresses of 0 user-defined networks; '
            + 'it cannot be changed once a user-defined network exists.');
        expect(findings[0].remedy.text).toMatch(/^Widen internalMasqueradeSubnet \(the default is 169\.254\.0\.0\/17\) before creating/);
    });

    it('fires on a subnet that holds some networks, but not the highest ID in use', () => {
        const nodes = [masqueradeNode('w1', '{"ipv4":"169.254.0.0/27"}')];
        const nads = [nadFor('a', 'ns', 3, 'primary'), nadFor('b', 'ns', 11, 'primary')];
        const [finding] = masqueradeSubnetTooSmall.evaluate(clusterContext({ nodes, nads }));
        expect(finding.summary).toMatch(/can hold the masquerade addresses of 10 user-defined networks, but network ID 11 is in use/);
        expect(finding.evidence[1].sources).toEqual([expect.objectContaining({ name: 'b', namespace: 'ns' })]);
        expect(masqueradeSubnetTooSmall.evaluate(clusterContext({ nodes, nads: nads.slice(0, 1) }))).toEqual([]);
    });

    it('is quiet without Nodes or without the annotation', () => {
        expect(masqueradeSubnetTooSmall.evaluate(clusterContext({ nads: [primaryNad] }))).toEqual([]);
        expect(masqueradeSubnetTooSmall.evaluate(clusterContext({ nodes: [masqueradeNode('w1', undefined)], nads: [primaryNad] }))).toEqual([]);
    });
});
