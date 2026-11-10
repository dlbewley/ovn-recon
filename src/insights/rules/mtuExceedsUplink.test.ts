import type { ClusterUserDefinedNetwork, NetworkAttachmentDefinition, NodeNetworkState } from '../../types';
import { clone, loadFixture, loadItems, physicalContext } from '../testing';
import { mtuExceedsUplink } from './mtuExceedsUplink';

const nns = loadFixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json');
const cudns = loadItems<ClusterUserDefinedNetwork>('cudn', 'primary-cudn-vrf.json');

describe('mtu-exceeds-uplink', () => {
    it('fires when a Localnet CUDN declares an MTU its uplink cannot carry', () => {
        // machinenet rides physnet -> br-ex -> ens192 (MTU 1500).
        const jumbo = clone(cudns);
        jumbo.find((c) => c.metadata?.name === 'machinenet')!.spec!.network!.localnet!
            = { ...jumbo.find((c) => c.metadata?.name === 'machinenet')!.spec!.network!.localnet!, mtu: 9000 } as never;

        const findings = mtuExceedsUplink.evaluate(physicalContext({ nns, cudns: jumbo }));

        expect(findings).toHaveLength(1);
        expect(findings[0]).toEqual(expect.objectContaining({
            subject: { kind: 'graph-node', node: 'worker-1', graphNodeId: 'cudn:machinenet' },
            scope: { node: 'worker-1', network: expect.objectContaining({ kind: 'ClusterUserDefinedNetwork', name: 'machinenet' }) },
            summary: 'ClusterUserDefinedNetwork machinenet has MTU 9000, larger than the 1500 of uplink ens192 on worker-1.'
        }));
        expect(findings[0].remedy).toEqual(expect.objectContaining({
            target: expect.objectContaining({ name: 'machinenet' }),
            path: 'spec.network.localnet.mtu'
        }));
    });

    it('reads the MTU from the generated NAD when the CUDN declares none', () => {
        // The ten-node capture: vlan-1924 sets no MTU, its NAD carries 1500.
        const coverageNns = loadItems<NodeNetworkState>('nns', 'cluster-localnet-coverage.json')
            .find((n) => n.metadata?.name === 'worker-1')!;
        const coverageCudns = loadItems<ClusterUserDefinedNetwork>('cudn', 'cluster-localnet-coverage.json');
        const nads = clone(loadItems<NetworkAttachmentDefinition>('nad', 'cluster-localnet-coverage.json'));
        expect(mtuExceedsUplink.evaluate(physicalContext({ nns: coverageNns, cudns: coverageCudns, nads }))).toEqual([]);

        const vlan1924 = nads.find((n) => n.metadata?.name === 'vlan-1924')!;
        vlan1924.spec!.config = vlan1924.spec!.config.replace('"mtu":1500', '"mtu":9000');
        const findings = mtuExceedsUplink.evaluate(physicalContext({ nns: coverageNns, cudns: coverageCudns, nads }));
        expect(findings.map((f) => f.summary)).toEqual([
            'ClusterUserDefinedNetwork vlan-1924 has MTU 9000, larger than the 1500 of uplink ens224 on worker-1.'
        ]);
        expect(findings[0].evidence[0].sources).toEqual([expect.objectContaining({ kind: 'NetworkAttachmentDefinition' })]);
        // The fix is on the CUDN, which generated the NAD; no one field of it states the MTU.
        expect(findings[0].remedy.path).toBeUndefined();
    });

    it('is quiet on the real CNV worker, where every declared MTU fits', () => {
        // machinenet declares 1500 over a 1500 uplink; vlan-1924/1926 declare none.
        expect(mtuExceedsUplink.evaluate(physicalContext({ nns, cudns }))).toEqual([]);
    });

    it('is quiet on a node that does not map the physical network', () => {
        const ctrl = loadItems<NodeNetworkState>('nns', 'cluster-localnet-coverage.json')
            .find((n) => n.metadata?.name === 'control-1')!;
        const jumbo = clone(cudns).map((c) => (c.spec?.network?.localnet
            ? { ...c, spec: { ...c.spec, network: { ...c.spec.network, localnet: { ...c.spec.network.localnet, mtu: 9000 } } } }
            : c)) as ClusterUserDefinedNetwork[];
        const findings = mtuExceedsUplink.evaluate(physicalContext({ nns: ctrl, cudns: jumbo }));
        // control-1 maps physnet only: machinenet fires, the physnet-vmdata networks do not.
        expect(findings.map((f) => f.subject.kind === 'graph-node' && f.subject.graphNodeId)).toEqual(['cudn:machinenet']);
    });
});
