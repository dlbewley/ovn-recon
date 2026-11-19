import type { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import { formatAddress, parsePrefix } from '../../components/ipPrefix';
import { classifyRouter, DEFAULT_NETWORK } from '../../components/logicalClassification';
import {
    classifyMasqueradeAddress,
    MasqueradeSubnet,
    masqueradeIpsForNetworkId,
    masqueradeSubnets,
    resolveMasqueradeNetwork
} from '../../components/masqueradeIps';
import { parseNadConfig } from '../../components/nodeVisualizationSelectors';
import type { LogicalDatabase, LogicalRouterRow, NetworkAttachmentDefinition } from '../../types';
import { constructSubject } from '../logical';
import { FORMULA_INFERRED, nadNetworkId } from '../masquerade';
import { cudnRef, makeFinding, nadRef } from '../refs';
import type { ClusterNetworkInputs, Evidence, K8sRef, PhysicalRule } from '../types';

/**
 * masquerade-address-mismatch (ovn-recon-2n6.5): a primary network's gateway router
 * on a node carries a gateway router masquerade address (on its ports, in
 * physical_ips, or as a NAT external IP) other than the one derived from the
 * network's ID, or carries none in a family it has addresses in.
 *
 * Info, and worded as "differs from the expected address": the offsets are an
 * upstream implementation detail, so what OVN carries is the evidence and the
 * formula only cross-checks it. Read from the zone databases the tab already holds,
 * never fetched for the finding, so the rule is quiet without one. Addresses of other
 * masquerade roles (the management port's NAT on the transit router, say) are not
 * the gateway router's and are not compared.
 */

const nadOvnNetwork = (nad: NetworkAttachmentDefinition): string | undefined => {
    const name = parseNadConfig(nad.spec?.config)?.name;
    return typeof name === 'string' && name ? name : undefined;
};

interface PrimaryNetwork {
    id: number;
    nad: NetworkAttachmentDefinition;
}

/** Primary networks by their `k8s.ovn.org/network` identity, from the NADs. */
const primaryNetworksByOvnName = (nads: readonly NetworkAttachmentDefinition[]): Map<string, PrimaryNetwork> => {
    const byName = new Map<string, PrimaryNetwork>();
    for (const nad of nads) {
        const id = nadNetworkId(nad);
        const name = nadOvnNetwork(nad);
        if (id === undefined || !name || parseNadConfig(nad.spec?.config)?.role !== 'primary') continue;
        if (!byName.has(name)) byName.set(name, { id, nad });
    }
    return byName;
};

interface Observation {
    address: string;
    family: 4 | 6;
    where: string;
    path: string;
}

/** Every gateway router masquerade address the router carries, and the families it has any address in. */
const observe = (
    router: LogicalRouterRow,
    database: LogicalDatabase,
    subnets: readonly MasqueradeSubnet[]
): { observed: Observation[]; families: Set<4 | 6> } => {
    const observed: Observation[] = [];
    const families = new Set<4 | 6>();
    const consider = (text: string, where: string, path: string): void => {
        const parsed = parsePrefix(text);
        if (!parsed) return;
        const classified = classifyMasqueradeAddress(text, subnets);
        if (classified?.role !== 'udn-gateway-router') return;
        observed.push({ address: formatAddress(parsed.family, parsed.address), family: parsed.family, where, path });
    };
    const ports = new Set(router.ports ?? []);
    for (const port of database.logicalRouterPorts ?? []) {
        if (!ports.has(port.uuid)) continue;
        for (const network of port.networks ?? []) {
            const parsed = parsePrefix(network);
            if (parsed) families.add(parsed.family);
            consider(network, `router port ${port.name}`, 'Logical_Router_Port.networks');
        }
    }
    for (const field of ['physical_ip', 'physical_ips']) {
        for (const text of (router.externalIds?.[field] ?? '').split(',')) {
            if (text.trim()) consider(text.trim(), `external_ids:${field}`, `Logical_Router.external_ids:${field}`);
        }
    }
    const nats = new Set(router.nat ?? []);
    for (const nat of database.nats ?? []) {
        if (!nats.has(nat.uuid) || !nat.externalIp) continue;
        consider(nat.externalIp, `a ${nat.type} rule`, 'NAT.external_ip');
    }
    return { observed, families };
};

/** The CUDN or UDN a primary network's ID names, else its NAD. */
const networkRefOf = ({ id, nad }: PrimaryNetwork, cluster: ClusterNetworkInputs): K8sRef => {
    const { network } = resolveMasqueradeNetwork(id, cluster);
    if (network?.kind === 'cudn') return cudnRef(network.name);
    if (network?.kind === 'udn') {
        return { group: 'k8s.ovn.org', version: 'v1', kind: 'UserDefinedNetwork', name: network.name, namespace: network.namespace || 'default' };
    }
    return nadRef(nad);
};

export const masqueradeAddressMismatch: PhysicalRule = {
    id: 'masquerade-address-mismatch',
    severity: 'info',
    scope: 'network',
    domain: 'physical',
    title: 'Gateway router masquerade address differs from the expected address',
    evaluate: ({ cluster }) => {
        const zones = cluster.zoneDatabases ?? [];
        if (zones.length === 0) return [];
        const primaries = primaryNetworksByOvnName(cluster.nads);
        if (primaries.size === 0) return [];
        const nodesByName = new Map<string, K8sResourceCommon>(
            (cluster.nodes ?? []).flatMap((node) => (node.metadata?.name ? [[node.metadata.name, node] as const] : [])));

        return zones.flatMap(({ node: zoneNode, database }) => (database.logicalRouters ?? []).flatMap((router) => {
            const classified = classifyRouter(router);
            if (classified.role !== 'gateway-router' || classified.network === DEFAULT_NETWORK) return [];
            const primary = primaries.get(classified.network);
            if (!primary) return [];
            const node = classified.node ?? zoneNode;
            const known = nodesByName.get(node);
            const subnets = masqueradeSubnets({ nodes: known ? [known] : [], databases: [database] });
            const expected = masqueradeIpsForNetworkId(primary.id, subnets);
            const { observed, families } = observe(router, database, subnets);

            const network = networkRefOf(primary, cluster);
            const networkLabel = `${network.namespace ? `${network.namespace}/` : ''}${network.name}`;
            return expected.flatMap((pair) => {
                if (!families.has(pair.family)) return [];
                const want = pair.gatewayRouter;
                const ofFamily = observed.filter((entry) => entry.family === pair.family);
                const others = [...new Set(ofFamily.filter((entry) => entry.address !== want).map((entry) => entry.address))].sort();
                if (ofFamily.length > 0 && others.length === 0) return [];

                const expectation: Evidence = {
                    fact: `Network ${networkLabel} has network ID ${primary.id}, so its gateway routers are expected to use ${want} from ${pair.subnet}.`,
                    sources: [nadRef(primary.nad)],
                    path: 'metadata.annotations["k8s.ovn.org/network-id"]',
                    inferred: FORMULA_INFERRED
                };
                const origin = `the northbound database of node ${zoneNode}`;
                const seen: Evidence[] = ofFamily.length === 0
                    ? [{ fact: `${router.name} carries no gateway router masquerade address in ${pair.subnet}.`, sources: [], origin }]
                    : ofFamily.filter((entry) => entry.address !== want)
                        // Two SNAT rules to one address are one fact.
                        .filter((entry, index, list) => list.findIndex((other) => other.address === entry.address && other.where === entry.where) === index)
                        .map((entry) => ({
                            fact: `${router.name} carries ${entry.address} on ${entry.where}.`,
                            sources: [],
                            path: entry.path,
                            origin
                        }));
                return [makeFinding({
                    ruleId: masqueradeAddressMismatch.id,
                    severity: masqueradeAddressMismatch.severity,
                    subject: constructSubject(zoneNode, 'router', router.name),
                    scope: { node: zoneNode, network },
                    summary: ofFamily.length === 0
                        ? `Gateway router ${router.name} on ${zoneNode} carries no masquerade address; the expected address is ${want}.`
                        : `Gateway router ${router.name} on ${zoneNode} carries ${others.join(', ')}, which differs from the expected address ${want}.`,
                    evidence: [...seen, expectation],
                    remedy: {
                        text: `OVN-Kubernetes owns the router. Compare the router's NAT rules and ports with network ${networkLabel}, `
                            + `and its ovnkube-node pod on ${zoneNode}.`,
                        target: network,
                        verb: 'view'
                    }
                }, String(pair.family))];
            });
        }));
    }
};
