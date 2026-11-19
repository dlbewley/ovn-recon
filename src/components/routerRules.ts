/**
 * Logical router rules as the drawer presents them: NAT rows grouped by
 * intent and static routes ordered for reading, with addresses resolved to
 * what the zone's database says owns them. Pure functions over snapshot rows.
 */
import { LogicalDatabase, LogicalRouterPortRow, LogicalSwitchPortRow, NATRow, NATType, StaticRouteRow } from '../types';
import { classifyRouter, classifySwitch, classifySwitchPort, DEFAULT_NETWORK } from './logicalClassification';
import {
    comparePrefixes,
    formatAddress,
    isDefaultPrefix,
    isHostAddress,
    networkCidr,
    ParsedPrefix,
    parsePrefix,
    prefixContains,
} from './ipPrefix';
import {
    classifyMasqueradeAddress,
    MasqueradeClassification,
    MasqueradeSubnet,
    masqueradeSubnets,
    NODE_MASQUERADE_SUBNET_ANNOTATION,
} from './masqueradeIps';

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

/** The IP part of one `"mac ip [ip...]"` address entry of a switch port. */
export const portEntryAddresses = (entry: string): string[] =>
    entry.split(/\s+/).slice(1).filter((token) => parsePrefix(token) !== null);

/** The addresses a switch port claims. */
const switchPortAddresses = (row: LogicalSwitchPortRow): string[] =>
    [...(row.addresses ?? []), ...(row.dynamicAddresses ? [row.dynamicAddresses] : [])].flatMap(portEntryAddresses);

