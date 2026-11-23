import type { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import type { ClusterUserDefinedNetwork, NetworkAttachmentDefinition, UserDefinedNetwork } from '../types';
import { parsePrefix } from './ipPrefix';
import {
    globalMasqueradeAddresses,
    MASQUERADE_ROLE_LABELS,
    masqueradeIpsForNetworkId,
    masqueradeSubnets,
    NODE_MASQUERADE_SUBNET_ANNOTATION,
    nodeMasqueradeSubnets,
    primaryNetworkIds,
    resolveMasqueradeNetwork,
} from './masqueradeIps';
import type { NetworkAddress } from './networkPageModel';
import { NETWORK_ID_ANNOTATION } from './nodeVisualizationSelectors';

/**
 * The masquerade subnet on the Network config tab (ovn-recon-n7r.4): per address
 * family, the subnet in effect and where it was read, how many networks it has room
 * for against the network IDs in use, and which address is whose. Pure.
 *
 * Every offset comes from `masqueradeIps.ts` (ovn-recon-2n6.1); nothing here knows
 * where a role or a network's pair sits. Capacity is asked of that model too: the
 * highest network ID it still gives a pair.
 *
 * A network's pair sits at an offset set by its network ID, so what matters is the
 * highest ID in use, not how many networks there are. Only a primary network holds
 * its pair (a secondary one has no gateway router and no management port on the
 * host), but every network takes an ID from the same allocator.
 */

export type MasqueradeLayoutSource = 'spec' | 'node-annotation' | 'default';

export interface MasqueradeLayoutInputs {
    /**
     * The address families the cluster network has. Absent when the operator
     * configuration could not be read: then only what the Nodes report is drawn.
     */
    families?: { ipv4: boolean; ipv6: boolean };
    /** `gatewayConfig.ipv4/ipv6.internalMasqueradeSubnet`, normally empty. */
    configured?: { ipv4?: string; ipv6?: string };
    /** Nodes, read for their `k8s.ovn.org/node-masquerade-subnet` annotation. */
    nodes?: readonly K8sResourceCommon[];
    /** NetworkAttachmentDefinitions, read for their `k8s.ovn.org/network-id` and role. */
    nads?: readonly NetworkAttachmentDefinition[];
    cudns?: readonly ClusterUserDefinedNetwork[];
    udns?: readonly UserDefinedNetwork[];
}

export interface MasqueradeLayoutNote {
    id: string;
    severity: 'info' | 'warning';
    text: string;
}

export interface MasqueradeGlobalAddress {
    address: string;
    /** What the address is for: "OVN masquerade". */
    label: string;
}

/** A primary network and its pair in one subnet. */
export interface MasqueradeNetworkRow {
    networkId: number;
    /** "CUDN blue", "UDN tenant/red", or what is known when no one network claims the ID. */
    label: string;
    /** The network's page, when exactly one network (or a NAD) claims the ID. */
    target?: NetworkAddress;
    /** Absent when the subnet has no room for the ID. */
    gatewayRouter?: string;
    managementPort?: string;
}

export interface MasqueradeSubnetLayout {
    cidr: string;
    source: MasqueradeLayoutSource;
    /** "Node annotation", "Network operator configuration", "Platform default". */
    sourceText: string;
    /** The annotation key or the spec path the subnet was read from. */
    sourcePath: string;
    /** How many Nodes report this subnet; 0 unless it was read from them. */
    nodes: number;
    /** The highest network ID the subnet has a pair for; 0 when it has room for none. */
    capacity: number;
    /** The subnet has room for more IDs than can be counted here. */
    capacityUnbounded: boolean;
    /** "Room for network IDs 1 to 16378", "No room for any network". */
    capacityText: string;
    globals: MasqueradeGlobalAddress[];
    /** The first network pair, to show where the per-network part starts. */
    firstPair?: { gatewayRouter: string; managementPort: string };
    /** The primary networks that exist, by network ID. */
    networks: MasqueradeNetworkRow[];
    notes: MasqueradeLayoutNote[];
}

export interface MasqueradeFamilyLayout {
    family: 4 | 6;
    name: 'IPv4' | 'IPv6';
    /** One, unless the Nodes disagree. */
    subnets: MasqueradeSubnetLayout[];
    /** Nodes report more than one subnet for the family. */
    disagree: boolean;
    notes: MasqueradeLayoutNote[];
}

export interface MasqueradeLayout {
    /** Empty when no family is known. */
    families: MasqueradeFamilyLayout[];
    /** Distinct network IDs the NetworkAttachmentDefinitions carry (the default network's 0 aside). */
    networkIds: number[];
    /** Those of primary networks, which hold a masquerade pair. */
    primaryNetworkIds: number[];
    highestNetworkId?: number;
    /** "3 network IDs in use (highest 7), 2 by primary networks". */
    usageText: string;
    /** ClusterUserDefinedNetworks and UserDefinedNetworks that exist. */
    userDefinedNetworks: number;
    /** That the subnet cannot be changed once a user-defined network exists, and whether one does. */
    immutableText: string;
}

const OVN_GATEWAY = 'spec.defaultNetwork.ovnKubernetesConfig.gatewayConfig';
const FAMILY_KEYS = { 4: 'ipv4', 6: 'ipv6' } as const;

const SOURCE_TEXT: Record<MasqueradeLayoutSource, string> = {
    spec: 'Network operator configuration',
    'node-annotation': 'Node annotation',
    default: 'Platform default',
};

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

const sameSubnet = (a: string, b: string): boolean => {
    const left = parsePrefix(a);
    const right = parsePrefix(b);
    return Boolean(left && right && left.family === right.family && left.network === right.network && left.length === right.length);
};

/**
 * The highest network ID the masquerade model gives a pair in the subnet. The model
 * gives one to every ID up to a limit, so the limit is found by halving.
 */
export const masqueradeCapacity = (cidr: string): { capacity: number; unbounded: boolean } => {
    const fits = (id: number): boolean => masqueradeIpsForNetworkId(id, [cidr]).length > 0;
    if (!fits(1)) return { capacity: 0, unbounded: false };
    if (fits(Number.MAX_SAFE_INTEGER)) return { capacity: Number.MAX_SAFE_INTEGER, unbounded: true };
    let low = 1;
    let high = Number.MAX_SAFE_INTEGER;
    while (high - low > 1) {
        const middle = low + Math.floor((high - low) / 2);
        if (fits(middle)) low = middle;
        else high = middle;
    }
    return { capacity: low, unbounded: false };
};

/** Every network ID a NetworkAttachmentDefinition carries, the default network's 0 aside. */
const allNetworkIds = (nads: readonly NetworkAttachmentDefinition[]): number[] => {
    const ids = new Set<number>();
    for (const nad of nads) {
        const raw = nad.metadata?.annotations?.[NETWORK_ID_ANNOTATION];
        const id = raw === undefined || raw === '' ? NaN : Number(raw);
        if (Number.isSafeInteger(id) && id >= 1) ids.add(id);
    }
    return [...ids].sort((a, b) => a - b);
};

const nodesReporting = (nodes: readonly K8sResourceCommon[], cidr: string): number =>
    nodes.filter((node) => nodeMasqueradeSubnets(node).some((subnet) => sameSubnet(subnet, cidr))).length;

export const buildMasqueradeLayout = (inputs: MasqueradeLayoutInputs): MasqueradeLayout => {
    const { families, configured = {}, nodes = [], nads = [], cudns = [], udns = [] } = inputs;
    const networkIds = allNetworkIds(nads);
    const primaryIds = primaryNetworkIds(nads);
    const highestNetworkId = networkIds.length > 0 ? networkIds[networkIds.length - 1] : undefined;
    const highestPrimaryId = primaryIds.length > 0 ? primaryIds[primaryIds.length - 1] : undefined;
    const networks = primaryIds.map((id) => resolveMasqueradeNetwork(id, { cudns, udns, nads }));
    const userDefinedNetworks = cudns.length + udns.length;

    // What the Nodes report, else the default, per family; the spec stands in for the default.
    const effective = masqueradeSubnets({ nodes: [...nodes] });

    const subnetLayout = (cidr: string, source: MasqueradeLayoutSource, family: 4 | 6): MasqueradeSubnetLayout => {
        const { capacity, unbounded } = masqueradeCapacity(cidr);
        const globals = globalMasqueradeAddresses([cidr])
            .map(({ address, role }) => ({ address, label: MASQUERADE_ROLE_LABELS[role] }));
        const [firstPair] = masqueradeIpsForNetworkId(1, [cidr]);
        const notes: MasqueradeLayoutNote[] = [];
        if (capacity === 0) {
            notes.push({
                id: 'too-small',
                severity: primaryIds.length > 0 ? 'warning' : 'info',
                text: 'Too small for any network: it holds the global addresses only, so a primary user-defined network '
                    + `cannot work on it${primaryIds.length > 0 ? `, and ${plural(primaryIds.length, 'primary network exists', 'primary networks exist')}` : ''}.`,
            });
        } else if (highestPrimaryId !== undefined && highestPrimaryId > capacity) {
            const without = primaryIds.filter((id) => id > capacity);
            notes.push({
                id: 'over-capacity',
                severity: 'warning',
                text: `No room for network ${without.length === 1 ? 'ID' : 'IDs'} ${without.join(', ')}: `
                    + `the subnet has pairs for IDs up to ${capacity}.`,
            });
        }
        return {
            cidr,
            source,
            sourceText: SOURCE_TEXT[source],
            sourcePath: source === 'spec'
                ? `${OVN_GATEWAY}.${FAMILY_KEYS[family]}.internalMasqueradeSubnet`
                : source === 'node-annotation' ? NODE_MASQUERADE_SUBNET_ANNOTATION : '',
            nodes: source === 'node-annotation' ? nodesReporting(nodes, cidr) : 0,
            capacity,
            capacityUnbounded: unbounded,
            capacityText: capacity === 0
                ? 'No room for any network'
                : unbounded ? 'Room for more networks than a cluster can hold'
                    : capacity === 1 ? 'Room for network ID 1 only' : `Room for network IDs 1 to ${capacity}`,
            globals,
            ...(firstPair ? { firstPair: { gatewayRouter: firstPair.gatewayRouter, managementPort: firstPair.managementPort } } : {}),
            networks: networks.map((network): MasqueradeNetworkRow => {
                const [pair] = masqueradeIpsForNetworkId(network.networkId, [cidr]);
                const ref = network.network;
                const target: NetworkAddress | undefined = ref
                    ? { kind: ref.kind, name: ref.name, ...(ref.kind === 'udn' ? { namespace: ref.namespace } : {}) }
                    : network.nad && !network.ambiguous ? { kind: 'nad', ...network.nad } : undefined;
                const label = ref
                    ? (ref.kind === 'cudn' ? `CUDN ${ref.name}` : `UDN ${ref.namespace}/${ref.name}`)
                    : network.ambiguous ? `Claimed by ${network.ambiguous.join(', ')}`
                        : network.nad ? `NAD ${network.nad.namespace}/${network.nad.name}` : 'Unknown network';
                return {
                    networkId: network.networkId,
                    label,
                    ...(target ? { target } : {}),
                    ...(pair ? { gatewayRouter: pair.gatewayRouter, managementPort: pair.managementPort } : {}),
                };
            }),
            notes,
        };
    };

    const familyLayouts = ([4, 6] as const).flatMap((family): MasqueradeFamilyLayout[] => {
        const key = FAMILY_KEYS[family];
        const set = configured[key];
        const setValid = set !== undefined && parsePrefix(set)?.family === family ? set : undefined;
        const reported = effective.filter((subnet) => subnet.family === family && subnet.source === 'node-annotation');
        if (!families?.[key] && !setValid && reported.length === 0) return [];
        const fallback = effective.find((subnet) => subnet.family === family);
        const subnets = reported.length > 0
            ? reported.map((subnet) => subnetLayout(subnet.cidr, 'node-annotation', family))
            : setValid ? [subnetLayout(setValid, 'spec', family)]
                : fallback ? [subnetLayout(fallback.cidr, 'default', family)] : [];
        if (subnets.length === 0) return [];
        const notes: MasqueradeLayoutNote[] = [];
        if (reported.length > 1) {
            notes.push({
                id: 'nodes-disagree',
                severity: 'warning',
                text: `Nodes disagree: ${subnets.map((subnet) => `${subnet.cidr} on ${plural(subnet.nodes, 'node')}`).join(', ')}.`,
            });
        }
        if (setValid && reported.length > 0 && !reported.some((subnet) => sameSubnet(subnet.cidr, setValid))) {
            notes.push({
                id: 'differs-from-spec',
                severity: 'warning',
                text: `The operator configuration names ${setValid}, which no node reports.`,
            });
        } else if (setValid && reported.length > 0) {
            notes.push({ id: 'matches-spec', severity: 'info', text: `Set in the operator configuration (${setValid}).` });
        } else if (reported.length > 0) {
            notes.push({ id: 'not-in-spec', severity: 'info', text: 'Not set in the operator configuration, as is usual.' });
        } else if (!setValid) {
            notes.push({
                id: 'no-node-report',
                severity: 'info',
                text: 'No node reports its subnet, so this is the default for a new cluster; '
                    + 'an upgraded cluster keeps the subnet it was installed with.',
            });
        }
        return [{ family, name: family === 4 ? 'IPv4' : 'IPv6', subnets, disagree: reported.length > 1, notes }];
    });

    const usageText = networkIds.length === 0
        ? 'No network ID is in use, going by the NetworkAttachmentDefinitions you can read'
        : `${plural(networkIds.length, 'network ID')} in use (highest ${highestNetworkId}), `
            + `${primaryIds.length} by primary networks, which hold a pair each`;

    return {
        families: familyLayouts,
        networkIds,
        primaryNetworkIds: primaryIds,
        ...(highestNetworkId !== undefined ? { highestNetworkId } : {}),
        usageText,
        userDefinedNetworks,
        immutableText: userDefinedNetworks > 0
            ? `The masquerade subnet cannot be changed once a user-defined network exists, and ${plural(userDefinedNetworks, 'exists', 'exist')}.`
            : 'The masquerade subnet cannot be changed once a user-defined network exists; none exists yet.',
    };
};
