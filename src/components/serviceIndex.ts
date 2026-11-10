import { LoadBalancerGroupRow, LoadBalancerRow, LogicalDatabase, LookupHit } from '../types';
import { comparePrefixes, ParsedPrefix, parsePrefix, prefixContains } from './ipPrefix';

/**
 * The service plane as a pure model over one node's database (ovn-recon-e2b.6):
 * which load balancers a switch or router sees, and which Service a VIP
 * belongs to.
 *
 * ovn-kubernetes writes one Load_Balancer per Service, protocol and scope.
 * Cluster-scoped rows reach a switch or router through a Load_Balancer_Group
 * (clusterLBGroup); rows materialised per node are set directly on the node
 * switch and gateway router. A construct's VIP set is therefore the union of
 * its direct load balancers and the members of every group it attaches.
 *
 * Everything here reads the optional `services` section, which a snapshot
 * carries only when the services section is requested; without it the lookups
 * return undefined and the drawer keeps its "not collected" rendering.
 */

const OWNER_KIND_KEY = 'k8s.ovn.org/kind';
const OWNER_KEY = 'k8s.ovn.org/owner';

/** The Kubernetes object a load balancer was written for. */
export interface ServiceOwner {
    /** `k8s.ovn.org/kind` as written; only "Service" has been observed. */
    kind?: string;
    namespace: string;
    name: string;
}

/**
 * The owner named in external_ids: `k8s.ovn.org/owner` is "namespace/name",
 * split at the first slash. Undefined when the row is not attributed.
 */
export const serviceOf = (loadBalancer: LoadBalancerRow): ServiceOwner | undefined => {
    const owner = loadBalancer.externalIds?.[OWNER_KEY];
    if (!owner) return undefined;
    const slash = owner.indexOf('/');
    if (slash <= 0 || slash === owner.length - 1) return undefined;
    return {
        kind: loadBalancer.externalIds?.[OWNER_KIND_KEY],
        namespace: owner.slice(0, slash),
        name: owner.slice(slash + 1),
    };
};

export type LoadBalancerScope = 'cluster' | 'node_router+switch' | 'node_router' | 'node_switch' | 'unknown';

export interface LoadBalancerScopeInfo {
    scope: LoadBalancerScope;
    /** The node a node-scoped row was materialised for. */
    node?: string;
}

// The scope is the tail of the name ovn-kubernetes builds:
// ..._cluster, or ..._node_<targets>_<node>. The longer alternative first.
const SCOPE_SUFFIX = /_(?:(cluster)|(node_router\+switch|node_router|node_switch)_(.+))$/;

/**
 * Where a load balancer applies, parsed from its name suffix. A name that
 * does not follow the scheme (another CMS, a future ovn-kubernetes) is
 * `unknown`, never an error.
 */
export const scopeOf = (loadBalancer: LoadBalancerRow): LoadBalancerScopeInfo => {
    const match = SCOPE_SUFFIX.exec(loadBalancer.name ?? '');
    if (!match) return { scope: 'unknown' };
    if (match[1]) return { scope: 'cluster' };
    return { scope: match[2] as LoadBalancerScope, node: match[3] };
};

/**
 * The backends of one VIP. The collector carries the NB value as stored: a
 * comma-separated "backend:port" list, empty for a VIP without endpoints.
 */
export const splitBackends = (value: string | undefined): string[] =>
    value == null || value === '' ? [] : value.split(',');

/** One VIP of one load balancer. */
export interface VipEntry {
    /** The vips key as stored: "vip:port", IPv6 as "[addr]:port". */
    vip: string;
    loadBalancer: LoadBalancerRow;
    service?: ServiceOwner;
    backends: string[];
}

export interface ServiceIndex {
    lbByUuid: Map<string, LoadBalancerRow>;
    groupByUuid: Map<string, LoadBalancerGroupRow>;
    /**
     * "Which Service is this VIP": the vips key to every load balancer that
     * carries it. More than one is normal: the same VIP and port over TCP and
     * UDP are two rows, and so are the per-node variants of one Service.
     */
    vipIndex: Map<string, VipEntry[]>;
}

/** True when the database carries both tables of the services section. */
export const hasServicesSection = (
    database: LogicalDatabase | null | undefined,
): database is LogicalDatabase & { loadBalancers: LoadBalancerRow[]; loadBalancerGroups: LoadBalancerGroupRow[] } =>
    database?.loadBalancers !== undefined && database.loadBalancerGroups !== undefined;

