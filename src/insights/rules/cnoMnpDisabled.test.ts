import type { ClusterUserDefinedNetwork, NetworkAttachmentDefinition } from '../../types';
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
const multusOff = cnoWith((data) => { data.operatorNetwork.spec!.disableMultiNetwork = true; });

describe('cno-mnp-disabled', () => {
    it('fires once when multi-network is disabled while a NAD exists', () => {
        const findings = cnoMnpDisabled.evaluate(clusterContext({
            cudns, nads: [...nads, standalone], networkConfig: networkConfigOf(multusOff)
        }));
        expect(findings).toHaveLength(1);
        expect(findings[0].summary).toMatch(/^Multi-network is disabled, so \d+ NetworkAttachmentDefinitions? \(/);
        expect(findings[0].evidence[0].path).toBe('spec.disableMultiNetwork');
        expect(findings[0].evidence[1].sources).toContainEqual(expect.objectContaining({ name: 'macvlan-data', namespace: 'demo' }));
        // The CUDNs' own NADs are the CUDNs, not separate networks.
        const cudnNames = new Set(cudns.map((cudn) => cudn.metadata?.name));
        expect(findings[0].evidence[1].sources.some((source) =>
            nads.some((nad) => nad.metadata?.name === source.name && nad.metadata?.ownerReferences?.length
                && cudnNames.has(nad.metadata.ownerReferences[0].name)))).toBe(false);
    });

    it('is quiet with multi-network enabled, or with no NAD of its own', () => {
        expect(cnoMnpDisabled.evaluate(clusterContext({ nads: [standalone], networkConfig: networkConfigOf() }))).toEqual([]);
        expect(cnoMnpDisabled.evaluate(clusterContext({ networkConfig: networkConfigOf(multusOff) }))).toEqual([]);
    });
});
