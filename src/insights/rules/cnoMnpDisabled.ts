import { isCudnGeneratedNad } from '../network';
import { operatorNetworkRef, plural, prerequisite, unmetEvidence } from '../cno';
import { nameList } from '../masquerade';
import { makeFinding, nadRef } from '../refs';
import type { PhysicalRule } from '../types';

/**
 * cno-mnp-disabled (ovn-recon-n7r.3): multi-network is disabled
 * (`spec.disableMultiNetwork: true`) while NetworkAttachmentDefinitions exist, so
 * Multus is not deployed and no pod is attached to them; any MultiNetworkPolicy over
 * them is ignored too. Reads the MultiNetworkPolicy checklist's `multi-network-enabled`
 * prerequisite. NADs a CUDN generated are left out (the CUDN is the network). Once,
 * on the network configuration.
 *
 * The parent bead's other half, MultiNetworkPolicy objects with useMultiNetworkPolicy
 * false, needs a MultiNetworkPolicy list the explorer shell does not watch; it is
 * not reported here.
 */
export const cnoMnpDisabled: PhysicalRule = {
    id: 'cno-mnp-disabled',
    severity: 'warning',
    scope: 'network',
    domain: 'physical',
    title: 'Multi-network disabled while NetworkAttachmentDefinitions exist',
    evaluate: ({ cluster }) => {
        const multus = prerequisite(cluster.networkConfig, 'multi-network-policy', 'multi-network-enabled');
        if (multus?.state !== 'unmet') return [];
        const nads = cluster.nads.filter((nad) => !isCudnGeneratedNad(nad, cluster.cudns));
        if (nads.length === 0) return [];
        const refs = nads.map(nadRef);
        const names = refs.map((ref) => `${ref.namespace}/${ref.name}`);
        return [makeFinding({
            ruleId: cnoMnpDisabled.id,
            severity: cnoMnpDisabled.severity,
            subject: { kind: 'k8s', ref: operatorNetworkRef },
            scope: {},
            summary: `Multi-network is disabled, so ${plural(nads.length, 'NetworkAttachmentDefinition')} `
                + `(${nameList(names)}) and any MultiNetworkPolicy over them have no effect.`,
            evidence: [
                unmetEvidence(multus),
                {
                    fact: `${plural(nads.length, 'NetworkAttachmentDefinition')} ${nads.length === 1 ? 'exists' : 'exist'}.`,
                    sources: refs
                }
            ],
            remedy: {
                text: 'Set disableMultiNetwork to false in the network operator configuration so Multus is deployed, '
                    + 'and useMultiNetworkPolicy to true if MultiNetworkPolicies should be enforced; or delete the '
                    + 'NetworkAttachmentDefinitions.',
                target: operatorNetworkRef,
                path: multus.sourcePath
            }
        })];
    }
};
