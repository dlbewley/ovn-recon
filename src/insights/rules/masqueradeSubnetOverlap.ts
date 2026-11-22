import { networkCidr, parsePrefix, ParsedPrefix } from '../../components/ipPrefix';
import { MasqueradeSubnet, masqueradeSubnets } from '../../components/masqueradeIps';
import { ifaceNodeId } from '../../topology/ids';
import { subnetCidrs } from '../../topology/subnets';
import type { Layer3Subnet, NodeNetworkState } from '../../types';
import { NODE_ANNOTATION_PATH, operatorNetworkRef, prefixesOverlap } from '../masquerade';
import { cudnRef, makeFinding, nnsRef, udnRef } from '../refs';
import type { ClusterNetworkInputs, Evidence, Finding, K8sRef, PhysicalRule } from '../types';

/**
 * masquerade-subnet-overlap (ovn-recon-2n6.5): the node masquerade subnet shares
 * addresses with
 *
 *   - a CUDN's or UDN's subnets or join subnets (on the network);
 *   - an interface address a NodeNetworkState reports (on the node's interface),
 *     other than the masquerade addresses OVN-Kubernetes itself puts on br-ex and
 *     the management ports;
 *   - the join or transit subnet a zone's router ports carry (on the network
 *     configuration, once per subnet).
 *
 * The masquerade subnet is what the Nodes' annotation says, else what a held zone's
 * gateway router routes to, else the default (masqueradeSubnets). Each overlapping
 * subnet is reported once, at the first place it was found in the order above.
 */

/** Interfaces OVN-Kubernetes gives masquerade addresses of its own. */
const OWNS_MASQUERADE_ADDRESS = (name: string): boolean => name === 'br-ex' || name.startsWith('ovn-k8s-mp');

/** Router ports towards the join switch or the transit switch or router (`rtoj-`, `rtots-`, `rtotr-`). */
const JOIN_OR_TRANSIT_PORT = /(^|_)rto(j|ts|tr)-/;

interface Overlap {
    masquerade: MasqueradeSubnet;
    other: ParsedPrefix;
}

const overlapping = (subnets: readonly MasqueradeSubnet[], text: string): Overlap | undefined => {
    const other = parsePrefix(text);
    if (!other) return undefined;
    const masquerade = subnets.find((subnet) => prefixesOverlap(subnet.prefix, other));
    return masquerade ? { masquerade, other } : undefined;
};

const masqueradeEvidence = (subnet: MasqueradeSubnet): Evidence => {
    if (subnet.source === 'node-annotation') {
        return { fact: `The Nodes report the masquerade subnet ${subnet.cidr}.`, sources: [], path: NODE_ANNOTATION_PATH };
    }
    if (subnet.source === 'static-route') {
        return { fact: `The gateway routers route the masquerade subnet ${subnet.cidr}.`, sources: [], origin: 'the zone databases this tab holds' };
    }
    return {
        fact: `The masquerade subnet is taken to be ${subnet.cidr}.`,
        sources: [],
        inferred: 'The OVN-Kubernetes default: no Node reports the subnet and no gateway router routes it.'
    };
};

interface DeclaredNetwork {
    ref: K8sRef;
    label: string;
    layerPath: string;
    subnets: string[];
    joinSubnets: string[];
}

const layerOf = (
    network: { topology?: string; layer2?: { subnets?: string[]; joinSubnets?: string[] }; layer3?: { subnets?: Layer3Subnet[]; joinSubnets?: string[] } } | undefined
): { key: 'layer2' | 'layer3'; subnets: string[]; joinSubnets: string[] } | undefined => {
    if (network?.topology === 'Layer2' && network.layer2) {
        return { key: 'layer2', subnets: subnetCidrs(network.layer2.subnets), joinSubnets: network.layer2.joinSubnets ?? [] };
    }
    if (network?.topology === 'Layer3' && network.layer3) {
        return { key: 'layer3', subnets: subnetCidrs(network.layer3.subnets), joinSubnets: network.layer3.joinSubnets ?? [] };
    }
    return undefined;
};

const declaredNetworks = (cluster: ClusterNetworkInputs): DeclaredNetwork[] => [
    ...cluster.cudns.flatMap((cudn): DeclaredNetwork[] => {
        const layer = layerOf(cudn.spec?.network);
        if (!layer) return [];
        const ref = cudnRef(cudn);
        return [{ ref, label: `ClusterUserDefinedNetwork ${ref.name}`, layerPath: `spec.network.${layer.key}`, ...layer }];
    }),
    ...cluster.udns.flatMap((udn): DeclaredNetwork[] => {
        const layer = layerOf(udn.spec);
        if (!layer) return [];
        const ref = udnRef(udn);
        return [{ ref, label: `UserDefinedNetwork ${ref.namespace}/${ref.name}`, layerPath: `spec.${layer.key}`, ...layer }];
    })
];

interface InterfaceAddress {
    ip: string;
    'prefix-length'?: number;
    prefix_length?: number;
}

