import type { NodeNetworkConfigurationEnactment, NodeNetworkState } from '../../types';
import { clone, fixtureNames, loadFixture, loadItems, physicalContext } from '../testing';
import { mappingBridgeMissing } from './mappingBridgeMissing';

const worker = loadFixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json');
const enactments = loadItems<NodeNetworkConfigurationEnactment>('nnce', 'primary-cudn-vrf.json');

describe('mapping-bridge-missing', () => {
    it('fires when a mapping names a bridge the node does not report', () => {
        // The real capture, minus br-vmdata: physnet-vmdata is still mapped to it.
        const nns = clone(worker);
        nns.status!.currentState!.interfaces = nns.status!.currentState!.interfaces
            .filter((iface) => !(iface.name === 'br-vmdata' && iface.type === 'ovs-bridge'));

        const findings = mappingBridgeMissing.evaluate(physicalContext({ nns, enactments }));

        expect(findings).toHaveLength(1);
        expect(findings[0]).toEqual(expect.objectContaining({
            subject: { kind: 'graph-node', node: 'worker-1', graphNodeId: 'ovn:physnet-vmdata' },
            scope: { node: 'worker-1' },
            summary: 'Bridge mapping physnet-vmdata on worker-1 names OVS bridge br-vmdata, which the node does not report.'
        }));
        // The enactment of policy br-vmdata claims the mapping, so the remedy names that policy.
        expect(findings[0].remedy.target).toEqual(expect.objectContaining({
            kind: 'NodeNetworkConfigurationPolicy', name: 'br-vmdata'
        }));
    });

    it.each(fixtureNames('nns').filter((name) => name !== 'cluster-localnet-coverage.json'))(
        'is quiet on the %s capture', (name) => {
            const nns = loadFixture<NodeNetworkState>('nns', name);
            expect(mappingBridgeMissing.evaluate(physicalContext({ nns }))).toEqual([]);
        });

    it('is quiet when the node reports no interfaces at all', () => {
        const nns = clone(worker);
        nns.status!.currentState!.interfaces = [];
        expect(mappingBridgeMissing.evaluate(physicalContext({ nns }))).toEqual([]);
    });
});