const indexCache = new WeakMap<LogicalDatabase, ServiceIndex>();

/**
 * The indexes over a database's services section, built once per database
 * object. Undefined when the section is absent.
 */
export const serviceIndexFor = (database: LogicalDatabase | null | undefined): ServiceIndex | undefined => {
    if (!hasServicesSection(database)) return undefined;
    const cached = indexCache.get(database);
    if (cached) return cached;

    const vipIndex = new Map<string, VipEntry[]>();
    for (const loadBalancer of database.loadBalancers) {
        const service = serviceOf(loadBalancer);
        for (const [vip, backends] of Object.entries(loadBalancer.vips ?? {})) {
            const entries = vipIndex.get(vip) ?? [];
            entries.push({ vip, loadBalancer, service, backends: splitBackends(backends) });
            vipIndex.set(vip, entries);
        }
    }
    const index: ServiceIndex = {
        lbByUuid: new Map(database.loadBalancers.map((row) => [row.uuid, row])),
        groupByUuid: new Map(database.loadBalancerGroups.map((row) => [row.uuid, row])),
        vipIndex,
    };
    indexCache.set(database, index);
    return index;
};

/** The load balancers one switch or router sees, by how they are attached. */
export interface LoadBalancerAttachment {
    /** Set on the row's own load_balancer column. */
    direct: LoadBalancerRow[];
    /** One entry per attached group, empty groups included. */
    viaGroups: Array<{ group: LoadBalancerGroupRow; members: LoadBalancerRow[] }>;
}

/** The part of a ladder construct the lookup needs. */
export interface AttachmentSubject {
    kind: string;
    uuid: string;
    name: string;
}

const present = <T>(value: T | undefined): value is T => value !== undefined;

/**
 * Resolve the load_balancer and load_balancer_group references of a switch
 * or router against the services section. The row is found by uuid, then by
 * name: in the merged cluster view the construct's uuid is not this zone's.
 * Undefined when the section is absent or the database has no such row.
 */
export const loadBalancersFor = (
    construct: AttachmentSubject,
    database: LogicalDatabase | null | undefined,
): LoadBalancerAttachment | undefined => {
    const index = serviceIndexFor(database);
    if (!index || !database) return undefined;

    const rows: Array<{ uuid: string; name: string; loadBalancer?: string[]; loadBalancerGroup?: string[] }> =
        construct.kind === 'router'
            ? database.logicalRouters
            : construct.kind === 'switch'
                ? database.logicalSwitches
                : [];
    const row = rows.find((candidate) => candidate.uuid === construct.uuid)
        ?? rows.find((candidate) => candidate.name === construct.name);
    if (!row) return undefined;

    return {
        direct: (row.loadBalancer ?? []).map((uuid) => index.lbByUuid.get(uuid)).filter(present),
        viaGroups: (row.loadBalancerGroup ?? [])
            .map((uuid) => index.groupByUuid.get(uuid))
            .filter(present)
            .map((group) => ({
                group,
                members: group.loadBalancers.map((uuid) => index.lbByUuid.get(uuid)).filter(present),
            }))
            .sort((a, b) => a.group.name.localeCompare(b.group.name)),
    };
};

/** Label for a load balancer set directly on the switch or router. */
export const DIRECT_SOURCE = 'direct';

/** One table row of the Services tab: one VIP of one load balancer. */
export interface ServiceVipRow {
    key: string;
    loadBalancer: LoadBalancerRow;
    service?: ServiceOwner;
    /** tcp when the NB column is unset, as OVN treats it. */
    protocol: string;
    /** The vips key as stored; '' for a load balancer without any VIP. */
    vip: string;
    backends: string[];
    scope: LoadBalancerScope;
    node?: string;
    /** How the construct sees it: "direct" and/or the group names. */
    sources: string[];
}

/** "namespace/name" of the owner, or the load balancer's own name. */
export const serviceLabel = (row: Pick<ServiceVipRow, 'service' | 'loadBalancer'>): string =>
    row.service ? `${row.service.namespace}/${row.service.name}` : row.loadBalancer.name;

/**
 * Each load balancer the construct sees, once, with how it is attached:
 * "direct" and/or the names of the groups that carry it.
 */
