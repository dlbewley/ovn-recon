import type {
    ClusterUserDefinedNetwork, NetworkAttachmentDefinition, NodeNetworkConfigurationEnactment, NodeNetworkState
} from '../types';
import { evaluatePhysical } from './evaluate';
import { applySurfaceGates, evpnNetworkOfInterface, SURFACE_GATES } from './gates';
import { clone, loadFixture, loadItems, physicalContext } from './testing';
import type { Finding, PhysicalContext } from './types';

// The real EVPN capture: svl2.9 (vlan, a port of VRF mp9-udn-vrf) and ovl2.9 (the
// OVS-side port) are down, as on every node of the lab cluster.
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

/** What a surface shows for one node's page. */
const shown = (ctx: PhysicalContext): Finding[] =>
    applySurfaceGates(evaluatePhysical(ctx), (node) => (node === ctx.node?.nns.metadata?.name ? ctx.node : undefined));

const interfaceDownSubjects = (findings: Finding[]) => findings
    .filter((finding) => finding.ruleId === 'interface-down')
    .map((finding) => finding.subject.kind === 'graph-node' && finding.subject.graphNodeId);

describe('surface gates', () => {
    it('names ovn-recon-7i6.2 on the one gate there is', () => {
        expect(SURFACE_GATES.map((gate) => [gate.bead, gate.ruleId])).toEqual([['ovn-recon-7i6.2', 'interface-down']]);
    });

    describe('interface-down on EVPN interfaces (ovn-recon-7i6.2)', () => {
        it('the engine still reports svl2.9 down; the surface shows nothing for it', () => {
            const ctx = physicalContext(evpn);
            expect(interfaceDownSubjects(evaluatePhysical(ctx))).toEqual(['iface:svl2.9']);
            expect(interfaceDownSubjects(shown(ctx))).toEqual([]);
        });

        it('recognises both of the network\'s EVPN devices from the network data', () => {
            const ctx = physicalContext(evpn).node!;
            expect(evpnNetworkOfInterface({ name: 'svl2.9' }, ctx)).toBe('ClusterUserDefinedNetwork demo-evpn-vni10010');
            expect(evpnNetworkOfInterface({ name: 'ovl2.9' }, ctx)).toBe('ClusterUserDefinedNetwork demo-evpn-vni10010');
            expect(evpnNetworkOfInterface({ name: 'ovn-k8s-mp9' }, ctx)).toBeUndefined();
        });

        it('still shows an ordinary port of the same EVPN network\'s VRF that is down', () => {
            const ctx = physicalContext({ ...evpn, nns: setState(evpn.nns, 'ovn-k8s-mp9', 'down') });
            expect(interfaceDownSubjects(shown(ctx))).toEqual(['iface:ovn-k8s-mp9']);
        });

        it('still shows an ordinary VRF port that is down, as a warning', () => {
            const ctx = physicalContext({ ...worker, nns: setState(worker.nns, 'ovn-k8s-mp3', 'down') });
            const findings = shown(ctx).filter((finding) => finding.ruleId === 'interface-down');
            expect(findings).toHaveLength(1);
            expect(findings[0].severity).toBe('warning');
            expect(findings[0].summary).toBe('Interface ovn-k8s-mp3 on worker-1 is down.');
        });

        it('does not go by the device name alone: a network that declares no EVPN is not gated', () => {
            const cudns = clone(evpn.cudns);
            cudns.forEach((cudn) => { delete cudn.spec!.network!.evpn; });
            const nads = clone(evpn.nads);
            nads.forEach((nad) => {
                const config = JSON.parse(String(nad.spec?.config ?? '{}'));
                delete config.evpn;
                nad.spec = { ...nad.spec, config: JSON.stringify(config) };
            });
            const ctx = physicalContext({ ...evpn, cudns, nads });
            expect(interfaceDownSubjects(shown(ctx))).toEqual(['iface:svl2.9']);
        });

        it('does not gate when the device resolves to no network (no NADs to read its ID from)', () => {
            const ctx = physicalContext({ ...evpn, nads: [] });
            expect(interfaceDownSubjects(shown(ctx))).toEqual(['iface:svl2.9']);
        });

        it('leaves a finding alone when the node\'s context is unknown', () => {
            const findings = evaluatePhysical(physicalContext(evpn));
            expect(applySurfaceGates(findings, () => undefined)).toBe(findings);
        });
    });
});
