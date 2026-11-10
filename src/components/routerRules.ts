/**
 * Logical router rules as the drawer presents them: NAT rows grouped by
 * intent and static routes ordered for reading, with addresses resolved to
 * what the zone's database says owns them. Pure functions over snapshot rows.
 */
import { LogicalDatabase, LogicalRouterPortRow, LogicalSwitchPortRow, NATRow, NATType, StaticRouteRow } from '../types';
import { classifySwitchPort } from './logicalClassification';
import { comparePrefixes, isDefaultPrefix, isHostAddress, networkCidr, ParsedPrefix, parsePrefix, prefixContains } from './ipPrefix';

// ---------------------------------------------------------------- NAT

/** One NAT row shown as itself. */
export interface NatRuleView {
    kind: 'rule';
    key: string;
    rule: NATRow;
}

/**
 * Plain SNAT rows sharing an external IP and gateway port, folded into one
 * row: the usual ovn-kubernetes shape of one rule per pod on a gateway
 * router, all translating to the node IP.
 */
export interface NatGroupView {
    kind: 'group';
    key: string;
    type: 'snat';
    externalIp: string;
    gatewayPort?: string;
    rules: NATRow[];
    /** The logical IPs, in numeric order. */
    logicalIps: string[];
    /** The narrowest known subnet holding every logical IP, when one does. */
    coveringSubnet?: string;
    /** Distinct SNAT source port ranges across the group, with how many rows
     * carry each; rows without one are not counted. */
    portRanges: Array<{ range: string; count: number }>;
}

export type NatView = NatRuleView | NatGroupView;

/**
 * A row folds into a group only when nothing about it but its logical IP
 * (and its source port range, which the group reports) sets it apart: SNAT
 * of a single address with no match, priority or logical port. dnat and dnat_and_snat rows never fold — they are
 * rare and each one means something (an EgressIP, a floating address).
 */
export const isFoldableNat = (nat: NATRow): boolean =>
    nat.type === 'snat' &&
    !nat.match &&
    !nat.priority &&
    !nat.logicalPort &&
    nat.externalIp != null &&
    nat.logicalIp != null &&
    isHostAddress(nat.logicalIp);

const TYPE_ORDER: Record<NATType, number> = { dnat_and_snat: 0, dnat: 1, snat: 2 };

const compareNatRules = (a: NATRow, b: NATRow): number =>
    TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
    comparePrefixes(a.externalIp ?? '', b.externalIp ?? '') ||
    comparePrefixes(a.logicalIp ?? '', b.logicalIp ?? '') ||
    a.uuid.localeCompare(b.uuid);

const portRangeCounts = (rules: NATRow[]): Array<{ range: string; count: number }> => {
    const counts = new Map<string, number>();
    for (const rule of rules) {
        if (rule.externalPortRange) counts.set(rule.externalPortRange, (counts.get(rule.externalPortRange) ?? 0) + 1);
    }
    return [...counts].map(([range, count]) => ({ range, count })).sort((a, b) => b.count - a.count || a.range.localeCompare(b.range));
};

/**
 * Group a router's NAT rows. Foldable SNAT rows sharing (external IP,
 * gateway port) are split further by the narrowest known subnet holding
 * their logical IP, so the node's pods fold together while the gateway
 * router's own join address (SNAT of 100.64.0.x, a different intent) stays
 * apart. Each part with at least two rows becomes a group naming that
 * subnet; everything else stays a row of its own. Groups come first,
 * largest first, then single rows: dnat_and_snat, dnat, snat.
 *
 * `subnets` are candidate subnets: the zone's router port networks.
 */
export const groupNatRules = (nats: NATRow[], subnets: string[] = []): NatView[] => {
    const parsedSubnets = subnets
        .map(parsePrefix)
        .filter((subnet): subnet is ParsedPrefix => subnet !== null);
    const narrowestSubnet = (address: string): string => {
        const parsed = parsePrefix(address);
        if (!parsed) return '';
        let best: ParsedPrefix | undefined;
        for (const subnet of parsedSubnets) {
            if (prefixContains(subnet, parsed) && (!best || subnet.length > best.length)) best = subnet;
        }
        return best ? networkCidr(best) : '';
    };

    const buckets = new Map<string, { subnet: string; rules: NATRow[] }>();
    const singles: NATRow[] = [];
    for (const nat of nats) {
        if (!isFoldableNat(nat)) {
            singles.push(nat);
            continue;
        }
        const subnet = narrowestSubnet(nat.logicalIp as string);
        const key = `${nat.externalIp}|${nat.gatewayPort ?? ''}|${subnet}`;
        const bucket = buckets.get(key);
        if (bucket) bucket.rules.push(nat);
        else buckets.set(key, { subnet, rules: [nat] });
    }

    const groups: NatGroupView[] = [];
    for (const [key, { subnet, rules }] of buckets) {
        if (rules.length < 2) {
            singles.push(...rules);
            continue;
        }
        const logicalIps = rules.map((rule) => rule.logicalIp as string).sort(comparePrefixes);
        groups.push({
            kind: 'group',
            key: `group:${key}`,
            type: 'snat',
            externalIp: rules[0].externalIp as string,
            gatewayPort: rules[0].gatewayPort,
            rules,
            logicalIps,
            coveringSubnet: subnet || undefined,
            portRanges: portRangeCounts(rules),
        });
    }
    groups.sort(
        (a, b) => b.rules.length - a.rules.length || comparePrefixes(a.externalIp, b.externalIp) ||
            (a.gatewayPort ?? '').localeCompare(b.gatewayPort ?? ''),
    );

    return [
        ...groups,
        ...singles.sort(compareNatRules).map((rule): NatRuleView => ({ kind: 'rule', key: rule.uuid, rule })),
    ];
};

