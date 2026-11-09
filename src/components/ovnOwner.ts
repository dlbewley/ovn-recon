import { LogicalDatabase } from '../types';
import { getProjectPath, getResourcePath } from '../topology/links';
import { DEFAULT_NETWORK } from './logicalClassification';

/**
 * Who wrote an OVN northbound row, read from the external_ids ovn-kubernetes
 * stamps on everything it owns (ovn-recon-e2b.5):
 *
 *   k8s.ovn.org/owner-controller  the controller, one per network
 *   k8s.ovn.org/owner-type        what kind of object the row implements
 *   k8s.ovn.org/name              that object's name, in a per-type format
 *   k8s.ovn.org/id                the full key, unique per row
 *
 * The helpers are generic over the owner type: a type this module has never
 * seen still reads, labels and sorts; only the link to a Kubernetes object is
 * limited to the types whose name format has been verified.
 *
 * Pure functions over plain data, so the physical view can reuse them.
 */

export const OWNER_CONTROLLER_KEY = 'k8s.ovn.org/owner-controller';
export const OWNER_TYPE_KEY = 'k8s.ovn.org/owner-type';
export const OWNER_NAME_KEY = 'k8s.ovn.org/name';
export const OWNER_ID_KEY = 'k8s.ovn.org/id';

const OWNER_KEYS = new Set([OWNER_CONTROLLER_KEY, OWNER_TYPE_KEY, OWNER_NAME_KEY, OWNER_ID_KEY]);
const NETWORK_CONTROLLER_SUFFIX = '-network-controller';
const NETWORK_KEY = 'k8s.ovn.org/network';
const ROLE_KEY = 'k8s.ovn.org/role';

export interface OvnOwner {
    /** `k8s.ovn.org/owner-controller`, e.g. `default-network-controller`. */
    controller?: string;
    /** `k8s.ovn.org/owner-type`, e.g. `NetworkPolicy`, `Namespace`, `Cluster`. */
    type?: string;
    /** `k8s.ovn.org/name`; absent on some types (MulticastCluster). */
    name?: string;
    /** `k8s.ovn.org/id`. */
    id?: string;
    /** Every other external_id, as written: the per-type keys such as
     * `direction`, `type`, `gress-index`, `ip`, `network`. */
    extra: Record<string, string>;
}

/**
 * The owner named in a row's external_ids. Undefined when none of the four
 * ownership keys is present: a row ovn-kubernetes did not write, or a table
 * that does not carry them.
 */
export const ownerOf = (externalIds: Record<string, string> | undefined): OvnOwner | undefined => {
    if (!externalIds) return undefined;
    const controller = externalIds[OWNER_CONTROLLER_KEY];
    const type = externalIds[OWNER_TYPE_KEY];
    const name = externalIds[OWNER_NAME_KEY];
    const id = externalIds[OWNER_ID_KEY];
    if (controller === undefined && type === undefined && name === undefined && id === undefined) {
        return undefined;
    }
    const extra: Record<string, string> = {};
    for (const [key, value] of Object.entries(externalIds)) {
        if (!OWNER_KEYS.has(key)) extra[key] = value;
    }
    return { controller, type, name, id, extra };
};

/**
 * The network a controller serves, as the identity classification uses
 * (`k8s.ovn.org/network`): `default` for `default-network-controller`,
 * `cluster_udn_<name>` for a ClusterUserDefinedNetwork, `<namespace>_<name>`
 * for a UserDefinedNetwork, the bare network name for a network defined by a
 * NetworkAttachmentDefinition alone. Undefined for a controller that is not a
 * network controller (`udn-enabled-svc`).
 */
export const networkOfController = (controller: string | undefined): string | undefined => {
    if (!controller || !controller.endsWith(NETWORK_CONTROLLER_SUFFIX)) return undefined;
    const network = controller.slice(0, -NETWORK_CONTROLLER_SUFFIX.length);
    return network === '' ? undefined : network;
};

/**
 * A controller as text: `default`, `CUDN <name>`, `UDN <namespace>/<name>`,
 * the network name for any other network controller, and the controller name
 * verbatim for anything that is not one.
 */
export const controllerLabel = (controller: string | undefined): string => {
    const network = networkOfController(controller);
    if (network === undefined) return controller ?? '';
    if (network === DEFAULT_NETWORK) return DEFAULT_NETWORK;
    if (network.startsWith('cluster_udn_')) return `CUDN ${network.slice('cluster_udn_'.length)}`;
    const separator = network.indexOf('_');
    if (separator > 0) return `UDN ${network.slice(0, separator)}/${network.slice(separator + 1)}`;
    return network;
};

export type NetworkRole = 'primary' | 'secondary';

/** The role of a network by identity; undefined when it cannot be told. */
export type NetworkRoleResolver = (network: string) => NetworkRole | undefined;

const roleCache = new WeakMap<LogicalDatabase, Map<string, NetworkRole>>();

/**
 * Network roles as one zone's database announces them: every switch and
 * gateway router of a user-defined network carries `k8s.ovn.org/role`. A
 * network with no switch or router in the zone is absent from the map.
 */
