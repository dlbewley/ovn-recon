import type { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import type { LinkTarget } from '../linkOut/registry';
import { resourceTarget } from '../linkOut/registry';
import { clusterLogicalPath, constructDetailPath, nodeLogicalPath, nodePhysicalPath } from '../routes';
import { resolveInterfaceLinkRef } from '../topology/ids';
import type { ResourceRef } from '../topology/types';
import type { LogicalDatabase, LogicalSwitchPortRow, NodeNetworkState } from '../types';
import { interfaceAddresses, nodeAddressesOf, normalizeMac } from './clusterSearchModel';
import { parsePrefix } from './ipPrefix';
import { ClassifiedConstruct, classifyRouter, classifySwitch, classifySwitchPort, DEFAULT_NETWORK } from './logicalClassification';
import { hostKey, portEntryAddresses } from './routerRules';
import { inferVipClass, NETWORK_EXTERNAL_ID, parseVip, scopeOf, serviceIndexFor, serviceLabel, vipClassContext } from './serviceIndex';

/**
 * The address book (ovn-recon-dp7.4): every address the plugin already holds,
 * indexed, to answer "whose is this?". Pure.
 *
 * Sources, each contributing only when the caller holds it:
 *
 *   zone databases     Logical_Switch_Port addresses and dynamic_addresses,
 *                      Logical_Router_Port networks and MACs, NAT external IPs,
 *                      and, with the services section, load balancer VIPs
 *   NodeNetworkState   interface addresses and MACs
 *   Node               status.addresses
 *
 * The plugin keeps no list of Services or EgressIPs (see useServiceReads), so
 * those contribute through the load balancer VIPs alone.
 *
 * An answer is a list, never a pick. User-defined network subnets may overlap,
 * so one address can belong to several networks at once, and every candidate
 * comes back tagged with its network. Matching is on the exact address: a
 * subnet that merely contains it says nothing about who holds it. A caller that
 * knows where it is standing narrows the list with `AddressScope`.
 *
 * A node port VIP is left out: it sits on the node's own address, and would
 * make every NodePort Service an owner of that address.
 */

export type AddressOwnerKind = 'pod' | 'router-port' | 'switch-port' | 'service' | 'nat' | 'node' | 'interface';

/** What an owner is, precisely enough to link to it or to look it up again. */
export type AddressOwnerRef =
    /** A Kubernetes object: a Pod, a Service or a Node. */
    | { type: 'resource'; resource: ResourceRef }
    /** A logical switch or router, and the port on it when a port holds the address. */
    | { type: 'construct'; construct: 'switch' | 'router'; name: string; port?: string; zone?: string }
    /** One interface of one node, with its graph node id when it has one. */
    | { type: 'interface'; node: string; name: string; graphId?: string };

export type AddressSource =
    | 'Logical_Switch_Port'
    | 'Logical_Router_Port'
    | 'NAT'
    | 'Load_Balancer'
    | 'NodeNetworkState'
    | 'Node';

/** Where one claim on an address was read. */
export interface AddressProvenance {
    source: AddressSource;
    /** The row or object: a port, a router (for NAT), a load balancer, a node. */
    record: string;
    /** The field that holds the address. */
    field: string;
    /** The value as stored. */
    value: string;
    /** The node whose zone database held the row. */
    zone?: string;
}

export interface AddressOwner {
    kind: AddressOwnerKind;
    ref: AddressOwnerRef;
    label: string;
    /** The node the owner lives on; absent for what spans nodes. */
    node?: string;
    /** The `k8s.ovn.org/network` identity; absent for what is outside OVN (a host interface, a Node). */
    network?: string;
    /** Every claim behind this owner, at least one. */
    provenance: AddressProvenance[];
}

export interface AddressBook {
    /** By `hostKey`: an address in any spelling, with or without its mask. */
    byIp: ReadonlyMap<string, readonly AddressOwner[]>;
    /** By MAC in lower-case colon form. */
    byMac: ReadonlyMap<string, readonly AddressOwner[]>;
}

export interface AddressBookSources {
    /** Zone databases, with the node each belongs to when known. */
    zones?: ReadonlyArray<{ node?: string; database: LogicalDatabase }>;
    nodeNetworkStates?: readonly NodeNetworkState[];
    nodes?: readonly K8sResourceCommon[];
}

/** What the caller knows about where the address was read. */
export interface AddressScope {
    /**
     * Only owners on this network: for an address read off a row of that
     * network, such as a NAT rule on its router.
     */
    network?: string;
    /**
     * Owners on this node, when there are any, instead of the rest: for an
     * address read on the node, where its own interfaces and zone come first.
     * With none there, every candidate stands.
     */
    preferNode?: string;
}

const KIND_ORDER: readonly AddressOwnerKind[] = ['pod', 'router-port', 'switch-port', 'service', 'nat', 'node', 'interface'];

const refKey = (ref: AddressOwnerRef): string => {
    switch (ref.type) {
        case 'resource':
            return `${ref.resource.kind}/${ref.resource.namespace ?? ''}/${ref.resource.name}`;
        case 'construct':
            // Not the zone: the same row seen from two zones is one owner.
            return `${ref.construct}/${ref.name}/${ref.port ?? ''}`;
        case 'interface':
            return `${ref.node}/${ref.name}`;
    }
};

const ownerKey = (owner: Omit<AddressOwner, 'provenance'>): string =>
    [owner.kind, refKey(owner.ref), owner.network ?? '', owner.node ?? ''].join('|');

const provenanceKey = (entry: AddressProvenance): string =>
    [entry.source, entry.record, entry.field, entry.value, entry.zone ?? ''].join('|');

type OwnerIndex = Map<string, Map<string, AddressOwner>>;

const claim = (
    index: OwnerIndex,
    key: string,
    owner: Omit<AddressOwner, 'provenance'>,
    provenance: AddressProvenance,
): void => {
    const owners = index.get(key) ?? new Map<string, AddressOwner>();
    index.set(key, owners);
    const identity = ownerKey(owner);
    const known = owners.get(identity);
    if (!known) {
        owners.set(identity, { ...owner, provenance: [provenance] });
    } else if (!known.provenance.some((entry) => provenanceKey(entry) === provenanceKey(provenance))) {
        known.provenance.push(provenance);
    }
};

interface Collector {
    claimIp: (address: string, owner: Omit<AddressOwner, 'provenance'>, provenance: Omit<AddressProvenance, 'value'>) => void;
    claimMac: (mac: string | undefined, owner: Omit<AddressOwner, 'provenance'>, provenance: Omit<AddressProvenance, 'value'>) => void;
}

/** The owner a switch port's addresses belong to; undefined for a port that holds none of its own. */
const switchPortOwner = (
    row: LogicalSwitchPortRow,
    construct: ClassifiedConstruct,
    zone: string | undefined,
): Omit<AddressOwner, 'provenance'> | undefined => {
    // A router-type port repeats the MAC of the router port it attaches to.
    if (row.type === 'router' || row.type === 'localnet') return undefined;
    const port = classifySwitchPort(row);
    const shared = { network: construct.network };
    if (port.role === 'pod-port' && port.namespace && port.pod) {
        return {
            ...shared,
            kind: 'pod',
            // The pod itself, launcher pods included: a view that shows a pod's VM reads it from here.
            ref: { type: 'resource', resource: { apiVersion: 'v1', kind: 'Pod', namespace: port.namespace, name: port.pod } },
            label: `${port.namespace}/${port.pod}`,
            node: construct.node ?? zone,
        };
    }
    return {
        ...shared,
        kind: 'switch-port',
        ref: { type: 'construct', construct: 'switch', name: construct.name, port: row.name, zone },
        label: row.name,
        node: row.externalIds?.['node'] ?? port.node ?? construct.node,
    };
};

const addZone = (collector: Collector, database: LogicalDatabase, zone: string | undefined): void => {
    const switchOfPort = new Map<string, ClassifiedConstruct>();
    for (const row of database.logicalSwitches) {
        const construct = classifySwitch(row);
        for (const uuid of row.ports) switchOfPort.set(uuid, construct);
    }
    const routerOfPort = new Map<string, ClassifiedConstruct>();
    const routerOfNat = new Map<string, ClassifiedConstruct>();
    for (const row of database.logicalRouters) {
        const construct = classifyRouter(row);
        for (const uuid of row.ports) routerOfPort.set(uuid, construct);
        for (const uuid of row.nat ?? []) routerOfNat.set(uuid, construct);
    }

    for (const row of database.logicalSwitchPorts) {
        const construct = switchOfPort.get(row.uuid);
        const owner = construct && switchPortOwner(row, construct, zone);
        if (!owner) continue;
        const entries: Array<[string, string]> = [
            ...(row.addresses ?? []).map((entry): [string, string] => ['addresses', entry]),
            ...(row.dynamicAddresses ? [['dynamic_addresses', row.dynamicAddresses] as [string, string]] : []),
        ];
        for (const [field, entry] of entries) {
            const provenance = { source: 'Logical_Switch_Port' as const, record: row.name, field, zone };
            collector.claimMac(entry.split(/\s+/)[0], owner, provenance);
            for (const address of portEntryAddresses(entry)) collector.claimIp(address, owner, provenance);
        }
    }

    for (const row of database.logicalRouterPorts) {
        const router = routerOfPort.get(row.uuid);
        if (!router) continue;
        const owner: Omit<AddressOwner, 'provenance'> = {
            kind: 'router-port',
            ref: { type: 'construct', construct: 'router', name: router.name, port: row.name, zone },
            label: row.name,
            node: router.node ?? row.externalIds?.['k8s.ovn.org/node'],
            network: router.network,
        };
        collector.claimMac(row.mac, owner, { source: 'Logical_Router_Port', record: row.name, field: 'mac', zone });
        for (const network of row.networks ?? []) {
            collector.claimIp(network, owner, { source: 'Logical_Router_Port', record: row.name, field: 'networks', zone });
        }
    }

    for (const row of database.nats) {
        const router = routerOfNat.get(row.uuid);
        if (!router || !row.externalIp) continue;
        collector.claimIp(
            row.externalIp,
            {
                kind: 'nat',
                ref: { type: 'construct', construct: 'router', name: router.name, zone },
                label: router.name,
                node: router.node,
                network: router.network,
            },
            // One record per router: a gateway router has a rule per pod on one external IP.
            { source: 'NAT', record: router.name, field: 'external_ip', zone },
        );
    }

    const services = serviceIndexFor(database);
    if (!services) return;
    const context = vipClassContext(database);
    for (const [vip, entries] of services.vipIndex) {
        const { address } = parseVip(vip);
        for (const entry of entries) {
            const { service, loadBalancer } = entry;
            if (service?.kind !== 'Service') continue;
            const { scope } = scopeOf(loadBalancer);
            if (inferVipClass(vip, scope, serviceLabel(entry), context).vipClass === 'NodePort') continue;
            collector.claimIp(
                address,
                {
                    kind: 'service',
                    ref: {
                        type: 'resource',
                        resource: { apiVersion: 'v1', kind: 'Service', namespace: service.namespace, name: service.name },
                    },
                    label: `${service.namespace}/${service.name}`,
                    network: loadBalancer.externalIds?.[NETWORK_EXTERNAL_ID] || DEFAULT_NETWORK,
                },
                { source: 'Load_Balancer', record: loadBalancer.name, field: 'vips', zone },
            );
        }
    }
};

const addNodeNetworkState = (collector: Collector, state: NodeNetworkState): void => {
    const node = state.metadata?.name;
    const interfaces = state.status?.currentState?.interfaces;
    if (!node || !Array.isArray(interfaces)) return;
    for (const iface of interfaces) {
        if (!iface?.name) continue;
        const owner: Omit<AddressOwner, 'provenance'> = {
            kind: 'interface',
            ref: {
                type: 'interface',
                node,
                name: iface.name,
                graphId: resolveInterfaceLinkRef(iface.name, { interfaces }),
            },
            label: `${iface.name} on ${node}`,
            node,
        };
        const provenance = (field: string) => ({ source: 'NodeNetworkState' as const, record: node, field: `${iface.name} ${field}` });
        for (const { text } of interfaceAddresses(iface)) collector.claimIp(text, owner, provenance('address'));
        collector.claimMac(iface['mac-address'] ?? iface.mac_address, owner, provenance('mac-address'));
        collector.claimMac(iface['permanent-mac-address'], owner, provenance('permanent-mac-address'));
    }
};

const addNode = (collector: Collector, node: K8sResourceCommon): void => {
    const name = node.metadata?.name;
    if (!name) return;
    for (const { type, address } of nodeAddressesOf(node)) {
        collector.claimIp(
            address,
            {
                kind: 'node',
                ref: { type: 'resource', resource: { apiVersion: 'v1', kind: 'Node', name } },
                label: name,
                node: name,
            },
            { source: 'Node', record: name, field: `status.addresses ${type}` },
        );
    }
};

/** An address every host has, which therefore says nothing about any one of them. */
const isLoopback = (address: string): boolean => {
    const parsed = parsePrefix(address);
    if (!parsed) return false;
    return parsed.family === 4 ? parsed.address >> 24n === 127n : parsed.address === 1n;
};

const compareOwners = (a: AddressOwner, b: AddressOwner): number =>
    KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
    (a.network ?? '').localeCompare(b.network ?? '') ||
    a.label.localeCompare(b.label);

const finish = (index: OwnerIndex): Map<string, AddressOwner[]> =>
    new Map([...index].map(([key, owners]) => [key, [...owners.values()].sort(compareOwners)]));

/** Index the sources. Linear in what they hold: build once per data change. */
export const buildAddressBook = ({ zones = [], nodeNetworkStates = [], nodes = [] }: AddressBookSources): AddressBook => {
    const byIp: OwnerIndex = new Map();
    const byMac: OwnerIndex = new Map();
    const collector: Collector = {
        claimIp: (address, owner, provenance) => {
            const key = hostKey(address);
            if (key && !isLoopback(address)) claim(byIp, key, owner, { ...provenance, value: address });
        },
        claimMac: (mac, owner, provenance) => {
            const key = normalizeMac(mac);
            if (key && key !== '00:00:00:00:00:00') claim(byMac, key, owner, { ...provenance, value: mac as string });
        },
    };
    for (const { node, database } of zones) addZone(collector, database, node);
    for (const state of nodeNetworkStates) addNodeNetworkState(collector, state);
    for (const node of nodes) addNode(collector, node);
    return { byIp: finish(byIp), byMac: finish(byMac) };
};

const bookCache = new WeakMap<LogicalDatabase, Map<string, AddressBook>>();

/** One zone's address book, built once per database object. */
export const addressBookForDatabase = (
    database: LogicalDatabase | null | undefined,
    zone?: string,
): AddressBook | undefined => {
    if (!database) return undefined;
    const books = bookCache.get(database) ?? new Map<string, AddressBook>();
    bookCache.set(database, books);
    const key = zone ?? '';
    let book = books.get(key);
    if (!book) {
        book = buildAddressBook({ zones: [{ node: zone, database }] });
        books.set(key, book);
    }
    return book;
};

const NO_OWNERS: readonly AddressOwner[] = [];

/**
 * Whose is this IP or MAC? Every candidate, in a stable order; more than one
 * means the address is ambiguous here, and none is to be preferred. Empty for
 * text that is neither, for an address nothing holds, and for a subnet.
 */
export const resolveAddress = (
    book: AddressBook,
    address: string,
    { network, preferNode }: AddressScope = {},
): readonly AddressOwner[] => {
    const mac = normalizeMac(address);
    let owners: readonly AddressOwner[];
    if (mac) {
        owners = book.byMac.get(mac) ?? NO_OWNERS;
    } else {
        const parsed = parsePrefix(address);
        if (!parsed) return NO_OWNERS;
        // 10.131.0.1/23 is an address with its mask; 10.131.0.0/23 is a subnet. On a
        // point-to-point /31 or /127, as transit router ports use, both ends are addresses.
        const pointToPoint = parsed.length >= (parsed.family === 4 ? 31 : 127);
        if (address.includes('/') && !pointToPoint && parsed.address === parsed.network) return NO_OWNERS;
        owners = book.byIp.get(hostKey(address) as string) ?? NO_OWNERS;
    }
    if (network !== undefined) owners = owners.filter((owner) => owner.network === network);
    if (preferNode !== undefined) {
        const here = owners.filter(
            (owner) => owner.node === preferNode || owner.provenance.some((entry) => entry.zone === preferNode),
        );
        if (here.length > 0) return here;
    }
    return owners;
};

/** Where an owner opens: its console page, or its place in OVN Recon. */
export const addressOwnerTarget = (owner: AddressOwner): LinkTarget => {
    const { ref } = owner;
    if (ref.type === 'resource') return resourceTarget(ref.resource);
    if (ref.type === 'interface') return { type: 'path', path: nodePhysicalPath(ref.node, ref.graphId) };
    const construct = { kind: ref.construct, name: ref.name };
    if (!ref.zone) return { type: 'path', path: clusterLogicalPath(construct) };
    if (owner.kind === 'switch-port') {
        return { type: 'path', path: constructDetailPath(ref.zone, 'switch', ref.name, { tab: 'ports', port: ref.port }) };
    }
    if (owner.kind === 'nat') {
        return { type: 'path', path: constructDetailPath(ref.zone, 'router', ref.name, { tab: 'routes' }) };
    }
    return { type: 'path', path: nodeLogicalPath(ref.zone, construct) };
};
