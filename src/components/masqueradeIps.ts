import type { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import type {
    ClusterUserDefinedNetwork,
    LogicalDatabase,
    NetworkAttachmentDefinition,
    UserDefinedNetwork,
} from '../types';
import { formatAddress, ParsedPrefix, parsePrefix } from './ipPrefix';
import {
    CUDN_NETWORK_PREFIX,
    EvpnNetworkRef,
    findNetworkByNetworkId,
    NETWORK_ID_ANNOTATION,
    parseNadConfig,
} from './nodeVisualizationSelectors';

/**
 * Masquerade IPs (ovn-recon-2n6.1): what an address inside the node masquerade
 * subnet is for. Pure.
 *
 * OVN-Kubernetes reserves a link-local subnet on every node (169.254.0.0/17 and
 * fd69::/112 by default since OpenShift 4.17) and hands out its addresses by
 * offset from the subnet's base:
 *
 *   1      OVN masquerade
 *   2      host masquerade (on br-ex)
 *   3      host masquerade for externalTrafficPolicy=Local
 *   4      dummy next hop
 *   5      OVN service hairpin masquerade
 *   6-10   reserved
 *   11...  a pair per user-defined network, from its network ID (the NAD
 *          annotation k8s.ovn.org/network-id): the gateway router at
 *          10 + 2*ID - 1 and the management port at 10 + 2*ID
 *
 * A primary UDN's gateway router SNATs pod traffic to its pair's first address
 * before br-ex SNATs that to the node IP, so the address names the network.
 *
 * The offsets are an upstream implementation detail
 * (go-controller/pkg/generator/udn/masquerade_ips.go), not a documented
 * OpenShift contract. What OVN carries (a router port's networks, a gateway
 * router's physical_ips, a NAT external IP) is the evidence; this model labels
 * it and cross-checks it, and never stands as the only signal where the
 * evidence is held.
 */

/** ovn-kubernetes' default node masquerade subnets. */
export const DEFAULT_MASQUERADE_SUBNETS: readonly string[] = ['169.254.0.0/17', 'fd69::/112'];

/**
 * Node annotation with the node's effective masquerade subnets,
 * `{"ipv4":"169.254.0.0/17","ipv6":"fd69::/112"}`. The same key marks a gateway
 * router's static route to the subnet in `external_ids`.
 */
export const NODE_MASQUERADE_SUBNET_ANNOTATION = 'k8s.ovn.org/node-masquerade-subnet';

/** Where a masquerade subnet was read. */
export type MasqueradeSubnetSource = 'node-annotation' | 'static-route' | 'default';

export interface MasqueradeSubnet {
    /** The subnet as CIDR text: `169.254.0.0/17`. */
    cidr: string;
    family: 4 | 6;
    prefix: ParsedPrefix;
    source: MasqueradeSubnetSource;
}

export type MasqueradeRole =
    | 'ovn'
    | 'host'
    | 'host-etp-local'
    | 'dummy-next-hop'
    | 'service-hairpin'
    | 'reserved'
    | 'udn-gateway-router'
    | 'udn-management-port';

/** What each role is, in a few words. */
export const MASQUERADE_ROLE_LABELS: Readonly<Record<MasqueradeRole, string>> = {
    ovn: 'OVN masquerade',
    host: 'Host masquerade',
    'host-etp-local': 'Host masquerade for externalTrafficPolicy=Local',
    'dummy-next-hop': 'Dummy next hop',
    'service-hairpin': 'OVN service hairpin masquerade',
    reserved: 'Reserved masquerade address',
    'udn-gateway-router': 'Gateway router masquerade',
    'udn-management-port': 'Management port masquerade',
};

/** The roles of the per-network pair, which carry a network ID. */
export const isUdnMasqueradeRole = (role: MasqueradeRole): role is 'udn-gateway-router' | 'udn-management-port' =>
    role === 'udn-gateway-router' || role === 'udn-management-port';

/** The global roles by offset; offsets 6 to 10 are reserved. */
const GLOBAL_ROLES: readonly MasqueradeRole[] = ['ovn', 'host', 'host-etp-local', 'dummy-next-hop', 'service-hairpin'];
const LAST_RESERVED_OFFSET = 10n;

// ------------------------------------------------------------------ subnets

type SubnetInput = string | MasqueradeSubnet;

const toSubnet = (input: SubnetInput, source: MasqueradeSubnetSource = 'default'): MasqueradeSubnet | undefined => {
    if (typeof input !== 'string') return input;
    const prefix = parsePrefix(input);
    if (!prefix) return undefined;
    return { cidr: input.trim(), family: prefix.family, prefix, source };
};

const toSubnets = (inputs: readonly SubnetInput[]): MasqueradeSubnet[] =>
    inputs.map((input) => toSubnet(input)).filter((subnet): subnet is MasqueradeSubnet => subnet !== undefined);

/** The subnets a Node's annotation names; empty when it carries none or cannot be read. */
export const nodeMasqueradeSubnets = (node: K8sResourceCommon | null | undefined): string[] => {
    const raw = node?.metadata?.annotations?.[NODE_MASQUERADE_SUBNET_ANNOTATION];
    if (!raw) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!parsed || typeof parsed !== 'object') return [];
    return ['ipv4', 'ipv6']
        .map((key) => (parsed as Record<string, unknown>)[key])
        .filter((value): value is string => typeof value === 'string' && parsePrefix(value) !== null);
};

