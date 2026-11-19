import type { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import { networkCidr, parsePrefix, ParsedPrefix, prefixContains } from '../components/ipPrefix';
import { NODE_MASQUERADE_SUBNET_ANNOTATION, nodeMasqueradeSubnets } from '../components/masqueradeIps';
import { NETWORK_ID_ANNOTATION } from '../components/nodeVisualizationSelectors';
import type { NetworkAttachmentDefinition } from '../types';
import { nodeRef } from './refs';
import type { Evidence, K8sRef } from './types';

/**
 * What the masquerade rules (ovn-recon-2n6.5) share. Pure. The model itself is
 * src/components/masqueradeIps.ts; this is only the findings' view of it.
 */

/** The Cluster Network Operator's configuration, where the masquerade subnet is set. */
export const operatorNetworkRef: K8sRef = {
    group: 'operator.openshift.io', version: 'v1', kind: 'Network', name: 'cluster'
};

/** The field that sets the masquerade subnet of one family. */
export const internalMasqueradeSubnetPath = (family: 4 | 6): string =>
    `spec.defaultNetwork.ovnKubernetesConfig.gatewayConfig.${family === 4 ? 'ipv4' : 'ipv6'}.internalMasqueradeSubnet`;

export const NODE_ANNOTATION_PATH = `metadata.annotations["${NODE_MASQUERADE_SUBNET_ANNOTATION}"]`;

/** Said wherever a rule leans on the per-network offsets. */
export const FORMULA_INFERRED =
    'Derived from the offset OVN-Kubernetes gives each network (10 + 2 x network ID - 1 for the gateway router, '
    + '10 + 2 x network ID for the management port), an upstream implementation detail rather than a documented contract.';

/** Two prefixes share any address. */
export const prefixesOverlap = (a: ParsedPrefix, b: ParsedPrefix): boolean =>
    a.family === b.family && (prefixContains(a, b) || prefixContains(b, a));

/** The canonical CIDR text of a prefix, for grouping (`169.254.0.0/17`). */
export const cidrKey = (text: string): string | undefined => {
    const parsed = parsePrefix(text);
    return parsed ? networkCidr(parsed) : undefined;
};

const widthOf = (family: 4 | 6): number => (family === 4 ? 32 : 128);

/**
 * How many networks' masquerade pairs a subnet holds: the highest network ID
 * whose management port (offset 10 + 2*ID) is still a usable address. IPv4 keeps
 * its broadcast address back. Zero for the legacy /29 and /125.
 */
export const masqueradeCapacity = (prefix: ParsedPrefix): number => {
    const size = 1n << BigInt(widthOf(prefix.family) - prefix.length);
    const lastUsable = size - (prefix.family === 4 ? 2n : 1n);
    if (lastUsable < 12n) return 0;
    const capacity = (lastUsable - 10n) / 2n;
    return capacity > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(capacity);
};

/** One subnet a Node annotation names, and the Nodes that name it. */
export interface AnnotatedSubnet {
    cidr: string;
    prefix: ParsedPrefix;
    nodes: string[];
}

/** Every subnet the Nodes' masquerade annotation names, by family and then CIDR. */
export const annotatedMasqueradeSubnets = (nodes: readonly K8sResourceCommon[] = []): AnnotatedSubnet[] => {
    const byCidr = new Map<string, AnnotatedSubnet>();
    for (const node of nodes) {
        const name = node.metadata?.name;
        if (!name) continue;
        for (const text of nodeMasqueradeSubnets(node)) {
            const prefix = parsePrefix(text);
            if (!prefix) continue;
            const cidr = networkCidr(prefix);
            const entry = byCidr.get(cidr) ?? { cidr, prefix: parsePrefix(cidr) as ParsedPrefix, nodes: [] };
            if (!entry.nodes.includes(name)) entry.nodes.push(name);
            byCidr.set(cidr, entry);
        }
    }
    return [...byCidr.values()].sort((a, b) => a.prefix.family - b.prefix.family || a.cidr.localeCompare(b.cidr));
};

/** "worker-1", "worker-1 and worker-2", "worker-1, worker-2 and 3 more". */
export const nameList = (names: readonly string[], shown = 3): string => {
    const sorted = [...names].sort();
    if (sorted.length <= shown) {
        return sorted.length <= 1 ? sorted.join('') : `${sorted.slice(0, -1).join(', ')} and ${sorted[sorted.length - 1]}`;
    }
    return `${sorted.slice(0, shown).join(', ')} and ${sorted.length - shown} more`;
};

export const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** Evidence that a set of Nodes carry a masquerade subnet annotation. */
export const annotationEvidence = (subnet: AnnotatedSubnet): Evidence => ({
    fact: `${plural(subnet.nodes.length, 'Node')} (${nameList(subnet.nodes)}) ${subnet.nodes.length === 1 ? 'reports' : 'report'} the masquerade subnet ${subnet.cidr}.`,
    sources: [...subnet.nodes].sort().map(nodeRef),
    path: NODE_ANNOTATION_PATH
});

/** A NAD's network ID, when it carries a usable one. */
export const nadNetworkId = (nad: NetworkAttachmentDefinition): number | undefined => {
    const id = Number(nad.metadata?.annotations?.[NETWORK_ID_ANNOTATION]);
    return Number.isSafeInteger(id) && id >= 1 ? id : undefined;
};

export { NETWORK_ID_ANNOTATION };
