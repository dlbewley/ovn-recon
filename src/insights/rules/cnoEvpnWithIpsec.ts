import { evpnCudns, evpnPath, operatorNetworkRef, unmetEvidence, unmetPrerequisites } from '../cno';
import { cudnRef, makeFinding } from '../refs';
import type { PhysicalRule } from '../types';

/**
 * cno-evpn-with-ipsec (ovn-recon-n7r.3): a CUDN is carried over EVPN while IPsec is
 * enabled. EVPN does not support IPsec. Reads the EVPN checklist's `ipsec-disabled`
 * prerequisite; one finding per EVPN network, on the network. Quiet while the
 * operator configuration is unread.
 */
export const cnoEvpnWithIpsec: PhysicalRule = {
    id: 'cno-evpn-with-ipsec',
    severity: 'warning',
    scope: 'network',
    domain: 'physical',
    title: 'EVPN network with IPsec enabled',
    evaluate: ({ cluster }) => {
        const [ipsec] = unmetPrerequisites(cluster.networkConfig, 'evpn', ['ipsec-disabled']);
        if (!ipsec) return [];
        return evpnCudns(cluster.cudns).map((cudn) => {
            const ref = cudnRef(cudn);
            return makeFinding({
                ruleId: cnoEvpnWithIpsec.id,
                severity: cnoEvpnWithIpsec.severity,
                subject: { kind: 'k8s', ref },
                scope: { network: ref },
                summary: `ClusterUserDefinedNetwork ${ref.name} is carried over EVPN while IPsec is ${ipsec.actual}; EVPN does not support IPsec.`,
                evidence: [
                    { fact: `${ref.name} is carried over EVPN.`, sources: [ref], path: evpnPath(cudn) },
                    unmetEvidence(ipsec)
                ],
                remedy: {
                    text: 'Carry this network over Geneve instead of EVPN, or set ipsecConfig.mode to Disabled in the '
                        + 'network operator configuration (a MachineConfig rollout to every node).',
                    target: operatorNetworkRef,
                    path: ipsec.sourcePath
                }
            });
        });
    }
};