/** Rule counts per NAT type, in display order, omitting types with none. */
export const natTypeCounts = (nats: NATRow[]): Array<{ type: NATType; count: number }> => {
    const counts = new Map<NATType, number>();
    for (const nat of nats) counts.set(nat.type, (counts.get(nat.type) ?? 0) + 1);
    return (Object.keys(TYPE_ORDER) as NATType[])
        .filter((type) => counts.has(type))
        .map((type) => ({ type, count: counts.get(type) as number }));
};

/** Subnets a NAT group can be described by: the zone's router port networks. */
export const candidateSubnets = (database: LogicalDatabase | null | undefined): string[] =>
    (database?.logicalRouterPorts ?? []).flatMap((port) => port.networks ?? []);

// ---------------------------------------------------- address ownership

/** A workload that owns an address on a switch port. */
export interface PodAddressOwner {
    namespace: string;
    pod: string;
    port: string;
}

/** The addresses a switch port claims: the IP part of `"mac ip [ip...]"`. */
const switchPortAddresses = (row: LogicalSwitchPortRow): string[] => {
    const entries = [...(row.addresses ?? []), ...(row.dynamicAddresses ? [row.dynamicAddresses] : [])];
    return entries.flatMap((entry) => entry.split(/\s+/).slice(1)).filter((token) => parsePrefix(token) !== null);
};

const hostKey = (address: string): string | undefined => {
    const parsed = parsePrefix(address);
    return parsed ? `${parsed.family}:${parsed.address.toString(16)}` : undefined;
};

/**
 * Pod-owned addresses in the zone's database, keyed so that `10.0.0.5` and
 * `10.0.0.5/24` match. An address claimed by more than one pod port (the
 * same IP on two networks) resolves to none: the owner is ambiguous.
 */
export const podAddressIndex = (
    database: LogicalDatabase | null | undefined,
): ((address: string) => PodAddressOwner | undefined) => {
    const owners = new Map<string, PodAddressOwner | null>();
    for (const row of database?.logicalSwitchPorts ?? []) {
        const port = classifySwitchPort(row);
        if (port.role !== 'pod-port' || !port.namespace || !port.pod) continue;
        for (const address of switchPortAddresses(row)) {
            const key = hostKey(address);
            if (!key) continue;
            owners.set(key, owners.has(key) ? null : { namespace: port.namespace, pod: port.pod, port: row.name });
        }
    }
    return (address) => {
        const key = hostKey(address);
        return key ? owners.get(key) ?? undefined : undefined;
    };
};

// ------------------------------------------------------- static routes

export type RoutePolicy = 'dst-ip' | 'src-ip';

export interface StaticRouteGroup {
    policy: RoutePolicy;
    routes: StaticRouteRow[];
}

/** OVN treats an unset policy as dst-ip. */
export const routePolicy = (route: StaticRouteRow): RoutePolicy =>
    route.policy === 'src-ip' ? 'src-ip' : 'dst-ip';

const compareRoutes = (a: StaticRouteRow, b: StaticRouteRow): number =>
    (a.routeTable ?? '').localeCompare(b.routeTable ?? '') ||
    Number(isDefaultPrefix(b.ipPrefix)) - Number(isDefaultPrefix(a.ipPrefix)) ||
    comparePrefixes(a.ipPrefix, b.ipPrefix) ||
    comparePrefixes(a.nexthop ?? '', b.nexthop ?? '') ||
    a.uuid.localeCompare(b.uuid);

/**
 * Static routes for display: dst-ip routes, then src-ip routes, each group
 * ordered by route table (main first), default route first, then prefix in
 * numeric order. Empty groups are omitted. This is a reading order, not a
 * statement of how OVN evaluates the routes.
 */
export const groupStaticRoutes = (routes: StaticRouteRow[]): StaticRouteGroup[] =>
    (['dst-ip', 'src-ip'] as RoutePolicy[])
        .map((policy) => ({
            policy,
            routes: routes.filter((route) => routePolicy(route) === policy).sort(compareRoutes),
        }))
        .filter((group) => group.routes.length > 0);