/** The subnets a zone's gateway routers route to, by the static routes marked with the annotation key. */
export const masqueradeRouteSubnets = (database: LogicalDatabase | null | undefined): string[] =>
    (database?.staticRoutes ?? [])
        .filter((route) => route.externalIds?.[NODE_MASQUERADE_SUBNET_ANNOTATION] !== undefined)
        .map((route) => route.ipPrefix)
        .filter((prefix) => parsePrefix(prefix) !== null);

export interface MasqueradeSubnetInputs {
    /** Nodes, read for their masquerade subnet annotation. */
    nodes?: ReadonlyArray<K8sResourceCommon | null | undefined>;
    /** Zone databases, read for the gateway routers' static route to the subnet. */
    databases?: ReadonlyArray<LogicalDatabase | null | undefined>;
}

/**
 * The effective masquerade subnets, per address family: what the Nodes'
 * annotation says when a Node carries one, else what a zone's gateway router
 * routes to, else the default. Nodes that disagree each keep theirs: an address
 * is in the subnet if any of them holds it.
 */
export const masqueradeSubnets = ({ nodes = [], databases = [] }: MasqueradeSubnetInputs = {}): MasqueradeSubnet[] => {
    const read = (texts: string[], source: MasqueradeSubnetSource): MasqueradeSubnet[] => {
        const byCidr = new Map<string, MasqueradeSubnet>();
        for (const text of texts) {
            const subnet = toSubnet(text, source);
            if (subnet) byCidr.set(`${subnet.prefix.family}|${subnet.prefix.network}|${subnet.prefix.length}`, subnet);
        }
        return [...byCidr.values()];
    };
    const annotated = read(nodes.flatMap(nodeMasqueradeSubnets), 'node-annotation');
    const routed = read(databases.flatMap(masqueradeRouteSubnets), 'static-route');
    const defaults = read([...DEFAULT_MASQUERADE_SUBNETS], 'default');
    return ([4, 6] as const).flatMap((family) => {
        for (const candidates of [annotated, routed, defaults]) {
            const ofFamily = candidates.filter((subnet) => subnet.family === family);
            if (ofFamily.length > 0) return ofFamily;
        }
        return [];
    });
};

// ------------------------------------------------------------------ offsets

const widthOf = (family: 4 | 6): number => (family === 4 ? 32 : 128);

/** The highest offset an address may take: IPv4 keeps its broadcast address back. */
const lastUsableOffset = (subnet: MasqueradeSubnet): bigint => {
    const size = 1n << BigInt(widthOf(subnet.family) - subnet.prefix.length);
    return size - (subnet.family === 4 ? 2n : 1n);
};

const addressAt = (subnet: MasqueradeSubnet, offset: bigint): string =>
    formatAddress(subnet.family, subnet.prefix.network + offset);

export interface MasqueradeClassification {
    role: MasqueradeRole;
    /** The network ID, for a role of the per-network pair. */
    networkId?: number;
    /** The address's offset from the subnet's base. */
    offset: number;
    /** The subnet the address was found in, as CIDR text. */
    subnet: string;
    family: 4 | 6;
}

/**
 * What an address inside a masquerade subnet is for, by its offset from the
 * subnet's base; undefined outside every subnet, for the subnet's own base, and
 * for IPv4's broadcast address. A mask beside the address is ignored:
 * `169.254.0.15/17` is the address .15.
 */
export const classifyMasqueradeAddress = (
    address: string,
    subnets: readonly SubnetInput[] = DEFAULT_MASQUERADE_SUBNETS,
): MasqueradeClassification | undefined => {
    const parsed = parsePrefix(address);
    if (!parsed) return undefined;
    for (const subnet of toSubnets(subnets)) {
        if (subnet.family !== parsed.family) continue;
        const hostBits = BigInt(widthOf(subnet.family) - subnet.prefix.length);
        if (parsed.address >> hostBits !== subnet.prefix.network >> hostBits) continue;
        const offset = parsed.address - subnet.prefix.network;
        if (offset < 1n || offset > lastUsableOffset(subnet) || offset > BigInt(Number.MAX_SAFE_INTEGER)) continue;
        const shared = { offset: Number(offset), subnet: subnet.cidr, family: subnet.family };
        if (offset <= BigInt(GLOBAL_ROLES.length)) return { ...shared, role: GLOBAL_ROLES[Number(offset) - 1] };
        if (offset <= LAST_RESERVED_OFFSET) return { ...shared, role: 'reserved' };
        // Gateway router at 10 + 2*ID - 1 (odd), management port at 10 + 2*ID (even).
        const gatewayRouter = offset % 2n === 1n;
        const networkId = Number(gatewayRouter ? (offset - 9n) / 2n : (offset - 10n) / 2n);
        // A gateway router address whose management port would fall outside the subnet is no pair.
        if (masqueradeIpsForNetworkId(networkId, [subnet]).length === 0) continue;
        return { ...shared, role: gatewayRouter ? 'udn-gateway-router' : 'udn-management-port', networkId };
    }
    return undefined;
};