/** One key for an address however it is spelled, with or without its mask. */
export const hostKey = (address: string): string | undefined => {
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

// ---------------------------------------------------------- masquerade

/**
 * What a router's NAT rows and static routes mean in the light of the node
 * masquerade subnet (ovn-recon-2n6.2). A primary user-defined network's
 * gateway router SNATs its pod subnet, and its own join address, to the
 * network's masquerade IP; br-ex then rewrites that to the node address in an
 * OVS flow that is not in the northbound database.
 *
 * What OVN holds is the evidence (the NAT row's external IP, the rtoe- port's
 * networks, `physical_ip`); the masquerade offsets only name what it is.
 */
export interface RouterMasqueradeContext {
    /** The router's `k8s.ovn.org/network`. */
    network: string;
    /** The effective masquerade subnets, as the zone shows them. */
    subnets: MasqueradeSubnet[];
    /** The router's own join addresses: rtoj-/rtotr- port addresses and lb_force_snat_ip. */
    joinAddresses: ParsedPrefix[];
    /** The network's pod subnets: its logical switches' other_config subnet and ipv6_prefix. */
    podSubnets: ParsedPrefix[];
    /** Present on a gateway router of a user-defined network that SNATs to its masquerade IP. */
    egress?: MasqueradeEgress;
}

export interface MasqueradeEgress {
    /** The router's network. */
    network: string;
    /** The NAT external IP: the network's gateway router masquerade address. */
    masqueradeIp: string;
    networkId?: number;
    /** The node address br-ex rewrites the masquerade IP to, when the router shows it. */
    nodeIp?: string;
}

/** Why a NAT row's logical IP is there. */
export type NatLogicalIntent = 'pod-subnet' | 'join-address';

export const NAT_LOGICAL_INTENT_LABELS: Readonly<Record<NatLogicalIntent, string>> = {
    'pod-subnet': 'pod subnet',
    'join-address': "this router's join address",
};

const JOIN_PORT_PREFIXES = ['rtoj-', 'rtotr-'];
const EXTERNAL_PORT_PREFIX = 'rtoe-';

const sameAddress = (a: ParsedPrefix, b: ParsedPrefix): boolean => a.family === b.family && a.address === b.address;

const parsedAll = (texts: Array<string | undefined>): ParsedPrefix[] =>
    texts
        .map((text) => (text ? parsePrefix(text.trim()) : null))
        .filter((parsed): parsed is ParsedPrefix => parsed !== null);

const routerPortsOf = (database: LogicalDatabase, routerUuids: string[]): LogicalRouterPortRow[] => {
    const byUuid = new Map(database.logicalRouterPorts.map((port) => [port.uuid, port]));
    return routerUuids.map((uuid) => byUuid.get(uuid)).filter((port): port is LogicalRouterPortRow => port != null);
};

/**
 * The masquerade context of the named router; undefined when the database
 * does not hold it. Only a gateway router of a user-defined network whose NAT
 * external IP is a gateway router masquerade address gets an `egress`.
 */
export const routerMasqueradeContext = (
    database: LogicalDatabase | null | undefined,
    routerName: string | undefined,
): RouterMasqueradeContext | undefined => {
    const row = routerName ? database?.logicalRouters.find((router) => router.name === routerName) : undefined;
    if (!database || !row) return undefined;
    const router = classifyRouter(row);
    const subnets = masqueradeSubnets({ databases: [database] });
    const ports = routerPortsOf(database, row.ports);
    const forceSnat = row.options?.['lb_force_snat_ip'];
    const joinAddresses = [
        ...parsedAll(
            ports
                .filter((port) => JOIN_PORT_PREFIXES.some((prefix) => port.name.startsWith(prefix)))
                .flatMap((port) => port.networks ?? []),
        ),
        // 'router_ip' asks OVN for the port's own address; anything else lists addresses.
        ...parsedAll(forceSnat && forceSnat !== 'router_ip' ? forceSnat.split(/[\s,]+/) : []),
    ];
    const podSubnets = parsedAll(
        database.logicalSwitches
            .filter((sw) => classifySwitch(sw).network === router.network)
            .flatMap((sw) => [sw.otherConfig?.['subnet'], sw.otherConfig?.['ipv6_prefix']])
            .flatMap((text) => (text ? text.split(/\s+/) : [])),
    );

    let egress: MasqueradeEgress | undefined;
    if (router.role === 'gateway-router' && router.network !== DEFAULT_NETWORK) {
        const natByUuid = new Map(database.nats.map((nat) => [nat.uuid, nat]));
        for (const uuid of row.nat ?? []) {
            const external = natByUuid.get(uuid)?.externalIp;
            const classification = external ? classifyMasqueradeAddress(external, subnets) : undefined;
            if (classification?.role !== 'udn-gateway-router') continue;
            egress = {
                network: router.network,
                masqueradeIp: external as string,
                networkId: classification.networkId,
                nodeIp: nodeAddressOf(row.externalIds, ports, subnets, classification.family),
            };
            break;
        }
    }
    return { network: router.network, subnets, joinAddresses, podSubnets, ...(egress ? { egress } : {}) };
};

/**
 * The node address a gateway router sits on: the rtoe- port's network outside
 * the masquerade subnet, else external_ids physical_ip(s), of one family.
 */
const nodeAddressOf = (
    externalIds: Record<string, string> | undefined,
    ports: LogicalRouterPortRow[],
    subnets: MasqueradeSubnet[],
    family: 4 | 6,
): string | undefined => {
    const candidates = [
        ...parsedAll(ports.filter((port) => port.name.startsWith(EXTERNAL_PORT_PREFIX)).flatMap((port) => port.networks ?? [])),
        ...parsedAll([externalIds?.['physical_ip'], ...(externalIds?.['physical_ips'] ?? '').split(',')]),
    ];
    const node = candidates.find(
        (parsed) =>
            parsed.family === family &&
            !classifyMasqueradeAddress(formatAddress(parsed.family, parsed.address), subnets) &&
            !subnets.some((subnet) => prefixContains(subnet.prefix, parsed)),
    );
    return node ? formatAddress(node.family, node.address) : undefined;
};

/** Why a NAT row's logical IP is there, when the router's context says. */
export const natLogicalIntent = (
    nat: NATRow,
    context: RouterMasqueradeContext | undefined,
): NatLogicalIntent | undefined => {
    const logical = nat.logicalIp ? parsePrefix(nat.logicalIp) : null;
    if (!context || !logical) return undefined;
    const host = logical.length === (logical.family === 4 ? 32 : 128);
    if (host && context.joinAddresses.some((join) => sameAddress(join, logical))) return 'join-address';
    if (
        !host &&
        context.podSubnets.some(
            (subnet) => subnet.family === logical.family && (prefixContains(logical, subnet) || prefixContains(subnet, logical)),
        )
    ) {
        return 'pod-subnet';
    }
    return undefined;
};

/** What an address inside the masquerade subnet is for, as the router's zone shows the subnet. */
export const masqueradeRoleOf = (
    address: string | undefined,
    context: RouterMasqueradeContext | undefined,
): MasqueradeClassification | undefined =>
    (address && context ? classifyMasqueradeAddress(address, context.subnets) : undefined);

/**
 * Whether a static route goes to the masquerade subnet: marked so in its
 * external_ids, or naming exactly one of the effective subnets.
 */
export const isMasqueradeSubnetRoute = (route: StaticRouteRow, context: RouterMasqueradeContext | undefined): boolean => {
    if (route.externalIds?.[NODE_MASQUERADE_SUBNET_ANNOTATION] !== undefined) return true;
    const prefix = parsePrefix(route.ipPrefix);
    return (
        prefix != null &&
        (context?.subnets ?? []).some(
            (subnet) =>
                subnet.family === prefix.family &&
                subnet.prefix.network === prefix.network &&
                subnet.prefix.length === prefix.length,
        )
    );
};
