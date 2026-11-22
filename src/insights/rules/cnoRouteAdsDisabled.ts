import { operatorNetworkRef, plural, prerequisite, routeAdvertisementsRef, unmetEvidence } from '../cno';
import { nameList } from '../masquerade';
import { makeFinding } from '../refs';
import type { PhysicalRule } from '../types';

/**
 * cno-route-ads-disabled (ovn-recon-n7r.3): RouteAdvertisements resources exist but
 * the network operator does not have route advertisements Enabled, so OVN-Kubernetes
 * ignores them. Reads the route advertisements checklist; its FRR prerequisite, when
 * also unmet, goes in the evidence, because the API refuses Enabled without it.
 * Once, on the network configuration.
 */
export const cnoRouteAdsDisabled: PhysicalRule = {
    id: 'cno-route-ads-disabled',
    severity: 'warning',
    scope: 'network',
    domain: 'physical',
    title: 'RouteAdvertisements ignored: route advertisements are not enabled',
    evaluate: ({ cluster }) => {
        const config = cluster.networkConfig;
        const enabled = prerequisite(config, 'route-advertisements', 'route-advertisements-enabled');
        const resources = config?.sources.routeAdvertisements ?? [];
        if (enabled?.state !== 'unmet' || resources.length === 0) return [];
        const frr = prerequisite(config, 'route-advertisements', 'frr-provider');
        const names = resources.map((resource) => resource.metadata?.name || '').filter(Boolean);
        return [makeFinding({
            ruleId: cnoRouteAdsDisabled.id,
            severity: cnoRouteAdsDisabled.severity,
            subject: { kind: 'k8s', ref: operatorNetworkRef },
            scope: {},
            summary: `${plural(resources.length, 'RouteAdvertisements resource')} (${nameList(names)}) `
                + `${resources.length === 1 ? 'is' : 'are'} ignored: route advertisements are ${enabled.actual}.`,
            evidence: [
                {
                    fact: `${plural(resources.length, 'RouteAdvertisements resource')} ${resources.length === 1 ? 'exists' : 'exist'}.`,
                    sources: resources.map(routeAdvertisementsRef)
                },
                unmetEvidence(enabled),
                ...(frr?.state === 'unmet' ? [unmetEvidence(frr)] : [])
            ],
            remedy: {
                text: frr?.state === 'unmet'
                    ? 'Add FRR to spec.additionalRoutingCapabilities.providers, then set routeAdvertisements to Enabled '
                        + 'in the network operator configuration.'
                    : 'Set routeAdvertisements to Enabled in the network operator configuration, or delete the '
                        + 'RouteAdvertisements resources if they are not wanted.',
                target: operatorNetworkRef,
                path: frr?.state === 'unmet' ? frr.sourcePath : enabled.sourcePath
            }
        })];
    }
};
