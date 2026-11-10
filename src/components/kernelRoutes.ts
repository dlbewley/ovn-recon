import { comparePrefixes, isDefaultPrefix, networkCidr, parsePrefix } from './ipPrefix';
import type { NnsRoute } from './nodeVisualizationSelectors';

/**
 * Kernel routes from NodeNetworkState, shaped for a table (ovn-recon-dp7.2).
 *
 * Pure: the drawer facts and the node page both hand NnsRoute[] here and get
 * back tables of rows in reading order, so the ordering rules are tested
 * without rendering anything.
 */

/** The kernel's main table. */
export const MAIN_TABLE_ID = 254;

/** One way out for a route. A multipath (ECMP) route has several. */
export interface KernelNextHop {
    /** The gateway address; undefined when the destination is on-link. */
    gateway?: string;
    interface?: string;
    weight?: number;
}

/** A route row: one destination at one metric in one table. */
export interface KernelRouteRow {
    key: string;
    destination: string;
    family?: 4 | 6;
    prefixLength?: number;
    isDefault: boolean;
    /**
     * Set on the lowest-metric default route of its address family when its
     * table holds more than one: `among` counts that family's default routes.
     */
    preferred?: { among: number };
    metric?: number;
    nextHops: KernelNextHop[];
    /** Distinct preferred source addresses across the row's entries. */
    sources: string[];
    /** Distinct MTUs across the row's entries. */
    mtus: number[];
}

/** The routes of one kernel table, in reading order. */
export interface KernelRouteTableGroup {
    key: string;
    tableId?: number;
    vrfName?: string;
    rows: KernelRouteRow[];
}

/** A next hop of 0.0.0.0, :: (in any spelling) or none: the destination is on-link. */
export const isOnLinkNextHop = (address: string | undefined): boolean => {
    if (!address || !address.trim()) return true;
    const parsed = parsePrefix(address);
    return parsed !== null && parsed.address === 0n;
};

const unique = <T,>(values: (T | undefined)[]): T[] =>
    values.filter((value, index): value is T => value !== undefined && values.indexOf(value) === index);

/** A canonical spelling for grouping: `0:0::0/0` and `::/0` are one destination. */
const destinationKey = (destination: string): string => {
    const parsed = parsePrefix(destination);
    return parsed ? networkCidr(parsed) : destination;
};

/**
 * Fold one table's routes into rows. Entries to the same destination at the
 * same metric are one multipath (ECMP) route: the kernel reports each next
 * hop of it as an entry of its own. Entries at different metrics stay apart.
 */
export const groupEcmpRoutes = (routes: NnsRoute[]): KernelRouteRow[] => {
    const rows = new Map<string, KernelRouteRow & { entries: NnsRoute[] }>();
    for (const route of routes) {
        const key = `${destinationKey(route.destination)}|${route.metric ?? ''}`;
        let row = rows.get(key);
        if (!row) {
            const parsed = parsePrefix(route.destination);
            row = {
                key,
                destination: route.destination,
                family: parsed?.family,
                prefixLength: parsed?.length,
                isDefault: isDefaultPrefix(route.destination),
                metric: route.metric,
                nextHops: [],
                sources: [],
                mtus: [],
                entries: [],
            };
            rows.set(key, row);
        }
        row.entries.push(route);
        const hop: KernelNextHop = {
            gateway: isOnLinkNextHop(route.nextHopAddress) ? undefined : route.nextHopAddress,
            interface: route.nextHopInterface,
            weight: route.weight,
        };
        if (!row.nextHops.some((other) => other.gateway === hop.gateway && other.interface === hop.interface)) {
            row.nextHops.push(hop);
        }
    }
    return Array.from(rows.values()).map(({ entries, ...row }) => ({
        ...row,
        sources: unique(entries.map((entry) => entry.source)),
        mtus: unique(entries.map((entry) => entry.mtu)),
    }));
};

/**
 * NodeNetworkState leaves out a metric of 0 on IPv4 routes (the kernel does
 * not report one), so an absent metric orders as 0. It is still shown as
 * absent, and never decides which default route is preferred.
 */
const metricOrder = (row: KernelRouteRow): number => row.metric ?? 0;

const familyOrder = (row: KernelRouteRow): number => row.family ?? 7;

/**
 * Reading order within one table: default routes pinned first, then IPv4
 * before IPv6, then longest prefix first, then by address, then lowest
 * metric first. Below the pinned defaults, the first row covering an address
 * is the route the kernel picks for it: longest prefix wins, and among
 * routes to the same destination the lowest metric. Ordering by address
 * before metric keeps the routes to one destination next to each other.
 */
