import * as React from 'react';
import { Link } from 'react-router';
import { Label } from '@patternfly/react-core';

import { LogicalDatabase, NATRow, NATType, StaticRouteRow } from '../types';
import { comparePrefixes, isDefaultPrefix } from './ipPrefix';
import RuleTable, { RuleColumn } from './RuleTable';
import {
    candidateSubnets,
    groupNatRules,
    groupStaticRoutes,
    isMasqueradeSubnetRoute,
    masqueradeRoleOf,
    NAT_LOGICAL_INTENT_LABELS,
    NatGroupView,
    NatLogicalIntent,
    natLogicalIntent,
    NatView,
    natTypeCounts,
    NexthopTarget,
    nexthopResolverFor,
    PodAddressOwner,
    RouterMasqueradeContext,
    routerMasqueradeContext,
    routePolicy,
} from './routerRules';
import { AddressOwner, addressBookForDatabase, addressOwnerTarget, resolveAddress } from './addressBook';
import AddressOwners from './AddressOwners';
import { ConsoleLink, PodLink } from '../linkOut/LinkOut';
import { networkDisplayName } from './LogicalLadderView';
import { isUdnMasqueradeRole, MASQUERADE_ROLE_LABELS, MasqueradeClassification } from './masqueradeIps';

const SUBTLE: React.CSSProperties = { color: 'var(--pf-t--global--text--color--subtle)' };
const DASH = <span style={SUBTLE}>—</span>;

export const NAT_TYPE_LABELS: Record<NATType, string> = {
    snat: 'SNAT',
    dnat: 'DNAT',
    dnat_and_snat: 'DNAT+SNAT',
};

const TYPE_COLORS: Record<NATType, 'blue' | 'purple' | 'orange'> = {
    snat: 'blue',
    dnat_and_snat: 'purple',
    dnat: 'orange',
};

const PodRef: React.FC<{ owner: PodAddressOwner }> = ({ owner }) => (
    <PodLink namespace={owner.namespace} pod={owner.pod} />
);

/** A pod owner through PodRef, so a NAT row names every pod the same way. */
const renderNatOwner = (owner: AddressOwner): React.ReactNode | undefined => {
    if (owner.kind !== 'pod' || owner.ref.type !== 'resource' || !owner.ref.resource.namespace) return undefined;
    const { namespace, name } = owner.ref.resource;
    return <PodRef owner={{ namespace, pod: name, port: owner.provenance[0].record }} />;
};

/** True when every row of the group carries the same source port range (or none does). */
const uniformPortRange = (group: NatGroupView): boolean =>
    group.portRanges.length === 0 || (group.portRanges.length === 1 && group.portRanges[0].count === group.rules.length);

/**
 * A NAT group's logical IPs, each with whoever owns it when known, and
 * its source port range when the group's rows differ in that.
 */
const NatGroupAddresses: React.FC<{
    group: NatGroupView;
    ownersOf: (address: string) => readonly AddressOwner[];
}> = ({ group, ownersOf }) => {
    const showRanges = !uniformPortRange(group);
    const rangeByIp = new Map(group.rules.map((rule) => [rule.logicalIp, rule.externalPortRange]));
    return (
        <div
            style={{
                display: 'grid',
                gridTemplateColumns: showRanges ? 'max-content max-content 1fr' : 'max-content 1fr',
                columnGap: '1rem',
                rowGap: '0.125rem',
            }}
            data-testid="nat-group-addresses"
        >
            {group.logicalIps.map((ip) => {
                const owners = ownersOf(ip);
                const range = rangeByIp.get(ip);
                return (
                    <React.Fragment key={ip}>
                        <code>{ip}</code>
                        {showRanges && <span>{range ? <code>{range}</code> : DASH}</span>}
                        <span>
                            {owners.length > 0
                                ? <AddressOwners address={ip} owners={owners} renderOwner={renderNatOwner} />
                                : DASH}
                        </span>
                    </React.Fragment>
                );
            })}
        </div>
    );
};