export interface MasqueradeIpPair {
    networkId: number;
    family: 4 | 6;
    /** The subnet the pair comes from, as CIDR text. */
    subnet: string;
    /** What the network's gateway routers SNAT its pods to: base + 10 + 2*ID - 1. */
    gatewayRouter: string;
    /** The host side of the network's management port: base + 10 + 2*ID. */
    managementPort: string;
}

/**
 * A network's masquerade pair in each subnet that has room for it. Empty for
 * an ID below 1 or not an integer, and in a subnet too small for it: the legacy
 * /29 and /125 hold the global roles only.
 */
export const masqueradeIpsForNetworkId = (
    networkId: number,
    subnets: readonly SubnetInput[] = DEFAULT_MASQUERADE_SUBNETS,
): MasqueradeIpPair[] => {
    if (!Number.isSafeInteger(networkId) || networkId < 1) return [];
    const id = BigInt(networkId);
    const gatewayOffset = LAST_RESERVED_OFFSET + 2n * id - 1n;
    const managementOffset = LAST_RESERVED_OFFSET + 2n * id;
    return toSubnets(subnets)
        .filter((subnet) => managementOffset <= lastUsableOffset(subnet))
        .map((subnet) => ({
            networkId,
            family: subnet.family,
            subnet: subnet.cidr,
            gatewayRouter: addressAt(subnet, gatewayOffset),
            managementPort: addressAt(subnet, managementOffset),
        }));
};

/** The global role addresses (offsets 1 to 5) of each subnet. */
export const globalMasqueradeAddresses = (
    subnets: readonly SubnetInput[] = DEFAULT_MASQUERADE_SUBNETS,
): Array<{ address: string; role: MasqueradeRole; subnet: string }> =>
    toSubnets(subnets).flatMap((subnet) =>
        GLOBAL_ROLES
            .map((role, index) => ({ role, offset: BigInt(index + 1) }))
            .filter(({ offset }) => offset <= lastUsableOffset(subnet))
            .map(({ role, offset }) => ({ address: addressAt(subnet, offset), role, subnet: subnet.cidr })));

// ------------------------------------------------------------------ networks

export interface MasqueradeNetworkInputs {
    cudns?: readonly ClusterUserDefinedNetwork[];
    udns?: readonly UserDefinedNetwork[];
    nads?: readonly NetworkAttachmentDefinition[];
}

export interface MasqueradeNetwork {
    networkId: number;
    /** The one network claiming the ID. Absent when none does, or more than one. */
    network?: EvpnNetworkRef;
    /** Its `k8s.ovn.org/network` identity: `cluster_udn_<name>` or `<namespace>_<name>`. */
    ovnNetwork?: string;
    /** A NetworkAttachmentDefinition carrying the ID. */
    nad?: { namespace: string; name: string };
    /** Networks claiming the same ID, when more than one does. Matched to none of them. */
    ambiguous?: string[];
}

/** The `k8s.ovn.org/network` identity OVN-Kubernetes gives a CUDN or UDN. */
export const ovnNetworkNameOf = (ref: EvpnNetworkRef): string =>
    (ref.kind === 'cudn' ? `${CUDN_NETWORK_PREFIX}${ref.name}` : `${ref.namespace}_${ref.name}`);

/**
 * The network a masquerade network ID belongs to, through the NADs'
 * `k8s.ovn.org/network-id` annotation. An ID two networks claim stays
 * ambiguous, as it does for a VRF's name.
 */
export const resolveMasqueradeNetwork = (
    networkId: number,
    { cudns = [], udns = [], nads = [] }: MasqueradeNetworkInputs,
): MasqueradeNetwork => {
    const match = findNetworkByNetworkId(String(networkId), [...cudns], [...udns], [...nads]);
    if (match.ambiguous) return { networkId, ambiguous: match.ambiguous };
    const nad = match.nad?.metadata?.name
        ? { namespace: match.nad.metadata.namespace || 'default', name: match.nad.metadata.name }
        : undefined;
    return {
        networkId,
        ...(match.network ? { network: match.network, ovnNetwork: ovnNetworkNameOf(match.network) } : {}),
        ...(nad ? { nad } : {}),
    };
};

/**
 * The network IDs that hold a masquerade pair: those of NADs whose config gives
 * the network the primary role. A secondary network has no gateway router and
 * no management port on the host, so its ID's pair is not in use.
 */
export const primaryNetworkIds = (nads: readonly NetworkAttachmentDefinition[] = []): number[] => {
    const ids = new Set<number>();
    for (const nad of nads) {
        const id = Number(nad.metadata?.annotations?.[NETWORK_ID_ANNOTATION]);
        if (!Number.isSafeInteger(id) || id < 1) continue;
        if (parseNadConfig(nad.spec?.config)?.role !== 'primary') continue;
        ids.add(id);
    }
    return [...ids].sort((a, b) => a - b);
};