export const networkRolesOf = (database: LogicalDatabase | null | undefined): Map<string, NetworkRole> => {
    if (!database) return new Map();
    const cached = roleCache.get(database);
    if (cached) return cached;
    const roles = new Map<string, NetworkRole>();
    for (const row of [...database.logicalSwitches, ...database.logicalRouters]) {
        const network = row.externalIds?.[NETWORK_KEY];
        const role = row.externalIds?.[ROLE_KEY];
        if (network && (role === 'primary' || role === 'secondary') && !roles.has(network)) {
            roles.set(network, role);
        }
    }
    roleCache.set(database, roles);
    return roles;
};

/**
 * A resolver over one zone's database. The default network is primary by
 * definition. A caller that knows roles from the Kubernetes side (the
 * UDN/CUDN spec) can pass its own resolver instead.
 */
export const networkRoleResolverFor = (database: LogicalDatabase | null | undefined): NetworkRoleResolver => {
    const roles = networkRolesOf(database);
    return (network) => (network === DEFAULT_NETWORK ? 'primary' : roles.get(network));
};

const NETWORK_POLICY = { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy' } as const;
const MULTI_NETWORK_POLICY = { apiVersion: 'k8s.cni.cncf.io/v1beta1', kind: 'MultiNetworkPolicy' } as const;

/** The Kubernetes object behind an owner, with its console path. */
export interface OwnerTarget {
    apiVersion: string;
    kind: string;
    namespace?: string;
    name: string;
    path: string;
}

/** `namespace:policy`, the name format of NetworkPolicy-typed owners. */
const splitPolicyName = (name: string | undefined): { namespace: string; policy: string } | undefined => {
    if (!name) return undefined;
    const colon = name.indexOf(':');
    if (colon <= 0 || colon === name.length - 1) return undefined;
    return { namespace: name.slice(0, colon), policy: name.slice(colon + 1) };
};

/**
 * Which Kubernetes kind a `NetworkPolicy`-typed owner is. The owner type
 * cannot say: ovn-kubernetes writes a MultiNetworkPolicy with owner-type
 * `NetworkPolicy` too, and the only difference is the controller, which is
 * the secondary network's. So the kind follows the role of the controller's
 * network: the default network and primary networks implement NetworkPolicy,
 * secondary networks implement MultiNetworkPolicy. Undefined when the role
 * is unknown, rather than a guess.
 */
const policyKindOf = (
    owner: OvnOwner,
    roleOf: NetworkRoleResolver | undefined,
): typeof NETWORK_POLICY | typeof MULTI_NETWORK_POLICY | undefined => {
    const network = networkOfController(owner.controller);
    if (network === undefined) return undefined;
    if (network === DEFAULT_NETWORK) return NETWORK_POLICY;
    const role = roleOf?.(network);
    if (role === 'primary') return NETWORK_POLICY;
    if (role === 'secondary') return MULTI_NETWORK_POLICY;
    return undefined;
};

/**
 * The Kubernetes object an owner stands for, for the types whose name format
 * is known: `NetworkPolicy` (name `namespace:policy`, kind by network role,
 * see policyKindOf) and `Namespace` / `NetpolNamespace` (name = the
 * namespace). Every other type has no target and renders as text.
 */
export const ownerTarget = (owner: OvnOwner | undefined, roleOf?: NetworkRoleResolver): OwnerTarget | undefined => {
    if (!owner) return undefined;
    if (owner.type === 'NetworkPolicy') {
        const parsed = splitPolicyName(owner.name);
        const kind = policyKindOf(owner, roleOf);
        if (!parsed || !kind) return undefined;
        const ref = { ...kind, namespace: parsed.namespace, name: parsed.policy };
        return { ...ref, path: getResourcePath(ref) };
    }
    if ((owner.type === 'Namespace' || owner.type === 'NetpolNamespace') && owner.name) {
        return { apiVersion: 'v1', kind: 'Namespace', name: owner.name, path: getProjectPath(owner.name) };
    }
    return undefined;
};

/** The console path of the owner's Kubernetes object, when it has one. */
export const ownerLink = (owner: OvnOwner | undefined, roleOf?: NetworkRoleResolver): string | undefined =>
    ownerTarget(owner, roleOf)?.path;

export interface OwnerDescription {
    /**
     * What to call the owner: the Kubernetes kind for a policy whose kind is
     * resolved, else the owner type as written (`Unowned` without one).
     */
    kind: string;
    /** `namespace/policy` for policies, else `k8s.ovn.org/name` as written;
     * absent when the owner has no name. */
    name?: string;
    target?: OwnerTarget;
    /**
     * A `NetworkPolicy`-typed owner on a network whose role is unknown here:
     * it is a NetworkPolicy or a MultiNetworkPolicy, and is not linked.
     */
    kindUnresolved?: boolean;
}

/** An owner for display: kind, readable name and the link target if any. */
export const describeOwner = (owner: OvnOwner | undefined, roleOf?: NetworkRoleResolver): OwnerDescription => {
    if (!owner) return { kind: 'Unowned' };
    const target = ownerTarget(owner, roleOf);
    if (owner.type === 'NetworkPolicy') {
        const parsed = splitPolicyName(owner.name);
        const name = parsed ? `${parsed.namespace}/${parsed.policy}` : owner.name;
        if (target) return { kind: target.kind, name, target };
        return { kind: 'NetworkPolicy', name, kindUnresolved: parsed !== undefined };
    }
    return { kind: owner.type ?? 'Unowned', name: owner.name, target };
};

/** `<kind> <name>`, or `<kind>` alone when the owner has no name. */
export const ownerText = (description: OwnerDescription): string =>
    description.name ? `${description.kind} ${description.name}` : description.kind;