/** A group's port range cell: the range when uniform, else each with its share. */
const GroupPortRanges: React.FC<{ group: NatGroupView }> = ({ group }) => {
    if (group.portRanges.length === 0) return DASH;
    if (uniformPortRange(group)) return <code>{group.portRanges[0].range}</code>;
    return (
        <>
            {group.portRanges.map(({ range, count }) => (
                <div key={range}>
                    <code>{range}</code> <span style={SUBTLE}>({count} of {group.rules.length})</span>
                </div>
            ))}
        </>
    );
};

/** The network an owner names, linked to its network scope. */
const NetworkName: React.FC<{ owner: AddressOwner }> = ({ owner }) => (
    <ConsoleLink target={addressOwnerTarget(owner)}>{networkDisplayName(owner.network as string)}</ConsoleLink>
);

/**
 * Under a NAT external IP in the masquerade subnet: "masquerade IP of
 * example-p-cudn (network ID 3)", or the global role it has.
 */
const MasqueradeExternalNote: React.FC<{ owner: AddressOwner }> = ({ owner }) => {
    const detail = owner.masquerade;
    if (!detail) return null;
    if (!isUdnMasqueradeRole(detail.role)) {
        return <span style={{ ...SUBTLE, display: 'block' }} data-testid="nat-masquerade-owner">{MASQUERADE_ROLE_LABELS[detail.role]}</span>;
    }
    const id = detail.networkId !== undefined ? `network ID ${detail.networkId}` : undefined;
    return (
        <span style={{ ...SUBTLE, display: 'block' }} data-testid="nat-masquerade-owner">
            {detail.role === 'udn-gateway-router' ? 'masquerade IP' : 'management port masquerade IP'} of{' '}
            {owner.network ? <><NetworkName owner={owner} />{id && ` (${id})`}</> : id ?? 'an unknown network'}
        </span>
    );
};

/** A masquerade address's role in a few words, with the network ID of a pair. */
export const masqueradeRoleText = (classification: MasqueradeClassification): string =>
    isUdnMasqueradeRole(classification.role)
        ? `${MASQUERADE_ROLE_LABELS[classification.role]} (network ID ${classification.networkId})`
        : MASQUERADE_ROLE_LABELS[classification.role];

/** The text a filter matches beside a NAT row's own fields. */
const natAnnotationTerms = (
    nat: NATRow,
    context: RouterMasqueradeContext | undefined,
    masqueradeOwnerOf: (address: string) => AddressOwner | undefined,
): string[] => {
    const terms: string[] = [];
    const owner = nat.externalIp ? masqueradeOwnerOf(nat.externalIp) : undefined;
    if (owner) {
        terms.push('masquerade', owner.label);
        if (owner.network) terms.push(owner.network, networkDisplayName(owner.network));
    }
    const intent = context?.egress ? natLogicalIntent(nat, context) : undefined;
    if (intent && context) {
        terms.push(NAT_LOGICAL_INTENT_LABELS[intent], 'masquerade', context.network, networkDisplayName(context.network));
    }
    return terms;
};

const natField = (view: NatView, field: keyof NATRow): string | number | undefined =>
    view.kind === 'rule' ? (view.rule[field] as string | number | undefined) : undefined;

/** Options the construct detail page sets on the router tables; the drawer
 * leaves them unset (or sets only openAll). */
export interface RuleTablePageOptions {
    /** Show only rules whose text contains this (case-insensitive). */
    query?: string;
    /** Link to the detail page's Routes and NAT tab. */
    openAll?: { href: string; count: number };
    pageSize?: number;
    perPageOptions?: number[];
}

export interface NatRuleTableProps extends RuleTablePageOptions {
    nats: NATRow[];
    database?: LogicalDatabase | null;
    /** The node `database` came from, for links to what owns an address. */
    databaseNode?: string;
    /**
     * The router's network: a logical IP belongs to it, so an owner on another
     * network that happens to use the same address is not this rule's.
     */
    network?: string;
    /** Resolve NAT.gateway_port (a Logical_Router_Port uuid) to its name. */
    gatewayPortName?: (uuid: string) => string | undefined;
    /** Fold per-address SNAT rows into groups (default); false lists one row per rule. */
    grouped?: boolean;
    /** Extra toolbar items above the table (the page's grouping switch). */
    toolbarItems?: React.ReactNode;
    /** The router's OVN name, to read its ports and options in `database`. */
    routerName?: string;
    /**
     * Above the table, on a user-defined network's gateway router that SNATs to
     * its masquerade IP, one line on the second SNAT br-ex does. The page sets
     * it; the drawer does not.
     */
    explainEgress?: boolean;
}

