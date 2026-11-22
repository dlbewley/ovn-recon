import type { RouteAdvertisements } from '../../types';
import { cnoWith, networkConfigOf } from '../cnoTesting';
import { clusterContext } from '../testing';
import { cnoRouteAdsDisabled } from './cnoRouteAdsDisabled';

const advertisement = (name: string): RouteAdvertisements =>
    ({ apiVersion: 'k8s.ovn.org/v1', kind: 'RouteAdvertisements', metadata: { name }, spec: {} } as RouteAdvertisements);

const enabled = cnoWith((data) => {
    data.operatorNetwork.spec!.additionalRoutingCapabilities = { providers: ['FRR'] };
    data.operatorNetwork.spec!.defaultNetwork!.ovnKubernetesConfig!.routeAdvertisements = 'Enabled';
});

describe('cno-route-ads-disabled', () => {
    it('fires once when RouteAdvertisements exist but route advertisements are left Disabled', () => {
        const findings = cnoRouteAdsDisabled.evaluate(clusterContext({
            networkConfig: networkConfigOf(undefined, { routeAdvertisements: [advertisement('default'), advertisement('blue')] })
        }));
        expect(findings).toHaveLength(1);
        expect(findings[0].summary).toBe(
            '2 RouteAdvertisements resources (blue and default) are ignored: route advertisements are Disabled.');
        expect(findings[0].evidence[0].sources.map((s) => s.name)).toEqual(['default', 'blue']);
        // FRR is missing too, so the remedy starts there.
        expect(findings[0].evidence).toHaveLength(3);
        expect(findings[0].remedy.path).toBe('spec.additionalRoutingCapabilities.providers');
    });

    it('points at routeAdvertisements when FRR is already a provider', () => {
        const data = cnoWith((d) => { d.operatorNetwork.spec!.additionalRoutingCapabilities = { providers: ['FRR'] }; });
        const [finding] = cnoRouteAdsDisabled.evaluate(clusterContext({
            networkConfig: networkConfigOf(data, { routeAdvertisements: [advertisement('default')] })
        }));
        expect(finding.evidence).toHaveLength(2);
        expect(finding.remedy.path).toBe('spec.defaultNetwork.ovnKubernetesConfig.routeAdvertisements');
    });

    it('is quiet with route advertisements Enabled, or with no RouteAdvertisements', () => {
        expect(cnoRouteAdsDisabled.evaluate(clusterContext({
            networkConfig: networkConfigOf(enabled, { routeAdvertisements: [advertisement('default')] })
        }))).toEqual([]);
        expect(cnoRouteAdsDisabled.evaluate(clusterContext({ networkConfig: networkConfigOf() }))).toEqual([]);
    });
});
