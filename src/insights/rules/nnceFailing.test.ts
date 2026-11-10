import type { NodeNetworkConfigurationEnactment, NodeNetworkState } from '../../types';
import { clone, loadFixture, loadItems, physicalContext } from '../testing';
import { nnceFailing } from './nnceFailing';

const nns = loadFixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json');
const enactments = loadItems<NodeNetworkConfigurationEnactment>('nnce', 'primary-cudn-vrf.json');

const failing = (enactment: NodeNetworkConfigurationEnactment, type = 'Failing'): NodeNetworkConfigurationEnactment => {
    const copy = clone(enactment);
    copy.status!.conditions = [
        { type: 'Available', status: 'False' },
        { type, status: 'True', reason: 'FailedToConfigure', message: 'error reconciling NodeNetworkConfigurationPolicy' },
        { type: 'Progressing', status: 'False' }
    ];
    return copy;
};

describe('nnce-failing', () => {
    it('fires on an enactment that is Failing, naming the policy to correct', () => {
        const storage = enactments.find((e) => e.metadata?.name === 'worker-1.storage-vlan')!;
        const findings = nnceFailing.evaluate(physicalContext({
            nns, enactments: enactments.map((e) => (e === storage ? failing(e) : e))
        }));

        expect(findings).toHaveLength(1);
        expect(findings[0]).toEqual(expect.objectContaining({
            subject: { kind: 'k8s', ref: expect.objectContaining({ kind: 'NodeNetworkConfigurationEnactment', name: 'worker-1.storage-vlan' }) },
            scope: { node: 'worker-1' },
            summary: 'NodeNetworkConfigurationPolicy storage-vlan is Failing on worker-1.'
        }));
        expect(findings[0].evidence[0].fact).toBe(
            'Condition Failing is True (FailedToConfigure): error reconciling NodeNetworkConfigurationPolicy');
        expect(findings[0].remedy.target).toEqual(expect.objectContaining({
            kind: 'NodeNetworkConfigurationPolicy', name: 'storage-vlan'
        }));
    });

    it('fires on Degraded, and reads the policy from a dotted node name when the label is gone', () => {
        const bonded = loadFixture<NodeNetworkState>('nns', 'bonded-lldp.json');
        const enactment = failing(enactments[0], 'Degraded');
        enactment.metadata = { name: 'worker-2.example.com.bond-policy' };
        const findings = nnceFailing.evaluate(physicalContext({ nns: bonded, enactments: [enactment] }));
        expect(findings.map((f) => f.summary)).toEqual([
            'NodeNetworkConfigurationPolicy bond-policy is Degraded on worker-2.example.com.'
        ]);
    });

    it('is quiet on the healthy enactments of the CNV worker', () => {
        expect(nnceFailing.evaluate(physicalContext({ nns, enactments }))).toEqual([]);
    });

    it('is quiet on a Progressing enactment, and when there are no enactments at all', () => {
        const progressing = clone(enactments[0]);
        progressing.status!.conditions = [{ type: 'Progressing', status: 'True', reason: 'ConfigurationProgressing' }];
        expect(nnceFailing.evaluate(physicalContext({ nns, enactments: [progressing] }))).toEqual([]);
        expect(nnceFailing.evaluate(physicalContext({ nns }))).toEqual([]);
    });
});
