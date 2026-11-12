import { multiNetworkPolicyRef, makeFinding, nadRefByName } from '../refs';
import type { LogicalRule } from '../types';

export const POLICY_FOR_ANNOTATION = 'k8s.v1.cni.cncf.io/policy-for';

/** The NADs a policy-for value names, each as namespace and name. */
export const policyForTargets = (value: string, policyNamespace: string): Array<{ namespace: string; name: string }> =>
    value.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
        const slash = entry.indexOf('/');
        return slash > 0
            ? { namespace: entry.slice(0, slash), name: entry.slice(slash + 1) }
            : { namespace: policyNamespace, name: entry };
    });

/**
 * mnp-missing-nad: a MultiNetworkPolicy's policy-for annotation names a
 * NetworkAttachmentDefinition that does not exist. One finding per missing name, on
 * the policy. Quiet until both lists have loaded, and on clusters without the
 * MultiNetworkPolicy CRD (the page then passes no cluster inputs).
 */
export const mnpMissingNad: LogicalRule = {
    id: 'mnp-missing-nad',
    severity: 'warning',
    scope: 'network',
    domain: 'logical',
    title: 'MultiNetworkPolicy names a missing network',
    evaluate: ({ cluster }) => {
        if (!cluster) return [];
        const existing = new Set(cluster.nads.map((nad) =>
            `${nad.metadata?.namespace || 'default'}/${nad.metadata?.name || ''}`));
        return cluster.multiNetworkPolicies.flatMap((policy) => {
            const value = policy.metadata?.annotations?.[POLICY_FOR_ANNOTATION];
            const namespace = policy.metadata?.namespace || 'default';
            const name = policy.metadata?.name || '';
            if (!value || !name) return [];
            const ref = multiNetworkPolicyRef(namespace, name);
            return policyForTargets(value, namespace)
                .filter((target) => !existing.has(`${target.namespace}/${target.name}`))
                .map((target) => makeFinding({
                    ruleId: mnpMissingNad.id,
                    severity: mnpMissingNad.severity,
                    subject: { kind: 'k8s', ref },
                    scope: { network: nadRefByName(target.namespace, target.name) },
                    summary: `MultiNetworkPolicy ${namespace}/${name} applies to NetworkAttachmentDefinition `
                        + `${target.namespace}/${target.name}, which does not exist.`,
                    evidence: [
                        {
                            fact: `The annotation ${POLICY_FOR_ANNOTATION} is "${value}".`,
                            sources: [ref],
                            path: `metadata.annotations["${POLICY_FOR_ANNOTATION}"]`
                        },
                        {
                            fact: `No NetworkAttachmentDefinition ${target.name} exists in namespace ${target.namespace}.`,
                            sources: []
                        }
                    ],
                    remedy: {
                        text: 'Correct the name in the annotation, or create the missing '
                            + 'NetworkAttachmentDefinition. Until one exists, this policy has no network to apply to.',
                        target: ref,
                        path: `metadata.annotations["${POLICY_FOR_ANNOTATION}"]`
                    }
                }, `${target.namespace}/${target.name}`));
        });
    }
};
