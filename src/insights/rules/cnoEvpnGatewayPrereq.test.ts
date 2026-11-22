import type { ClusterUserDefinedNetwork, Vtep } from '../../types';
import { cnoWith, networkConfigOf } from '../cnoTesting';
import { clusterContext, loadItems } from '../testing';
import { cnoEvpnGatewayPrereq } from './cnoEvpnGatewayPrereq';

const evpnCudns = loadItems<ClusterUserDefinedNetwork>('cudn', 'evpn-vxlan.json');
const vteps = loadItems<Vtep>('vtep', 'evpn-vxlan.json');

const localGateway = cnoWith((data) => {
    data.operatorNetwork.spec!.defaultNetwork!.ovnKubernetesConfig!.gatewayConfig = { routingViaHost: true, ipForwarding: 'Global' };
});

describe('cno-evpn-gateway-prereq', () => {
    it('fires on each EVPN CUDN while the gateway is shared with restricted forwarding', () => {
        const findings = cnoEvpnGatewayPrereq.evaluate(clusterContext({
            cudns: evpnCudns, networkConfig: networkConfigOf(undefined, { vteps })
        }));
        expect(findings).toHaveLength(1);
        expect(findings[0]).toEqual(expect.objectContaining({
            subject: { kind: 'k8s', ref: expect.objectContaining({ kind: 'ClusterUserDefinedNetwork', name: 'demo-evpn-vni10010' }) },
            summary: 'ClusterUserDefinedNetwork demo-evpn-vni10010 is carried over EVPN, which needs local gateway mode '
                + '(routingViaHost is true) and IP forwarding is Global.'
        }));
        expect(findings[0].evidence.map((e) => e.path)).toEqual([
            'spec.network.evpn',
            'spec.defaultNetwork.ovnKubernetesConfig.gatewayConfig.routingViaHost',
            'spec.defaultNetwork.ovnKubernetesConfig.gatewayConfig.ipForwarding'
        ]);
        expect(findings[0].remedy.target).toEqual(expect.objectContaining({ group: 'operator.openshift.io', kind: 'Network' }));
    });

    it('names only the prerequisite that is missing', () => {
        const data = cnoWith((d) => {
            d.operatorNetwork.spec!.defaultNetwork!.ovnKubernetesConfig!.gatewayConfig!.routingViaHost = true;
        });
        const [finding] = cnoEvpnGatewayPrereq.evaluate(clusterContext({ cudns: evpnCudns, networkConfig: networkConfigOf(data) }));
        expect(finding.evidence).toHaveLength(2);
        expect(finding.remedy.path).toBe('spec.defaultNetwork.ovnKubernetesConfig.gatewayConfig.ipForwarding');
    });

    it('fires once on the network configuration when VTEPs exist but no CUDN uses EVPN', () => {
        const findings = cnoEvpnGatewayPrereq.evaluate(clusterContext({ networkConfig: networkConfigOf(undefined, { vteps }) }));
        expect(findings).toHaveLength(1);
        expect(findings[0].subject).toEqual({ kind: 'k8s', ref: expect.objectContaining({ kind: 'Network', name: 'cluster' }) });
        expect(findings[0].summary).toMatch(/^1 VTEP \(demo-evpn-vteps\) exists for EVPN/);
    });

    it('is quiet in local gateway mode with global forwarding', () => {
        expect(cnoEvpnGatewayPrereq.evaluate(clusterContext({
            cudns: evpnCudns, networkConfig: networkConfigOf(localGateway, { vteps })
        }))).toEqual([]);
    });

    it('is quiet when nothing uses EVPN, and without the network configuration', () => {
        expect(cnoEvpnGatewayPrereq.evaluate(clusterContext({ networkConfig: networkConfigOf() }))).toEqual([]);
        expect(cnoEvpnGatewayPrereq.evaluate(clusterContext({ cudns: evpnCudns }))).toEqual([]);
    });
});
