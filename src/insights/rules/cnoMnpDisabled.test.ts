import type { ClusterUserDefinedNetwork, MultiNetworkPolicy, NetworkAttachmentDefinition } from '../../types';
import { cnoWith, networkConfigOf } from '../cnoTesting';
import { clusterContext, loadItems } from '../testing';
import { cnoMnpDisabled } from './cnoMnpDisabled';

const cudns = loadItems<ClusterUserDefinedNetwork>('cudn', 'cluster-localnet-coverage.json');
const nads = loadItems<NetworkAttachmentDefinition>('nad', 'cluster-localnet-coverage.json');
const standalone: NetworkAttachmentDefinition = {
    apiVersion: 'k8s.cni.cncf.io/v1',
    kind: 'NetworkAttachmentDefinition',
    metadata: { name: 'macvlan-data', namespace: 'demo' },
    spec: { config: '{"cniVersion":"0.3.1","name":"macvlan-data","type":"macvlan","master":"ens224"}' }
};
const policy = (namespace: string, name: string): MultiNetworkPolicy => ({
    apiVersion: 'k8s.cni.cncf.io/v1beta1', kind: 'MultiNetworkPolicy', metadata: { name, namespace }, spec: {}
});
const policies = [policy('demo', 'deny-all'), policy('demo', 'allow-web')];

const multusOff = cnoWith((data) => { data.operatorNetwork.spec!.disableMultiNetwork = true; });
const enforced = cnoWith((data) => { data.operatorNetwork.spec!.useMultiNetworkPolicy = true; });

describe('cno-mnp-disabled', () => {
    describe('MultiNetworkPolicies while useMultiNetworkPolicy is false', () => {
        it('fires once, naming the policies', () => {
            const findings = cnoMnpDisabled.evaluate(clusterContext({
                nads: [standalone], multiNetworkPolicies: policies, networkConfig: networkConfigOf()
            }));
            expect(findings).toHaveLength(1);
            expect(findings[0].summary).toBe(
                '2 MultiNetworkPolicies (demo/allow-web and demo/deny-all) are ignored: useMultiNetworkPolicy is false.');
            expect(findings[0].evidence[0].path).toBe('spec.useMultiNetworkPolicy');
            expect(findings[0].evidence[1].sources).toEqual([
                expect.objectContaining({ kind: 'MultiNetworkPolicy', namespace: 'demo', name: 'deny-all' }),
                expect.objectContaining({ kind: 'MultiNetworkPolicy', namespace: 'demo', name: 'allow-web' })
            ]);
            expect(findings[0].remedy.path).toBe('spec.useMultiNetworkPolicy');
        });

        it('is quiet when policies are enforced, when there are none, and when they cannot be listed', () => {
            expect(cnoMnpDisabled.evaluate(clusterContext({
                multiNetworkPolicies: policies, networkConfig: networkConfigOf(enforced)
            }))).toEqual([]);
            expect(cnoMnpDisabled.evaluate(clusterContext({ multiNetworkPolicies: [], networkConfig: networkConfigOf() }))).toEqual([]);
            expect(cnoMnpDisabled.evaluate(clusterContext({ nads: [standalone], networkConfig: networkConfigOf() }))).toEqual([]);
        });
    });

    describe('multi-network disabled', () => {
        it('fires once while a NAD of its own exists, leaving out the CUDNs\' NADs', () => {
            const findings = cnoMnpDisabled.evaluate(clusterContext({
                cudns, nads: [...nads, standalone], networkConfig: networkConfigOf(multusOff)
            }));
            expect(findings).toHaveLength(1);
            expect(findings[0].summary).toMatch(/^Multi-network is disabled, so \d+ NetworkAttachmentDefinitions? \(.*\) have no effect\.$/);
            expect(findings[0].evidence[0].path).toBe('spec.disableMultiNetwork');
            const sources = findings[0].evidence[1].sources;
            expect(sources).toContainEqual(expect.objectContaining({ name: 'macvlan-data', namespace: 'demo' }));
            const generated = nads.filter((nad) => (nad.metadata?.ownerReferences ?? [])
                .some((owner) => owner.kind === 'ClusterUserDefinedNetwork'));
            expect(generated.length).toBeGreaterThan(0);
            generated.forEach((nad) => expect(sources).not.toContainEqual(
                expect.objectContaining({ name: nad.metadata?.name, namespace: nad.metadata?.namespace })));
        });

        it('covers the policies too, in one finding', () => {
            const findings = cnoMnpDisabled.evaluate(clusterContext({
                nads: [standalone], multiNetworkPolicies: policies, networkConfig: networkConfigOf(multusOff)
            }));
            expect(findings).toHaveLength(1);
            expect(findings[0].summary).toBe('Multi-network is disabled, so 1 NetworkAttachmentDefinition (demo/macvlan-data) '
                + 'and 2 MultiNetworkPolicies (demo/allow-web and demo/deny-all) have no effect.');
            expect(findings[0].remedy.path).toBe('spec.disableMultiNetwork');
        });

        it('is quiet with nothing to leave without effect', () => {
            expect(cnoMnpDisabled.evaluate(clusterContext({ networkConfig: networkConfigOf(multusOff) }))).toEqual([]);
        });
    });

    it('is quiet without the network configuration', () => {
        expect(cnoMnpDisabled.evaluate(clusterContext({ nads: [standalone], multiNetworkPolicies: policies }))).toEqual([]);
    });
});