const attachedLoadBalancers = (
    attachment: LoadBalancerAttachment,
): Array<{ loadBalancer: LoadBalancerRow; sources: string[] }> => {
    const sourcesByUuid = new Map<string, { loadBalancer: LoadBalancerRow; sources: string[] }>();
    const add = (loadBalancer: LoadBalancerRow, source: string) => {
        const seen = sourcesByUuid.get(loadBalancer.uuid);
        if (!seen) {
            sourcesByUuid.set(loadBalancer.uuid, { loadBalancer, sources: [source] });
        } else if (!seen.sources.includes(source)) {
            seen.sources.push(source);
        }
    };
    attachment.direct.forEach((loadBalancer) => add(loadBalancer, DIRECT_SOURCE));
    for (const { group, members } of attachment.viaGroups) {
        members.forEach((loadBalancer) => add(loadBalancer, group.name));
    }
    return [...sourcesByUuid.values()];
};

/**
 * The attachment flattened to one row per VIP, each load balancer once even
 * when it is attached both directly and through a group. Sorted by Service,
 * then protocol and VIP.
 */
export const serviceVipRows = (attachment: LoadBalancerAttachment): ServiceVipRow[] => {
    const rows: ServiceVipRow[] = [];
    for (const { loadBalancer, sources } of attachedLoadBalancers(attachment)) {
        const shared = {
            loadBalancer,
            service: serviceOf(loadBalancer),
            protocol: loadBalancer.protocol || 'tcp',
            ...scopeOf(loadBalancer),
            sources,
        };
        const vips = Object.entries(loadBalancer.vips ?? {});
        if (vips.length === 0) {
            rows.push({ ...shared, key: loadBalancer.uuid, vip: '', backends: [] });
            continue;
        }
        for (const [vip, backends] of vips) {
            rows.push({ ...shared, key: `${loadBalancer.uuid}|${vip}`, vip, backends: splitBackends(backends) });
        }
    }
    return rows.sort(
        (a, b) =>
            serviceLabel(a).localeCompare(serviceLabel(b)) ||
            a.protocol.localeCompare(b.protocol) ||
            a.vip.localeCompare(b.vip, undefined, { numeric: true }) ||
            a.key.localeCompare(b.key),
    );
};

export interface AttachmentSummary {
    /** Load balancers set directly on the row. */
    direct: number;
    /** Members per attached group, in name order; zero for an empty group. */
    groups: Array<{ name: string; count: number }>;
    /** Distinct load balancers across direct and groups. */
    total: number;
    /** VIPs whose Service has no endpoints: OVN answers these itself (a
     * reset or ICMP unreachable when options:reject is set). */
    vipsWithoutEndpoints: number;
}

export const summarizeAttachment = (attachment: LoadBalancerAttachment): AttachmentSummary => {
    const rows = serviceVipRows(attachment);
    return {
        direct: attachment.direct.length,
        groups: attachment.viaGroups.map(({ group, members }) => ({ name: group.name, count: members.length })),
        total: new Set(rows.map((row) => row.loadBalancer.uuid)).size,
        vipsWithoutEndpoints: rows.filter((row) => row.vip !== '' && row.backends.length === 0).length,
    };
};

/** "a", "a and b", "a, b and c". */
const joinNames = (names: string[]): string =>
    names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/**
 * The Overview line: "22 direct · 319 via clusterLBGroup", or, when nothing
 * is programmed, "0 load balancers; groups a and b are empty". An empty
 * per-network group is worth saying out loud: it is why a pod on that
 * network reaches no ClusterIP.
 */
export const attachmentSummaryText = (summary: AttachmentSummary): string => {
    if (summary.total === 0) {
        const names = summary.groups.map((group) => group.name);
        if (names.length === 0) return '0 load balancers';
        return `0 load balancers; group${names.length === 1 ? '' : 's'} ${joinNames(names)} ${names.length === 1 ? 'is' : 'are'} empty`;
    }
    const parts: string[] = [];
    if (summary.direct > 0) parts.push(`${summary.direct} direct`);
    for (const group of summary.groups) parts.push(`${group.count} via ${group.name}`);
    return parts.join(' · ');
};

// ------------------------------------------------------------- VIP keys

