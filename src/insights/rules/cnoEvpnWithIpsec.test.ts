import type { ClusterUserDefinedNetwork } from '../../types';
import { cnoWith, networkConfigOf } from '../cnoTesting';
import { clusterContext, loadItems } from '../testing';
import { cnoEvpnWithIpsec } from './cnoEvpnWithIpsec';

const evpnCudns = loadItems<ClusterUserDefinedNetwork>('cudn', 'evpn-vxlan.json');
const ipsecFull = cnoWith((data) => {
    data.operatorNetwork.spec!.defaultNetwork!.ovnKubernetesConfig!.ipsecConfig = { mode: 'Full' };
});

describe('cno-evpn-with-ipsec', () => {
    it('fires on an EVPN CUDN while IPsec is enabled', () => {
        const findings = cnoEvpnWithIpsec.evaluate(clusterContext({ cudns: evpnCudns, networkConfig: networkConfigOf(ipsecFull) }));
        expect(findings).toHaveLength(1);
        expect(findings[0].summary).toBe(
            'ClusterUserDefinedNetwork demo-evpn-vni10010 is carried over EVPN while IPsec is Full; EVPN does not support IPsec.');
        expect(findings[0].scope.network).toEqual(expect.objectContaining({ name: 'demo-evpn-vni10010' }));
        expect(findings[0].remedy.path).toBe('spec.defaultNetwork.ovnKubernetesConfig.ipsecConfig.mode');
    });

    it('is quiet with IPsec disabled, or with no EVPN network', () => {
        expect(cnoEvpnWithIpsec.evaluate(clusterContext({ cudns: evpnCudns, networkConfig: networkConfigOf() }))).toEqual([]);
        expect(cnoEvpnWithIpsec.evaluate(clusterContext({ networkConfig: networkConfigOf(ipsecFull) }))).toEqual([]);
    });
});