const interfaceAddresses = (nns: NodeNetworkState): Array<{ iface: string; cidr: string; field: string }> =>
    (nns.status?.currentState?.interfaces ?? []).flatMap((iface) =>
        (['ipv4', 'ipv6'] as const).flatMap((family) => {
            const block = (iface as unknown as Record<string, { address?: InterfaceAddress[] } | undefined>)[family];
            return (block?.address ?? []).flatMap((address) => {
                const length = address['prefix-length'] ?? address.prefix_length;
                if (!address.ip || length === undefined) return [];
                return [{ iface: iface.name, cidr: `${address.ip}/${length}`, field: `${family}.address` }];
            });
        }));

export const masqueradeSubnetOverlap: PhysicalRule = {
    id: 'masquerade-subnet-overlap',
    severity: 'warning',
    scope: 'network',
    domain: 'physical',
    title: 'Masquerade subnet overlaps another subnet',
    evaluate: ({ cluster }) => {
        const subnets = masqueradeSubnets({
            nodes: cluster.nodes,
            databases: (cluster.zoneDatabases ?? []).map((zone) => zone.database)
        });
        if (subnets.length === 0) return [];
        const findings: Finding[] = [];
        const reported = new Set<string>();
        const once = (overlap: Overlap, place: string): boolean => {
            const key = `${networkCidr(overlap.other)}|${place}`;
            if (reported.has(key)) return false;
            reported.add(key);
            return true;
        };
        const seenCidrs = new Set<string>();

        const finding = (
            overlap: Overlap,
            what: string,
            subject: Finding['subject'],
            scope: Finding['scope'],
            evidence: Evidence,
            remedy: Finding['remedy']
        ): Finding => makeFinding({
            ruleId: masqueradeSubnetOverlap.id,
            severity: masqueradeSubnetOverlap.severity,
            subject,
            scope,
            summary: `${what} overlaps the masquerade subnet ${overlap.masquerade.cidr}.`,
            evidence: [evidence, masqueradeEvidence(overlap.masquerade)],
            remedy
        }, networkCidr(overlap.other));

        // The networks' declared subnets.
        for (const network of declaredNetworks(cluster)) {
            for (const [field, list] of [['subnets', network.subnets], ['joinSubnets', network.joinSubnets]] as const) {
                for (const text of list) {
                    const overlap = overlapping(subnets, text);
                    if (!overlap || !once(overlap, `network:${network.label}`)) continue;
                    seenCidrs.add(networkCidr(overlap.other));
                    findings.push(finding(
                        overlap,
                        `${network.label} ${field === 'subnets' ? 'subnet' : 'join subnet'} ${text}`,
                        { kind: 'k8s', ref: network.ref },
                        { network: network.ref },
                        { fact: `${network.label} declares ${field} ${text}.`, sources: [network.ref], path: `${network.layerPath}.${field}` },
                        { text: `Choose ${field} for ${network.label} outside ${overlap.masquerade.cidr}.`, target: network.ref, path: `${network.layerPath}.${field}` }
                    ));
                }
            }
        }

        // Node interfaces.
        for (const nns of cluster.nodeNetworkStates ?? []) {
            const node = nns.metadata?.name;
            if (!node) continue;
            for (const { iface, cidr, field } of interfaceAddresses(nns)) {
                const overlap = overlapping(subnets, cidr);
                if (!overlap) continue;
                // OVN-Kubernetes' own masquerade addresses sit inside the subnet by design.
                if (OWNS_MASQUERADE_ADDRESS(iface) && overlap.other.length >= overlap.masquerade.prefix.length) continue;
                if (!once(overlap, `iface:${node}/${iface}`)) continue;
                const ref = nnsRef(node);
                findings.push(finding(
                    overlap,
                    `Interface ${iface} on ${node} address ${cidr}`,
                    { kind: 'graph-node', node, graphNodeId: ifaceNodeId(iface) },
                    { node },
                    { fact: `${iface} on ${node} carries ${cidr}.`, sources: [ref], path: `status.currentState.interfaces[name=${iface}].${field}` },
                    { text: `Move ${iface} on ${node} to an address outside ${overlap.masquerade.cidr}.`, target: ref, verb: 'view' }
                ));
            }
        }

        // Join and transit subnets on router ports.
        for (const { node, database } of cluster.zoneDatabases ?? []) {
            for (const port of database.logicalRouterPorts ?? []) {
                if (!JOIN_OR_TRANSIT_PORT.test(port.name)) continue;
                for (const network of port.networks ?? []) {
                    const overlap = overlapping(subnets, network);
                    if (!overlap) continue;
                    const cidr = networkCidr(overlap.other);
                    if (seenCidrs.has(cidr)) continue;
                    seenCidrs.add(cidr);
                    findings.push(finding(
                        overlap,
                        `The join or transit subnet ${cidr}`,
                        { kind: 'k8s', ref: operatorNetworkRef },
                        {},
                        {
                            fact: `Router port ${port.name} carries ${network}.`,
                            sources: [],
                            path: 'Logical_Router_Port.networks',
                            origin: `the northbound database of node ${node}`
                        },
                        {
                            text: `Set the internal join and transit subnets outside ${overlap.masquerade.cidr}, or the network's own join subnets for a user-defined network.`,
                            target: operatorNetworkRef,
                            path: 'spec.defaultNetwork.ovnKubernetesConfig',
                            verb: 'view'
                        }
                    ));
                }
            }
        }
        return findings;
    }
};