/** A vips key or a backend split into its address and port. */
export interface ParsedVip {
    /** Without brackets: "172.30.0.1", "fd02::1", or a template variable
     * such as "^NODEIP_IPv4_0". */
    address: string;
    port?: number;
}

/**
 * Split "172.30.0.1:443", "[fd02::1]:443", a bare address (OVN allows a VIP
 * without a port) or a bare IPv6 address.
 */
export const parseVip = (text: string): ParsedVip => {
    const value = text.trim();
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
    if (bracketed) return bracketed[2] ? { address: bracketed[1], port: Number(bracketed[2]) } : { address: bracketed[1] };
    const withPort = /^([^:]+):(\d+)$/.exec(value);
    if (withPort) return { address: withPort[1], port: Number(withPort[2]) };
    return { address: value };
};

/** Compare addresses by value, so that `fd02::a` and `fd02:0::a` are one. */
const addressKey = (address: string): string => {
    const parsed = parsePrefix(address);
    return parsed && !address.includes('/') ? `${parsed.family}:${parsed.address.toString(16)}` : address;
};

const nonNull = <T>(value: T | null | undefined): value is T => value != null;

const within = (subnets: readonly ParsedPrefix[], address: string): boolean => {
    const parsed = parsePrefix(address);
    return parsed !== null && subnets.some((subnet) => prefixContains(subnet, parsed));
};

// ------------------------------------------------------ VIP classes

/**
 * What a VIP is to Kubernetes. The order is the reading order of the Type
 * column and facet.
 */
export const VIP_CLASSES = ['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalIP'] as const;
export type VipClass = (typeof VIP_CLASSES)[number];

export interface VipClassification {
    vipClass: VipClass;
    /** `inferred` from the OVN rows alone; `declared` once the Kubernetes
     * Service has been read and names the address. */
    basis: 'inferred' | 'declared';
    /** Why, in one clause, for a tooltip. */
    reason: string;
}

/** ovn-kubernetes' default node masquerade subnets. */
export const DEFAULT_MASQUERADE_SUBNETS: readonly string[] = ['169.254.0.0/17', 'fd69::/112'];
const MASQUERADE_ROUTE_KEY = 'k8s.ovn.org/node-masquerade-subnet';

/** What the zone's database says about addresses, for inferring VIP classes. */
export interface VipClassContext {
    /** The node's own addresses (keys), where node ports listen. */
    nodeAddresses: ReadonlySet<string>;
    masqueradeSubnets: ParsedPrefix[];
    /** The cluster's service network; empty when it could not be read. */
    serviceNetworks: ParsedPrefix[];
    /** The subnets of the gateway routers' external ports. */
    externalSubnets: ParsedPrefix[];
    /** Services (by `serviceLabel`) with a node port VIP in this zone. */
    servicesWithNodePorts: ReadonlySet<string>;
}

const isGatewayExternalPort = (port: { name: string; externalIds?: Record<string, string> }): boolean =>
    port.externalIds?.['gateway-physical-ip'] === 'yes' || port.name.startsWith('rtoe-');

/**
 * Collect what inference needs from one zone's database. The node's
 * addresses start from the gateway routers' physical_ip(s) and external port
 * networks; ovn-kubernetes writes a node port on every host address, so an
 * address that shares a port with one of those on the same node-scoped load
 * balancer is a host address too (a second NIC's address is learnt that way).
 * `serviceNetworks` comes from the cluster Network config when readable.
 */
