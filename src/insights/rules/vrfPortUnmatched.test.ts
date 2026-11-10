import type { ClusterUserDefinedNetwork, NetworkAttachmentDefinition, NodeNetworkState } from '../../types';
import { clone, fixtureNames, loadFixture, loadItems, physicalContext } from '../testing';
import { vrfPortUnmatched } from './vrfPortUnmatched';

const evpn = {
    nns: loadFixture<NodeNetworkState>('nns', 'evpn-vxlan.json'),
    cudns: loadItems<ClusterUserDefinedNetwork>('cudn', 'evpn-vxlan.json'),
    nads: loadItems<NetworkAttachmentDefinition>('nad', 'evpn-vxlan.json')
};

describe('vrf-port-unmatched', () => {
    it('fires when a VRF declares a port no interface carries, naming the network behind the VRF as inferred', () => {
        // The real EVPN capture without the svl2.9 SVI that mp9-udn-vrf lists as a port.
        const nns = clone(evpn.nns);
        nns.status!.currentState!.interfaces = nns.status!.currentState!.interfaces
            .filter((iface) => iface.name !== 'svl2.9');

        const findings = vrfPortUnmatched.evaluate(physicalContext({ ...evpn, nns }));

        expect(findings).toHaveLength(1);
        expect(findings[0]).toEqual(expect.objectContaining({
            subject: { kind: 'graph-node', node: 'worker-evpn', graphNodeId: 'vrf:mp9-udn-vrf' },
            summary: 'VRF mp9-udn-vrf on worker-evpn declares port svl2.9, which no interface carries.'
        }));
        const owner = findings[0].evidence[2];
        expect(owner.fact).toBe('VRF mp9-udn-vrf belongs to ClusterUserDefinedNetwork demo-evpn-vni10010.');
        expect(owner.inferred).toMatch(/^Matched by network-id/);
        expect(findings[0].remedy.target).toEqual(expect.objectContaining({
            kind: 'ClusterUserDefinedNetwork', name: 'demo-evpn-vni10010'
        }));
    });

    it('gives each missing port its own finding', () => {
        const nns = clone(evpn.nns);
        nns.status!.currentState!.interfaces = nns.status!.currentState!.interfaces
            .filter((iface) => iface.name !== 'svl2.9' && iface.name !== 'ovn-k8s-mp9');
        const findings = vrfPortUnmatched.evaluate(physicalContext({ ...evpn, nns }));
        expect(new Set(findings.map((f) => f.key)).size).toBe(2);
    });

    it.each(fixtureNames('nns'))('is quiet on the %s capture', (name) => {
        const nns = loadFixture<NodeNetworkState>('nns', name);
        const items = (nns as unknown as { items?: NodeNetworkState[] }).items ?? [nns];
        items.forEach((item) => expect(vrfPortUnmatched.evaluate(physicalContext({ nns: item }))).toEqual([]));
    });
});
