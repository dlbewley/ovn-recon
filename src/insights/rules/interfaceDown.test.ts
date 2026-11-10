import type {
    ClusterUserDefinedNetwork, NetworkAttachmentDefinition, NodeNetworkConfigurationEnactment, NodeNetworkState
} from '../../types';
import { clone, loadFixture, loadItems, physicalContext } from '../testing';
import { interfaceDown } from './interfaceDown';

const evpn = {
    nns: loadFixture<NodeNetworkState>('nns', 'evpn-vxlan.json'),
    cudns: loadItems<ClusterUserDefinedNetwork>('cudn', 'evpn-vxlan.json'),
    nads: loadItems<NetworkAttachmentDefinition>('nad', 'evpn-vxlan.json')
};
const worker = {
    nns: loadFixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json'),
    cudns: loadItems<ClusterUserDefinedNetwork>('cudn', 'primary-cudn-vrf.json'),
    enactments: loadItems<NodeNetworkConfigurationEnactment>('nnce', 'primary-cudn-vrf.json')
};

const setState = (nns: NodeNetworkState, name: string, state: string): NodeNetworkState => {
    const copy = clone(nns);
    copy.status!.currentState!.interfaces.forEach((iface) => { if (iface.name === name) iface.state = state; });
    return copy;
};

describe('interface-down', () => {
    it('fires on a VRF port that is down (the real EVPN capture: svl2.9 in mp9-udn-vrf)', () => {
        const findings = interfaceDown.evaluate(physicalContext(evpn));

        // ovl2.9 is down too, but it is an OVS port on br-int, neither a VRF port nor an uplink.
        expect(findings.map((f) => f.subject)).toEqual([
            { kind: 'graph-node', node: 'worker-evpn', graphNodeId: 'iface:svl2.9' }
        ]);
        expect(findings[0].summary).toBe('Interface svl2.9 on worker-evpn is down.');
        expect(findings[0].evidence.map((e) => e.fact)).toEqual([
            'svl2.9 (vlan) is in state down.',
            'svl2.9 is a port of VRF mp9-udn-vrf.',
            'svl2.9 is enslaved to VRF mp9-udn-vrf.'
        ]);
        expect(findings[0].remedy.target).toEqual(expect.objectContaining({ kind: 'Node', name: 'worker-evpn' }));
    });

    it('fires on the uplink of a mapped bridge, naming the policy that configures it', () => {
        const findings = interfaceDown.evaluate(physicalContext({ ...worker, nns: setState(worker.nns, 'ens224', 'down') }));

        expect(findings.map((f) => f.subject)).toEqual([
            { kind: 'graph-node', node: 'worker-1', graphNodeId: 'iface:ens224' }
        ]);
        expect(findings[0].evidence[1].fact).toBe(
            'ens224 is an uplink of bridge br-vmdata, which physical network physnet-vmdata is mapped to.');
    });

    it('is quiet on unused NICs that are down (the real CNV worker capture)', () => {
        // ens161 and ens256 are down and carry nothing.
        expect(interfaceDown.evaluate(physicalContext(worker))).toEqual([]);
    });

    it('is quiet on the bonded capture, whose down NICs and patch port carry nothing', () => {
        const nns = loadFixture<NodeNetworkState>('nns', 'bonded-lldp.json');
        expect(interfaceDown.evaluate(physicalContext({ nns }))).toEqual([]);
    });

    it('leaves a down bond member to bond-degraded', () => {
        const nns = setState(loadFixture<NodeNetworkState>('nns', 'bonded-lldp.json'), 'ens5f0np0', 'down');
        expect(interfaceDown.evaluate(physicalContext({ nns }))).toEqual([]);
    });

    it('fires on a bridge a bridge-type NAD attaches to', () => {
        const nns = setState(loadFixture<NodeNetworkState>('nns', 'sriov.json'), 'br-mirror', 'down');
        const nad: NetworkAttachmentDefinition = {
            apiVersion: 'k8s.cni.cncf.io/v1',
            kind: 'NetworkAttachmentDefinition',
            metadata: { name: 'mirror', namespace: 'demo' },
            spec: { config: JSON.stringify({ cniVersion: '0.3.1', name: 'mirror', type: 'cnv-bridge', bridge: 'br-mirror' }) }
        };
        const findings = interfaceDown.evaluate(physicalContext({ nns, nads: [nad] }));
        expect(findings.map((f) => f.subject.kind === 'graph-node' && f.subject.graphNodeId)).toEqual(['iface:br-mirror']);
        expect(findings[0].evidence[1]).toEqual(expect.objectContaining({
            fact: 'NetworkAttachmentDefinition demo/mirror attaches to bridge br-mirror.',
            sources: [expect.objectContaining({ kind: 'NetworkAttachmentDefinition', name: 'mirror' })]
        }));
    });
});