export const compareKernelRoutes = (a: KernelRouteRow, b: KernelRouteRow): number =>
    Number(b.isDefault) - Number(a.isDefault) ||
    familyOrder(a) - familyOrder(b) ||
    (b.prefixLength ?? -1) - (a.prefixLength ?? -1) ||
    comparePrefixes(a.destination, b.destination) ||
    metricOrder(a) - metricOrder(b) ||
    (a.nextHops[0]?.interface ?? '').localeCompare(b.nextHops[0]?.interface ?? '');

/**
 * Mark the default route the kernel prefers when one table holds several of
 * the same family: the lowest metric. Left unmarked when any of them reports
 * no metric, because then the table alone does not say which one wins.
 */
export const markPreferredDefaults = (rows: KernelRouteRow[]): KernelRouteRow[] => {
    const preferred = new Map<KernelRouteRow, number>();
    for (const family of [4, 6] as const) {
        const defaults = rows.filter((row) => row.isDefault && row.family === family);
        if (defaults.length < 2 || defaults.some((row) => row.metric === undefined)) continue;
        const lowest = Math.min(...defaults.map((row) => row.metric as number));
        const winners = defaults.filter((row) => row.metric === lowest);
        if (winners.length === 1) preferred.set(winners[0], defaults.length);
    }
    return rows.map((row) => (preferred.has(row) ? { ...row, preferred: { among: preferred.get(row) as number } } : row));
};

/** Table order: main first, then by table id, then entries reporting no table. */
const compareTables = (a: KernelRouteTableGroup, b: KernelRouteTableGroup): number => {
    const rank = (group: KernelRouteTableGroup) =>
        group.tableId === MAIN_TABLE_ID ? 0 : group.tableId === undefined ? 2 : 1;
    return rank(a) - rank(b) || (a.tableId ?? 0) - (b.tableId ?? 0) || (a.vrfName ?? '').localeCompare(b.vrfName ?? '');
};

/**
 * Routes as tables: one per kernel table (id and vrf-name), main first; in
 * each, ECMP entries folded into one row, rows in reading order, and the
 * preferred default route marked.
 */
export const buildKernelRouteTables = (routes: NnsRoute[]): KernelRouteTableGroup[] => {
    const tables = new Map<string, { tableId?: number; vrfName?: string; routes: NnsRoute[] }>();
    for (const route of routes) {
        const key = `${route.tableId ?? ''}|${route.vrfName ?? ''}`;
        const table = tables.get(key) ?? { tableId: route.tableId, vrfName: route.vrfName, routes: [] };
        table.routes.push(route);
        tables.set(key, table);
    }
    return Array.from(tables.entries())
        .map(([key, table]) => ({
            key,
            tableId: table.tableId,
            vrfName: table.vrfName,
            rows: markPreferredDefaults(groupEcmpRoutes(table.routes).sort(compareKernelRoutes)),
        }))
        .sort(compareTables);
};

/**
 * Only the rows with a next hop through `interfaceName`, tables left empty
 * dropped. Applied after the tables are built, so an ECMP route keeps its
 * other next hops and the preferred-default mark still reflects the whole
 * table, not just this device's share of it.
 */
export const routeTablesVia = (
    groups: KernelRouteTableGroup[],
    interfaceName: string,
): KernelRouteTableGroup[] =>
    groups
        .map((group) => ({
            ...group,
            rows: group.rows.filter((row) => row.nextHops.some((hop) => hop.interface === interfaceName)),
        }))
        .filter((group) => group.rows.length > 0);

/** "Table 254 (main)", "Table 1146 · VRF mp9-udn-vrf", "Table not reported". */
export const kernelTableLabel = (group: Pick<KernelRouteTableGroup, 'tableId' | 'vrfName'>): string => {
    const base = group.tableId === undefined
        ? 'Table not reported'
        : `Table ${group.tableId}${group.tableId === MAIN_TABLE_ID ? ' (main)' : ''}`;
    return group.vrfName ? `${base} · VRF ${group.vrfName}` : base;
};

/** "6 routes · 2 default · 1 ECMP". */
export const kernelRouteSummary = (rows: KernelRouteRow[]): string => {
    const defaults = rows.filter((row) => row.isDefault).length;
    const ecmp = rows.filter((row) => row.nextHops.length > 1).length;
    const parts = [`${rows.length} route${rows.length === 1 ? '' : 's'}`];
    if (defaults > 0) parts.push(`${defaults} default`);
    if (ecmp > 0) parts.push(`${ecmp} ECMP`);
    return parts.join(' · ');
};
