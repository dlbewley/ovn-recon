import { parsePrefix } from './ipPrefix';
import {
    classifyMasqueradeAddress,
    isUdnMasqueradeRole,
    MASQUERADE_ROLE_LABELS,
    MasqueradeClassification,
    MasqueradeRole,
    MasqueradeSubnet,
} from './masqueradeIps';
import type { NnsRoute, VrfMasqueradeRoute } from './nodeVisualizationSelectors';

/**
 * Masquerade addresses as a node's physical view meets them (ovn-recon-2n6.4):
 * on br-ex, and in the main and VRF routing tables. Pure; the model itself is
 * masqueradeIps.ts, and the address book names the owners under a route's
 * addresses. This file holds what the drawer's facts and the VRF association
 * need beyond that.
 */

/** One sentence on what the masquerade subnet is, for help text. */
export const MASQUERADE_SUBNET_HELP =
    'The masquerade subnet (169.254.0.0/17 and fd69::/112 by default) is a link-local range OVN-Kubernetes '
    + 'reserves on every node, so host, service and per-network traffic can be told apart and SNATed '
    + 'before it leaves through br-ex with the node IP.';

/** What each role is for, as the physical view says it beside the address. */
const ROLE_PURPOSES: Readonly<Record<MasqueradeRole, string>> = {
    ovn: 'source OVN uses for service traffic it sends to the host',
    host: 'source for host-to-service traffic',
    'host-etp-local': 'source for host traffic to externalTrafficPolicy=Local services',
    'dummy-next-hop': 'next hop for routes to services and the masquerade subnet; no host holds it',
    'service-hairpin': 'source for a pod reaching itself through a service',
    reserved: 'held back by OVN-Kubernetes for future use',
    'udn-gateway-router': 'what the network\'s gateway router SNATs its pods to, before br-ex SNATs that to the node IP',
    'udn-management-port': 'host side of the network\'s management port',
};

/** The role of a classified address in a few words, and what it is for. */
export const masqueradeRoleText = (classification: MasqueradeClassification): string => {
    const label = MASQUERADE_ROLE_LABELS[classification.role];
    const purpose = ROLE_PURPOSES[classification.role];
    const id = isUdnMasqueradeRole(classification.role) && classification.networkId !== undefined
        ? ` of network ID ${classification.networkId}`
        : '';
    return `${label}${id}: ${purpose}`;
};

/**
 * What an address in the masquerade subnet is, as one line; undefined for an
 * address outside it.
 */
export const describeMasqueradeAddress = (
    address: string,
    subnets: readonly MasqueradeSubnet[],
): string | undefined => {
    const classification = classifyMasqueradeAddress(address, subnets);
    return classification && masqueradeRoleText(classification);
};

/** A /32 or /128, or an address with no length: a route to one host. */
const isHostPrefix = (destination: string): boolean => {
    const parsed = parsePrefix(destination);
    return Boolean(parsed) && parsed?.length === (parsed?.family === 4 ? 32 : 128);
};

/**
 * The routes in a VRF's table to a network's management-port masquerade
 * address: `169.254.0.16/32 dev ovn-k8s-mp3`. OVN-Kubernetes installs one in
 * each primary network's VRF, so the route names a network ID; the VRF
 * association reads it as corroboration only (findPrimaryNetworkForVrf).
 */
export const vrfManagementPortRoutes = (
    routes: readonly NnsRoute[],
    subnets: readonly MasqueradeSubnet[],
): VrfMasqueradeRoute[] => {
    const seen = new Set<string>();
    const out: VrfMasqueradeRoute[] = [];
    for (const route of routes) {
        if (!route.destination || !isHostPrefix(route.destination)) continue;
        const classification = classifyMasqueradeAddress(route.destination, subnets);
        if (classification?.role !== 'udn-management-port' || classification.networkId === undefined) continue;
        const key = `${route.destination}|${route.nextHopInterface ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            destination: route.destination,
            networkId: classification.networkId,
            ...(route.nextHopInterface ? { interface: route.nextHopInterface } : {}),
        });
    }
    return out;
};