export const vipClassContext = (
    database: LogicalDatabase | null | undefined,
    serviceNetworks: readonly string[] = [],
): VipClassContext => {
    const masqueradeSubnets = [
        ...DEFAULT_MASQUERADE_SUBNETS,
        ...(database?.staticRoutes ?? [])
            .filter((route) => route.externalIds?.[MASQUERADE_ROUTE_KEY] !== undefined)
            .map((route) => route.ipPrefix),
    ]
        .map(parsePrefix)
        .filter(nonNull);
    const parsedServiceNetworks = serviceNetworks.map(parsePrefix).filter(nonNull);
    const isOther = (address: string) =>
        within(masqueradeSubnets, address) || within(parsedServiceNetworks, address);

    const nodeAddresses = new Set<string>();
    const addNodeAddress = (address: string) => {
        const trimmed = address.trim();
        if (parsePrefix(trimmed) && !isOther(trimmed)) nodeAddresses.add(addressKey(trimmed));
    };
    for (const router of database?.logicalRouters ?? []) {
        (router.externalIds?.physical_ip ?? '').split(',').forEach(addNodeAddress);
        (router.externalIds?.physical_ips ?? '').split(',').forEach(addNodeAddress);
    }
    const externalSubnets: ParsedPrefix[] = [];
    for (const port of database?.logicalRouterPorts ?? []) {
        if (!isGatewayExternalPort(port)) continue;
        for (const network of port.networks ?? []) {
            const parsed = parsePrefix(network);
            if (!parsed || within(masqueradeSubnets, network.split('/')[0])) continue;
            externalSubnets.push(parsed);
            addNodeAddress(network.split('/')[0]);
        }
    }

    const loadBalancers = database?.loadBalancers ?? [];
    const learnt: string[] = [];
    for (const loadBalancer of loadBalancers) {
        const { scope } = scopeOf(loadBalancer);
        if (scope === 'cluster' || scope === 'unknown') continue;
        const byPort = new Map<number, string[]>();
        for (const vip of Object.keys(loadBalancer.vips ?? {})) {
            const { address, port } = parseVip(vip);
            if (port === undefined) continue;
            byPort.set(port, [...(byPort.get(port) ?? []), address]);
        }
        for (const addresses of byPort.values()) {
            if (addresses.some((address) => nodeAddresses.has(addressKey(address)))) learnt.push(...addresses);
        }
    }
    learnt.forEach(addNodeAddress);

    const partial: VipClassContext = {
        nodeAddresses,
        masqueradeSubnets,
        serviceNetworks: parsedServiceNetworks,
        externalSubnets,
        servicesWithNodePorts: new Set(),
    };
    const servicesWithNodePorts = new Set<string>();
    for (const loadBalancer of loadBalancers) {
        const { scope } = scopeOf(loadBalancer);
        const label = serviceLabel({ service: serviceOf(loadBalancer), loadBalancer });
        if (Object.keys(loadBalancer.vips ?? {}).some((vip) => nodePortReason(parseVip(vip).address, scope, partial))) {
            servicesWithNodePorts.add(label);
        }
    }
    return { ...partial, servicesWithNodePorts };
};

const nodePortReason = (address: string, scope: LoadBalancerScope, context: VipClassContext): string | undefined => {
    if (address.startsWith('^')) return 'a per-node template address';
    if (within(context.masqueradeSubnets, address)) {
        return 'the node masquerade address a node port with externalTrafficPolicy Local listens on';
    }
    if (scope !== 'cluster' && context.nodeAddresses.has(addressKey(address))) return "one of the node's own addresses";
    return undefined;
};

/**
 * The class OVN's rows suggest for a VIP. A node port listens on the node's
 * addresses (or a template or masquerade address); a ClusterIP lies in the
 * service network; anything else is external, a LoadBalancer address when
 * the Service also has node ports (a LoadBalancer Service allocates them by
 * default), an ExternalIP otherwise. Without the service network an address
 * counts as external only on the node's own external subnet.
 */
export const inferVipClass = (
    vip: string,
    scope: LoadBalancerScope,
    serviceKey: string,
    context: VipClassContext,
): VipClassification => {
    const { address } = parseVip(vip);
    const nodePort = nodePortReason(address, scope, context);
    if (nodePort) return { vipClass: 'NodePort', basis: 'inferred', reason: nodePort };
    const external = (where: string): VipClassification =>
        context.servicesWithNodePorts.has(serviceKey)
            ? { vipClass: 'LoadBalancer', basis: 'inferred', reason: `${where}, on a Service that also has node ports` }
            : { vipClass: 'ExternalIP', basis: 'inferred', reason: `${where}, on a Service without node ports` };
    if (context.serviceNetworks.length > 0) {
        return within(context.serviceNetworks, address)
            ? { vipClass: 'ClusterIP', basis: 'inferred', reason: 'inside the service network' }
            : external('outside the service network');
    }
    if (within(context.externalSubnets, address)) return external("on the node's external subnet");
    return {
        vipClass: 'ClusterIP',
        basis: 'inferred',
        reason: 'not a node, masquerade or external-subnet address (the service network is not known)',
    };
};