const queryMatches = (query: string | undefined, values: Array<string | number | undefined>): boolean => {
    const needle = query?.trim().toLowerCase();
    if (!needle) return true;
    return values.some((value) => value !== undefined && String(value).toLowerCase().includes(needle));
};

/** Whether a NAT rule's text contains the query. */
export const natRuleMatches = (
    nat: NATRow,
    query: string | undefined,
    gatewayPortName?: (uuid: string) => string | undefined,
    extraTerms: readonly string[] = [],
): boolean =>
    queryMatches(query, [
        ...extraTerms,
        NAT_TYPE_LABELS[nat.type],
        nat.type,
        nat.externalIp,
        nat.logicalIp,
        nat.logicalPort,
        nat.match,
        nat.externalPortRange,
        nat.gatewayPort ? gatewayPortName?.(nat.gatewayPort) ?? nat.gatewayPort : undefined,
    ]);

/** Whether a static route's text contains the query. */
export const staticRouteMatches = (
    route: StaticRouteRow,
    query: string | undefined,
    extraTerms: readonly string[] = [],
): boolean =>
    queryMatches(query, [...extraTerms, route.ipPrefix, route.nexthop, route.outputPort, routePolicy(route), route.routeTable]);

/** The text a filter matches beside a static route's own fields. */
const routeAnnotationTerms = (route: StaticRouteRow, context: RouterMasqueradeContext | undefined): string[] => {
    const terms: string[] = [];
    if (isMasqueradeSubnetRoute(route, context)) terms.push('masquerade subnet');
    const role = masqueradeRoleOf(route.nexthop, context);
    if (role) terms.push('masquerade', masqueradeRoleText(role));
    return terms;
};

/**
 * One line on what the NAT table cannot show: br-ex SNATs the masquerade IP
 * to the node address in an OVS flow.
 */
const MasqueradeEgressLine: React.FC<{ context: RouterMasqueradeContext; owner?: AddressOwner }> = ({ context, owner }) => {
    const { egress } = context;
    if (!egress) return null;
    const network = owner?.network === egress.network
        ? <NetworkName owner={owner} />
        : networkDisplayName(egress.network);
    return (
        <p className="pf-u-mb-sm" data-testid="nat-masquerade-egress">
            Egress from {network} leaves OVN as <code>{egress.masqueradeIp}</code>; br-ex then rewrites it to the node
            address{egress.nodeIp ? <> <code>{egress.nodeIp}</code></> : ''}. That second step is an OVS flow and is not
            listed here.{' '}
            <span data-testid="nat-masquerade-egress-ip-caveat">
                Pods an EgressIP selects leave as its egress IP instead
                {egress.egressIps?.length ? (
                    <>
                        {' '}
                        (on this router:{' '}
                        {egress.egressIps.map((address, index) => (
                            <React.Fragment key={address}>
                                {index > 0 && ', '}
                                <code>{address}</code>
                            </React.Fragment>
                        ))}
                        )
                    </>
                ) : (
                    ', from whichever node holds it'
                )}
                .
            </span>
        </p>
    );
};

/**
 * A router's NAT rules grouped by intent: plain per-address SNAT rows that
 * share an external IP fold into one expandable row listing the addresses
 * and their pods; dnat and dnat_and_snat rows stay rows of their own.
 */
