import { LoadBalancerGroupRow, LoadBalancerRow, LogicalDatabase } from '../types';

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
 * carries only when requested with ?include=services; without it the lookups
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
 * The attachment flattened to one row per VIP, each load balancer once even
 * when it is attached both directly and through a group. Sorted by Service,
 * then protocol and VIP.
 */
export const serviceVipRows = (attachment: LoadBalancerAttachment): ServiceVipRow[] => {
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

    const rows: ServiceVipRow[] = [];
    for (const { loadBalancer, sources } of sourcesByUuid.values()) {
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

/** Text filter over the Service, the VIP and the backends (lower-cased query). */
export const serviceVipRowMatches = (row: ServiceVipRow, query: string): boolean =>
    serviceLabel(row).toLowerCase().includes(query) ||
    row.loadBalancer.name.toLowerCase().includes(query) ||
    row.vip.toLowerCase().includes(query) ||
    row.backends.some((backend) => backend.toLowerCase().includes(query));

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