/** The fields of a Kubernetes Service that say what its addresses are. */
export interface KubeServiceLike {
    metadata?: { name?: string; namespace?: string };
    spec?: {
        type?: string;
        clusterIP?: string;
        clusterIPs?: string[];
        externalIPs?: string[];
        ports?: Array<{ name?: string; port?: number; nodePort?: number; protocol?: string }>;
        externalTrafficPolicy?: string;
        internalTrafficPolicy?: string;
        sessionAffinity?: string;
    };
    status?: { loadBalancer?: { ingress?: Array<{ ip?: string; hostname?: string }> } };
}

/**
 * The class the Service itself declares for a VIP, or undefined when the
 * Service does not name the address (the VIP keeps its inferred class).
 */
export const declaredVipClass = (
    vip: string,
    protocol: string,
    service: KubeServiceLike,
): VipClassification | undefined => {
    const { address, port } = parseVip(vip);
    const key = addressKey(address);
    const names = (list: Array<string | undefined> | undefined) =>
        (list ?? []).some((item) => item !== undefined && addressKey(item) === key);
    const spec = service.spec ?? {};
    const clusterIPs = spec.clusterIPs ?? (spec.clusterIP ? [spec.clusterIP] : []);
    if (names(clusterIPs)) return { vipClass: 'ClusterIP', basis: 'declared', reason: 'listed in spec.clusterIPs' };
    if (names(spec.externalIPs)) return { vipClass: 'ExternalIP', basis: 'declared', reason: 'listed in spec.externalIPs' };
    if (names(service.status?.loadBalancer?.ingress?.map((ingress) => ingress.ip))) {
        return { vipClass: 'LoadBalancer', basis: 'declared', reason: 'listed in status.loadBalancer.ingress' };
    }
    const nodePort =
        port !== undefined &&
        (spec.ports ?? []).some(
            (servicePort) =>
                servicePort.nodePort === port && (servicePort.protocol ?? 'TCP').toLowerCase() === protocol.toLowerCase(),
        );
    if (nodePort) return { vipClass: 'NodePort', basis: 'declared', reason: 'a nodePort in spec.ports' };
    return undefined;
};

// ------------------------------------------------ one row per Service

/**
 * The Services tab's two sections. Node-scoped load balancers set directly
 * on the construct differ per node; cluster-scoped ones, and anything that
 * arrives only through a group, are the same on every construct sharing it.
 */
export type ServiceSection = 'node' | 'cluster';

export const sectionOf = (scope: LoadBalancerScope, sources: readonly string[]): ServiceSection =>
    scope === 'cluster' || !sources.includes(DIRECT_SOURCE) ? 'cluster' : 'node';

/** One VIP of one of the Service's load balancers. */
export interface ServiceVipView {
    key: string;
    /** The vips key as stored. */
    vip: string;
    address: string;
    port?: number;
    /** tcp when the NB column is unset. */
    protocol: string;
    backends: string[];
    loadBalancer: LoadBalancerRow;
    classification: VipClassification;
}

export interface ServicePort {
    port: number;
    protocol: string;
}

/** One table row: a Service's load balancers within one section. */
export interface ServiceGroupView {
    key: string;
    section: ServiceSection;
    service?: ServiceOwner;
    /** "namespace/name", or the load balancer's name when unattributed. */
    label: string;
    loadBalancers: LoadBalancerRow[];
    /** How the construct sees them: "direct" and/or the group names. */
    sources: string[];
    /** By address, then port and protocol. */
    vips: ServiceVipView[];
    /** Distinct ports, by number then protocol. */
    ports: ServicePort[];
    protocols: string[];
    /** The classes of the VIPs in VIP_CLASSES order; `inferred` when any VIP
     * of that class is only inferred. */
    classes: Array<{ vipClass: VipClass; inferred: boolean }>;
    /** Distinct backend addresses: endpoints, not address:port pairs. */
    backendCount: number;
    vipsWithoutEndpoints: number;
}

const compareVips = (a: ServiceVipView, b: ServiceVipView): number =>
    comparePrefixes(a.address, b.address) ||
    (a.port ?? 0) - (b.port ?? 0) ||
    a.protocol.localeCompare(b.protocol) ||
    a.key.localeCompare(b.key);

/**
 * The attachment as one row per Service and section. Each VIP is classified:
 * declared when `declared` holds the Service (by "namespace/name"), inferred
 * from `context` otherwise. Node section first, then by Service.
 */