export const NatRuleTable: React.FC<NatRuleTableProps> = ({
    nats: allNats,
    database,
    databaseNode,
    network,
    gatewayPortName,
    grouped = true,
    query,
    openAll,
    pageSize,
    perPageOptions,
    toolbarItems,
    routerName,
    explainEgress,
}) => {
    const context = React.useMemo(() => routerMasqueradeContext(database, routerName), [database, routerName]);
    const ownersOf = React.useMemo(() => {
        const book = addressBookForDatabase(database, databaseNode);
        return (address: string): readonly AddressOwner[] => (book ? resolveAddress(book, address, { network }) : []);
    }, [database, databaseNode, network]);
    const masqueradeOwnerOf = React.useCallback(
        (address: string): AddressOwner | undefined => ownersOf(address).find((owner) => owner.kind === 'masquerade'),
        [ownersOf],
    );
    // A row's intent is named only where the router SNATs to a masquerade IP:
    // elsewhere (the default network's gateway router) the rows stay as they were.
    const intentOf = (nat: NATRow): NatLogicalIntent | undefined =>
        (context?.egress ? natLogicalIntent(nat, context) : undefined);
    const nats = React.useMemo(
        () =>
            query
                ? allNats.filter((nat) =>
                    natRuleMatches(nat, query, gatewayPortName, natAnnotationTerms(nat, context, masqueradeOwnerOf)))
                : allNats,
        [allNats, query, gatewayPortName, context, masqueradeOwnerOf],
    );
    const views = React.useMemo<NatView[]>(
        () =>
            grouped
                ? groupNatRules(nats, candidateSubnets(database))
                : nats.map((rule) => ({ kind: 'rule', key: rule.uuid, rule })),
        [nats, database, grouped],
    );
    const counts = natTypeCounts(nats);

    const portName = (uuid?: string) => (uuid ? gatewayPortName?.(uuid) ?? uuid : undefined);
    const typeOf = (view: NatView): NATType => (view.kind === 'group' ? view.type : view.rule.type);
    const externalOf = (view: NatView): string => (view.kind === 'group' ? view.externalIp : view.rule.externalIp ?? '');
    const logicalOf = (view: NatView): string =>
        view.kind === 'group' ? view.coveringSubnet ?? view.logicalIps[0] : view.rule.logicalIp ?? '';
    const gatewayOf = (view: NatView): string | undefined =>
        portName(view.kind === 'group' ? view.gatewayPort : view.rule.gatewayPort);

    const columns: RuleColumn<NatView>[] = [
        {
            key: 'type',
            title: 'Type',
            cell: (view) => <Label isCompact color={TYPE_COLORS[typeOf(view)]}>{NAT_TYPE_LABELS[typeOf(view)]}</Label>,
            sortValue: (view) => typeOf(view),
        },
        {
            key: 'external',
            title: 'External IP',
            cell: (view) => {
                const external = externalOf(view);
                const owner = external ? masqueradeOwnerOf(external) : undefined;
                return (
                    <>
                        <code>{external || '—'}</code>
                        {owner && <MasqueradeExternalNote owner={owner} />}
                    </>
                );
            },
            compare: (a, b) => comparePrefixes(externalOf(a), externalOf(b)),
        },
        {
            key: 'logical',
            title: 'Logical IP',
            cell: (view) => {
                if (view.kind === 'group') {
                    return (
                        <span data-testid="nat-group-logical">
                            {view.rules.length} logical IPs
                            {view.coveringSubnet && (
                                <>
                                    {' '}in <code>{view.coveringSubnet}</code>
                                </>
                            )}
                        </span>
                    );
                }
                const { logicalIp, logicalPort } = view.rule;
                const intent = intentOf(view.rule);
                return (
                    <>
                        <code>{logicalIp ?? '—'}</code>
                        {logicalPort && <div style={SUBTLE}>port <code>{logicalPort}</code></div>}
                        {intent && context && (
                            <span style={{ ...SUBTLE, display: 'block' }} data-testid="nat-logical-intent">
                                {intent === 'pod-subnet'
                                    ? <>pod subnet of {networkDisplayName(context.network)}</>
                                    : NAT_LOGICAL_INTENT_LABELS[intent]}
                            </span>
                        )}
                        {logicalIp && !logicalPort && !intent && (
                            <AddressOwners address={logicalIp} owners={ownersOf(logicalIp)} renderOwner={renderNatOwner} />
                        )}
                    </>
                );
            },
            compare: (a, b) => comparePrefixes(logicalOf(a), logicalOf(b)),
        },
    ];
    if (nats.some((nat) => nat.match)) {
        columns.push({
            key: 'match',
            title: 'Match',
            cell: (view) => (natField(view, 'match') ? <code>{natField(view, 'match')}</code> : DASH),
            sortValue: (view) => String(natField(view, 'match') ?? ''),
        });
    }
    if (nats.some((nat) => nat.priority)) {
        columns.push({
            key: 'priority',
            title: 'Priority',
            cell: (view) => natField(view, 'priority') ?? DASH,
            sortValue: (view) => Number(natField(view, 'priority') ?? 0),
        });
    }
    if (nats.some((nat) => nat.externalPortRange)) {
        columns.push({
            key: 'ports',
            title: 'Port range',
            cell: (view) =>
                view.kind === 'group' ? (
                    <GroupPortRanges group={view} />
                ) : view.rule.externalPortRange ? (
                    <code>{view.rule.externalPortRange}</code>
                ) : (
                    DASH
                ),
        });
    }
    if (nats.some((nat) => nat.gatewayPort)) {
        columns.push({
            key: 'gateway',
            title: 'Gateway port',
            cell: (view) => (gatewayOf(view) ? <code>{gatewayOf(view)}</code> : DASH),
            sortValue: (view) => gatewayOf(view) ?? '',
        });
    }

    const egressOwner = context?.egress ? masqueradeOwnerOf(context.egress.masqueradeIp) : undefined;
    return (
        <>
        {explainEgress && context?.egress && <MasqueradeEgressLine context={context} owner={egressOwner} />}
        <RuleTable
            ariaLabel="NAT rules"
            columns={columns}
            rows={views}
            rowKey={(view) => view.key}
            summary={
                <span data-testid="nat-type-counts">
                    {counts.map(({ type, count }, index) => (
                        <React.Fragment key={type}>
                            {index > 0 && ' '}
                            <Label isCompact color={TYPE_COLORS[type]}>{`${NAT_TYPE_LABELS[type]} ${count}`}</Label>
                        </React.Fragment>
                    ))}
                </span>
            }
            expandedContent={(view) =>
                view.kind === 'group' ? <NatGroupAddresses group={view} ownersOf={ownersOf} /> : undefined
            }
            openAll={openAll}
            pageSize={pageSize}
            perPageOptions={perPageOptions}
            toolbarItems={toolbarItems}
            emptyMessage={{ none: 'No NAT rules.', noMatch: 'No NAT rules match.' }}
        />
        </>
    );
};

