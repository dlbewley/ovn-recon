import { evpnCudns, evpnPath, operatorNetworkRef, plural, unmetEvidence, unmetPrerequisites, vtepRef } from '../cno';
import { nameList } from '../masquerade';
import { cudnRef, makeFinding } from '../refs';
import type { Evidence, PhysicalRule } from '../types';

/** The EVPN gateway prerequisites, by their id on the capability checklist. */
const GATEWAY_PREREQUISITES = ['routing-via-host', 'ip-forwarding-global'] as const;

/**
 * cno-evpn-gateway-prereq (ovn-recon-n7r.3): the cluster is visibly using EVPN (a
 * CUDN declares it, or a VTEP exists) while the gateway is not set up for it. EVPN on
 * a primary CUDN is supported only in local gateway mode (`routingViaHost: true`)
 * with `ipForwarding: Global`.
 *
 * Reads the EVPN checklist's two gateway prerequisites rather than the spec. Each EVPN
 * CUDN gets its own finding, so it lands on that network; VTEPs with no EVPN CUDN get
 * one, on the network configuration. Quiet while the operator configuration is unread.
 */
export const cnoEvpnGatewayPrereq: PhysicalRule = {
    id: 'cno-evpn-gateway-prereq',
    severity: 'warning',
    scope: 'network',
    domain: 'physical',
    title: 'EVPN without local gateway mode and global IP forwarding',
    evaluate: ({ cluster }) => {
        const unmet = unmetPrerequisites(cluster.networkConfig, 'evpn', GATEWAY_PREREQUISITES);
        if (unmet.length === 0) return [];
        const networks = evpnCudns(cluster.cudns);
        const vteps = cluster.networkConfig?.sources.vteps ?? [];
        // "Local gateway mode ..." reads "local gateway mode ..." mid-sentence; "IP forwarding" stays.
        const lower = (label: string) => (/^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label);
        const missing = unmet.map((candidate) => lower(candidate.label)).join(' and ');
        const remedy = {
            text: 'Set gatewayConfig.routingViaHost to true and gatewayConfig.ipForwarding to Global in the network '
                + 'operator configuration. Changing the gateway mode restarts ovnkube-node on every node.',
            target: operatorNetworkRef,
            path: unmet[0].sourcePath
        };
        const gatewayEvidence: Evidence[] = unmet.map(unmetEvidence);

        if (networks.length > 0) {
            return networks.map((cudn) => {
                const ref = cudnRef(cudn);
                return makeFinding({
                    ruleId: cnoEvpnGatewayPrereq.id,
                    severity: cnoEvpnGatewayPrereq.severity,
                    subject: { kind: 'k8s', ref },
                    scope: { network: ref },
                    summary: `ClusterUserDefinedNetwork ${ref.name} is carried over EVPN, which needs ${missing}.`,
                    evidence: [
                        { fact: `${ref.name} is carried over EVPN.`, sources: [ref], path: evpnPath(cudn) },
                        ...gatewayEvidence
                    ],
                    remedy
                });
            });
        }
        if (vteps.length === 0) return [];
        const names = vteps.map((vtep) => vtep.metadata?.name || '').filter(Boolean);
        return [makeFinding({
            ruleId: cnoEvpnGatewayPrereq.id,
            severity: cnoEvpnGatewayPrereq.severity,
            subject: { kind: 'k8s', ref: operatorNetworkRef },
            scope: {},
            summary: `${plural(vteps.length, 'VTEP')} (${nameList(names)}) ${vteps.length === 1 ? 'exists' : 'exist'} for EVPN, which needs ${missing}.`,
            evidence: [
                { fact: `${plural(vteps.length, 'VTEP')} ${vteps.length === 1 ? 'is' : 'are'} defined.`, sources: vteps.map(vtepRef) },
                ...gatewayEvidence
            ],
            remedy
        })];
    }
};