export const groupServices = (
    attachment: LoadBalancerAttachment,
    context: VipClassContext,
    declared?: ReadonlyMap<string, KubeServiceLike>,
): ServiceGroupView[] => {
    const groups = new Map<string, ServiceGroupView>();
    for (const { loadBalancer, sources } of attachedLoadBalancers(attachment)) {
        const service = serviceOf(loadBalancer);
        const label = serviceLabel({ service, loadBalancer });
        const { scope } = scopeOf(loadBalancer);
        const section = sectionOf(scope, sources);
        const key = `${section}|${label}`;
        let group = groups.get(key);
        if (!group) {
            group = {
                key,
                section,
                service,
                label,
                loadBalancers: [],
                sources: [],
                vips: [],
                ports: [],
                protocols: [],
                classes: [],
                backendCount: 0,
                vipsWithoutEndpoints: 0,
            };
            groups.set(key, group);
        }
        group.loadBalancers.push(loadBalancer);
        sources.forEach((source) => {
            if (!group!.sources.includes(source)) group!.sources.push(source);
        });
        const protocol = loadBalancer.protocol || 'tcp';
        const kube = service?.kind === 'Service' ? declared?.get(label) : undefined;
        for (const [vip, value] of Object.entries(loadBalancer.vips ?? {})) {
            const { address, port } = parseVip(vip);
            group.vips.push({
                key: `${loadBalancer.uuid}|${vip}`,
                vip,
                address,
                port,
                protocol,
                backends: splitBackends(value),
                loadBalancer,
                classification:
                    (kube && declaredVipClass(vip, protocol, kube)) ?? inferVipClass(vip, scope, label, context),
            });
        }
    }

    for (const group of groups.values()) {
        group.vips.sort(compareVips);
        const ports = new Map<string, ServicePort>();
        for (const vip of group.vips) {
            if (vip.port !== undefined) ports.set(`${vip.port}/${vip.protocol}`, { port: vip.port, protocol: vip.protocol });
        }
        group.ports = [...ports.values()].sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
        group.protocols = [...new Set(group.vips.map((vip) => vip.protocol))].sort();
        group.classes = VIP_CLASSES.filter((vipClass) =>
            group.vips.some((vip) => vip.classification.vipClass === vipClass),
        ).map((vipClass) => ({
            vipClass,
            inferred: group.vips.some(
                (vip) => vip.classification.vipClass === vipClass && vip.classification.basis === 'inferred',
            ),
        }));
        group.backendCount = new Set(
            group.vips.flatMap((vip) => vip.backends.map((backend) => addressKey(parseVip(backend).address))),
        ).size;
        group.vipsWithoutEndpoints = group.vips.filter((vip) => vip.backends.length === 0).length;
    }

    return [...groups.values()].sort(
        (a, b) => (a.section === b.section ? 0 : a.section === 'node' ? -1 : 1) || a.label.localeCompare(b.label),
    );
};

/** The Services tab's narrowing controls. */
export interface ServiceFacets {
    /** Free text over the Service, load balancer names, VIPs and backends. */
    query?: string;
    vipClass?: VipClass;
    protocol?: string;
    namespace?: string;
    withoutEndpoints?: boolean;
}

const vipMatches = (vip: ServiceVipView, facets: ServiceFacets): boolean =>
    (!facets.vipClass || vip.classification.vipClass === facets.vipClass) &&
    (!facets.protocol || vip.protocol === facets.protocol) &&
    (!facets.withoutEndpoints || vip.backends.length === 0);

/**
 * True when the row passes every facet. The type, protocol and endpoints
 * facets ask about one VIP together: "a UDP NodePort", not "a NodePort and,
 * somewhere, UDP". The row still lists all of its VIPs.
 */
export const serviceGroupMatches = (group: ServiceGroupView, facets: ServiceFacets): boolean => {
    if (facets.namespace && group.service?.namespace !== facets.namespace) return false;
    if ((facets.vipClass || facets.protocol || facets.withoutEndpoints) && !group.vips.some((vip) => vipMatches(vip, facets))) {
        return false;
    }
    const query = facets.query?.trim().toLowerCase();
    if (!query) return true;
    return (
        group.label.toLowerCase().includes(query) ||
        group.loadBalancers.some((loadBalancer) => loadBalancer.name.toLowerCase().includes(query)) ||
        group.vips.some(
            (vip) =>
                vip.vip.toLowerCase().includes(query) ||
                vip.backends.some((backend) => backend.toLowerCase().includes(query)),
        )
    );
};