/** "→ rtoj-GR_cnv-1 (GR_cnv-1)", "→ node ctrl-3", "on-link via rtoe-GR_cnv-1". */
const NexthopNote: React.FC<{ target: NexthopTarget; nodeHref?: (node: string) => string }> = ({
    target,
    nodeHref,
}) => {
    switch (target.kind) {
        case 'router-port':
            return (
                <div style={SUBTLE}>
                    → <code>{target.port}</code>
                    {target.router && <> ({target.router})</>}
                </div>
            );
        case 'node':
            return (
                <div style={SUBTLE}>
                    → node {nodeHref ? <Link to={nodeHref(target.node)}>{target.node}</Link> : target.node}
                </div>
            );
        case 'switch-port':
            return <div style={SUBTLE}>→ <code>{target.port}</code></div>;
        case 'on-link':
            return <div style={SUBTLE}>on-link via <code>{target.via}</code></div>;
    }
};

/** Route flags as compact chips: BFD and ECMP selection fields. */
const routeFlags = (route: StaticRouteRow): string[] => [
    ...(route.bfd ? ['BFD'] : []),
    ...(route.selectionFields && route.selectionFields.length > 0
        ? [`ECMP ${route.selectionFields.join(',')}`]
        : []),
];

export interface StaticRouteTableProps extends RuleTablePageOptions {
    routes: StaticRouteRow[];
    /** The router's OVN name, to find its ports in `database`. */
    routerName: string;
    database?: LogicalDatabase | null;
    nodeHref?: (node: string) => string;
}

/**
 * A router's static routes as a table: dst-ip routes then src-ip routes,
 * default route first within each, next hops annotated with the router port
 * or node they land on when the zone's database can tell.
 */
