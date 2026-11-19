import { DEFAULT_MASQUERADE_SUBNETS, primaryNetworkIds } from '../../components/masqueradeIps';
import {
    annotatedMasqueradeSubnets,
    annotationEvidence,
    FORMULA_INFERRED,
    internalMasqueradeSubnetPath,
    masqueradeCapacity,
    nadNetworkId,
    NETWORK_ID_ANNOTATION,
    operatorNetworkRef,
    plural
} from '../masquerade';
import { makeFinding, nadRef } from '../refs';
import type { Evidence, PhysicalRule } from '../types';

/**
 * masquerade-subnet-too-small (ovn-recon-2n6.5): the effective masquerade subnet,
 * as the Nodes' `k8s.ovn.org/node-masquerade-subnet` annotation reports it, cannot
 * hold offset 10 + 2 * the highest network ID in use, so that network has no
 * masquerade pair. The usual cause is a cluster upgraded from before OpenShift 4.17
 * that kept 169.254.169.0/29 or fd69::/125, which hold the global roles only; the
 * subnet cannot be changed once a user-defined network exists.
 *
 * A warning when a primary network needs the pair. Without one it is info: the
 * subnet can still be widened, and the first primary network would need ID 1's pair
 * (or the next after the highest ID a NAD already carries). Quiet without Nodes or
 * without the annotation: absence is not a problem.
 */
export const masqueradeSubnetTooSmall: PhysicalRule = {
    id: 'masquerade-subnet-too-small',
    severity: 'warning',
    scope: 'network',
    domain: 'physical',
    title: 'Masquerade subnet too small for user-defined networks',
    evaluate: ({ cluster }) => {
        const subnets = annotatedMasqueradeSubnets(cluster.nodes);
        if (subnets.length === 0) return [];

        const primaryIds = primaryNetworkIds(cluster.nads);
        const primary = primaryIds.length > 0;
        const withIds = cluster.nads
            .map((nad) => ({ nad, id: nadNetworkId(nad) }))
            .filter((entry): entry is { nad: typeof entry.nad; id: number } => entry.id !== undefined);
        const highestAny = withIds.reduce((max, entry) => Math.max(max, entry.id), 0);
        const needed = primary ? primaryIds[primaryIds.length - 1] : Math.max(1, highestAny);
        const neededBy = withIds.filter((entry) => entry.id === needed).map((entry) => entry.nad);

        return subnets.flatMap((subnet) => {
            const capacity = masqueradeCapacity(subnet.prefix);
            if (needed <= capacity) return [];
            const family = subnet.prefix.family;
            const defaultCidr = DEFAULT_MASQUERADE_SUBNETS[family === 4 ? 0 : 1];
            const holds = `can hold the masquerade addresses of ${plural(capacity, 'user-defined network')}`;
            const evidence: Evidence[] = [annotationEvidence(subnet)];
            if (neededBy.length > 0) {
                evidence.push({
                    fact: `Network ID ${needed} is in use${primary ? ' by a primary network' : ''}; its pair needs offset ${10 + 2 * needed}, `
                        + `and ${subnet.cidr} ${holds}.`,
                    sources: neededBy.map(nadRef),
                    path: `metadata.annotations["${NETWORK_ID_ANNOTATION}"]`,
                    inferred: FORMULA_INFERRED
                });
            } else {
                evidence.push({
                    fact: `The first user-defined network takes ID 1, whose pair needs offset 12; ${subnet.cidr} ${holds}.`,
                    sources: [operatorNetworkRef],
                    inferred: FORMULA_INFERRED
                });
            }
            return [makeFinding({
                ruleId: masqueradeSubnetTooSmall.id,
                severity: primary ? 'warning' : 'info',
                subject: { kind: 'k8s', ref: operatorNetworkRef },
                scope: {},
                summary: primary
                    ? `The masquerade subnet ${subnet.cidr} ${holds}, but network ID ${needed} is in use by a primary network; `
                        + 'it cannot be changed once a user-defined network exists.'
                    : `The masquerade subnet ${subnet.cidr} ${holds}; `
                        + 'it cannot be changed once a user-defined network exists.',
                evidence,
                remedy: primary
                    ? {
                        text: `Primary networks with an ID above ${capacity} have no masquerade addresses. The subnet cannot be changed `
                            + 'while a user-defined network exists; plan the change with the user-defined networks removed.',
                        target: operatorNetworkRef,
                        path: internalMasqueradeSubnetPath(family),
                        verb: 'view'
                    }
                    : {
                        text: `Widen internalMasqueradeSubnet (the default is ${defaultCidr}) before creating a user-defined network; `
                            + 'it cannot be changed once one exists.',
                        target: operatorNetworkRef,
                        path: internalMasqueradeSubnetPath(family)
                    }
            }, subnet.cidr)];
        });
    }
};