/** How many rows each facet value would keep. */
export interface ServiceFacetCounts {
    classes: Map<VipClass, number>;
    protocols: Map<string, number>;
    namespaces: Map<string, number>;
    withoutEndpoints: number;
}

export const serviceFacetCounts = (groups: readonly ServiceGroupView[]): ServiceFacetCounts => {
    const bump = <K>(map: Map<K, number>, key: K) => map.set(key, (map.get(key) ?? 0) + 1);
    const counts: ServiceFacetCounts = { classes: new Map(), protocols: new Map(), namespaces: new Map(), withoutEndpoints: 0 };
    for (const group of groups) {
        group.classes.forEach(({ vipClass }) => bump(counts.classes, vipClass));
        group.protocols.forEach((protocol) => bump(counts.protocols, protocol));
        if (group.service) bump(counts.namespaces, group.service.namespace);
        if (group.vipsWithoutEndpoints > 0) counts.withoutEndpoints += 1;
    }
    return counts;
};

/** Load balancers per section, plus the VIPs nothing answers. */
export interface ServiceSplitSummary {
    /** Load balancers in the "On this node" section. */
    here: number;
    /** Load balancers in the cluster-wide section. */
    clusterWide: number;
    total: number;
    /** VIPs whose Service has no endpoints. */
    vipsWithoutEndpoints: number;
}

export const summarizeSplit = (attachment: LoadBalancerAttachment): ServiceSplitSummary => {
    const summary: ServiceSplitSummary = { here: 0, clusterWide: 0, total: 0, vipsWithoutEndpoints: 0 };
    for (const { loadBalancer, sources } of attachedLoadBalancers(attachment)) {
        if (sectionOf(scopeOf(loadBalancer).scope, sources) === 'node') summary.here += 1;
        else summary.clusterWide += 1;
        summary.total += 1;
        summary.vipsWithoutEndpoints += Object.values(loadBalancer.vips ?? {}).filter((value) => value === '').length;
    }
    return summary;
};

/**
 * The line the Services tab and the Overview share: "22 here · 320
 * cluster-wide · 12 VIPs without endpoints" (load balancer counts). With
 * nothing programmed it keeps saying which groups are empty.
 */
export const splitSummaryText = (attachment: LoadBalancerAttachment): string => {
    const split = summarizeSplit(attachment);
    if (split.total === 0) return attachmentSummaryText(summarizeAttachment(attachment));
    const parts = [`${split.here} here`, `${split.clusterWide} cluster-wide`];
    if (split.vipsWithoutEndpoints > 0) {
        parts.push(`${split.vipsWithoutEndpoints} VIP${split.vipsWithoutEndpoints === 1 ? '' : 's'} without endpoints`);
    }
    return parts.join(' · ');
};

// ---------------------------------------------- backends on other nodes

/** A backend's pod as the collector lookup found it in some zone. */
export interface RemotePodOwner {
    namespace: string;
    pod: string;
    /** The zone (node) whose snapshot holds the port. */
    node: string;
    port?: string;
}

/**
 * The pod behind an address, from a lookup response: the one
 * Logical_Switch_Port that holds the address exactly, when a Pod owns it.
 * Hits on several fields of one row count once; two ports (the same address
 * on two networks, or a pod and something else) resolve to nothing, as the
 * zone's own index does.
 */
export const podOwnerFromLookup = (response: { hits: readonly LookupHit[] }): RemotePodOwner | undefined => {
    const ports = new Map<string, LookupHit>();
    for (const hit of response.hits) {
        if (hit.table === 'Logical_Switch_Port' && hit.matchType === 'exact') ports.set(`${hit.node}|${hit.rowUuid}`, hit);
    }
    if (ports.size !== 1) return undefined;
    const [hit] = [...ports.values()];
    if (hit.owner?.kind !== 'Pod' || !hit.owner.namespace) return undefined;
    return { namespace: hit.owner.namespace, pod: hit.owner.name, node: hit.node, port: hit.rowName };
};

/** True for a backend address worth a lookup: an IP, not a template. */
export const isLookupAddress = (address: string): boolean => parsePrefix(address) !== null && !address.includes('/');