export const StaticRouteTable: React.FC<StaticRouteTableProps> = ({
    routes,
    routerName,
    database,
    nodeHref,
    query,
    openAll,
    pageSize,
    perPageOptions,
}) => {
    const context = React.useMemo(() => routerMasqueradeContext(database, routerName), [database, routerName]);
    const ordered = React.useMemo(
        () =>
            groupStaticRoutes(routes)
                .flatMap((group) => group.routes)
                .filter((route) => staticRouteMatches(route, query, routeAnnotationTerms(route, context))),
        [routes, query, context],
    );
    const resolve = React.useMemo(() => nexthopResolverFor(database, routerName), [database, routerName]);
    const defaults = routes.filter((route) => isDefaultPrefix(route.ipPrefix)).length;
    const sourceRoutes = routes.filter((route) => routePolicy(route) === 'src-ip').length;

    const columns: RuleColumn<StaticRouteRow>[] = [
        {
            key: 'prefix',
            title: 'Prefix',
            cell: (route) => (
                <>
                    <code>{route.ipPrefix}</code>
                    {isDefaultPrefix(route.ipPrefix) && (
                        <>
                            {' '}
                            <Label isCompact color="blue">default</Label>
                        </>
                    )}
                    {isMasqueradeSubnetRoute(route, context) && (
                        <>
                            {' '}
                            <Label isCompact color="teal" data-testid="masquerade-subnet-route">masquerade subnet</Label>
                        </>
                    )}
                </>
            ),
            compare: (a, b) => comparePrefixes(a.ipPrefix, b.ipPrefix),
        },
        {
            key: 'nexthop',
            title: 'Next hop',
            cell: (route) => {
                const target = resolve(route);
                const role = masqueradeRoleOf(route.nexthop, context);
                return (
                    <>
                        <code>{route.nexthop || '—'}</code>
                        {role && <div style={SUBTLE} data-testid="nexthop-masquerade-role">{masqueradeRoleText(role)}</div>}
                        {target && <NexthopNote target={target} nodeHref={nodeHref} />}
                    </>
                );
            },
            compare: (a, b) => comparePrefixes(a.nexthop ?? '', b.nexthop ?? ''),
        },
    ];
    if (routes.some((route) => route.outputPort)) {
        columns.push({
            key: 'output',
            title: 'Output port',
            cell: (route) => (route.outputPort ? <code>{route.outputPort}</code> : DASH),
            sortValue: (route) => route.outputPort ?? '',
        });
    }
    columns.push({
        key: 'policy',
        title: 'Policy',
        cell: (route) => routePolicy(route),
        sortValue: (route) => routePolicy(route),
    });
    if (routes.some((route) => route.routeTable)) {
        columns.push({
            key: 'table',
            title: 'Route table',
            cell: (route) => (route.routeTable ? <code>{route.routeTable}</code> : <span style={SUBTLE}>main</span>),
            sortValue: (route) => route.routeTable ?? '',
        });
    }
    if (routes.some((route) => routeFlags(route).length > 0)) {
        columns.push({
            key: 'flags',
            title: 'Flags',
            cell: (route) => {
                const flags = routeFlags(route);
                return flags.length === 0
                    ? DASH
                    : flags.map((flag) => (
                        <Label key={flag} isCompact className="pf-u-mr-xs">{flag}</Label>
                    ));
            },
        });
    }

    const summaryParts = [`${routes.length} route${routes.length === 1 ? '' : 's'}`];
    if (defaults > 0) summaryParts.push(`${defaults} default`);
    if (sourceRoutes > 0) summaryParts.push(`${sourceRoutes} src-ip`);

    return (
        <RuleTable
            ariaLabel="Static routes"
            columns={columns}
            rows={ordered}
            rowKey={(route) => route.uuid}
            summary={<span data-testid="static-route-summary">{summaryParts.join(' · ')}</span>}
            openAll={openAll}
            pageSize={pageSize}
            perPageOptions={perPageOptions}
            emptyMessage={{ none: 'No static routes.', noMatch: 'No static routes match.' }}
        />
    );
};