/** What a static route's next hop lands on, as far as the zone's database tells. */
export type NexthopTarget =
    /** Another router's port holds the next-hop address. */
    | { kind: 'router-port'; port: string; router?: string; via?: string }
    /** A remote (transit) port for another node's zone holds it. */
    | { kind: 'node'; node: string; port: string; via?: string }
    /** Some other switch port holds it. */
    | { kind: 'switch-port'; port: string; via?: string }
    /** No owner in the database, but one of this router's ports is on-link. */
    | { kind: 'on-link'; via: string };

export interface NexthopResolver {
    (route: StaticRouteRow): NexthopTarget | undefined;
}

/**
 * Resolve next hops for routes on the named router. The router's own ports
 * whose networks contain the next hop are the on-link ports; the owner is
 * searched for on the switch each on-link port attaches to (through the
 * switch's router-type port naming it in options:router-port), so an address
 * reused on another network's switch does not match. When no switch is found
 * for the port, the owner is searched across the database and used only
 * when unique.
 */
export const nexthopResolverFor = (
    database: LogicalDatabase | null | undefined,
    routerName: string,
): NexthopResolver => {
    if (!database) return () => undefined;
    const routerPortByUuid = new Map(database.logicalRouterPorts.map((port) => [port.uuid, port]));
    const routerPortByName = new Map(database.logicalRouterPorts.map((port) => [port.name, port]));
    const switchPortByUuid = new Map(database.logicalSwitchPorts.map((port) => [port.uuid, port]));
    const routerByPortUuid = new Map<string, string>();
    for (const router of database.logicalRouters) {
        for (const port of router.ports) routerByPortUuid.set(port, router.name);
    }
    const router = database.logicalRouters.find((row) => row.name === routerName);
    const ownPorts = (router?.ports ?? [])
        .map((uuid) => routerPortByUuid.get(uuid))
        .filter((port): port is LogicalRouterPortRow => port != null);

    // Router port name → member switch ports of the switch it attaches to.
    const switchMembersByRouterPort = new Map<string, LogicalSwitchPortRow[]>();
    for (const sw of database.logicalSwitches) {
        const members = sw.ports
            .map((uuid) => switchPortByUuid.get(uuid))
            .filter((port): port is LogicalSwitchPortRow => port != null);
        for (const member of members) {
            const routerPort = member.type === 'router' ? member.options?.['router-port'] : undefined;
            if (routerPort) switchMembersByRouterPort.set(routerPort, members);
        }
    }

    const holds = (addresses: string[], nexthop: ParsedPrefix): boolean =>
        addresses.some((address) => {
            const parsed = parsePrefix(address);
            return parsed != null && parsed.family === nexthop.family && parsed.address === nexthop.address;
        });

    const ownerAmong = (members: LogicalSwitchPortRow[], nexthop: ParsedPrefix, via?: string): NexthopTarget[] =>
        members.flatMap((member): NexthopTarget[] => {
            if (member.type === 'router') {
                const peerName = member.options?.['router-port'];
                const peer = peerName ? routerPortByName.get(peerName) : undefined;
                if (!peer || peer.name === via || !holds(peer.networks ?? [], nexthop)) return [];
                return [{ kind: 'router-port', port: peer.name, router: routerByPortUuid.get(peer.uuid), via }];
            }
            if (!holds(switchPortAddresses(member), nexthop)) return [];
            const classified = classifySwitchPort(member);
            const node = member.type === 'remote' ? member.externalIds?.['node'] ?? classified.node : undefined;
            return node
                ? [{ kind: 'node', node, port: member.name, via }]
                : [{ kind: 'switch-port', port: member.name, via }];
        });

    return (route) => {
        const nexthop = route.nexthop ? parsePrefix(route.nexthop) : null;
        if (!nexthop) return undefined;
        const onLink = ownPorts.filter(
            (port) =>
                (!route.outputPort || port.name === route.outputPort) &&
                (port.networks ?? []).some((network) => {
                    const subnet = parsePrefix(network);
                    return subnet != null && prefixContains(subnet, nexthop);
                }),
        );
        for (const port of onLink) {
            const members = switchMembersByRouterPort.get(port.name);
            if (!members) continue;
            const owners = ownerAmong(members, nexthop, port.name);
            if (owners.length === 1) return owners[0];
        }
        if (onLink.length === 0 || onLink.every((port) => !switchMembersByRouterPort.has(port.name))) {
            const owners = ownerAmong(database.logicalSwitchPorts, nexthop);
            if (owners.length === 1) return { ...owners[0], via: onLink[0]?.name } as NexthopTarget;
        }
        return onLink.length > 0 ? { kind: 'on-link', via: onLink[0].name } : undefined;
    };
};
