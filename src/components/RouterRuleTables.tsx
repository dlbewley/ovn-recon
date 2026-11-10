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
    NatGroupView,
    NatView,
    natTypeCounts,
    NexthopTarget,
    nexthopResolverFor,
    podAddressIndex,
    PodAddressOwner,
    routePolicy,
} from './routerRules';
import { getResourcePath } from '../topology/links';

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
    <Link to={getResourcePath({ apiVersion: 'v1', kind: 'Pod', namespace: owner.namespace, name: owner.pod })}>
        {owner.namespace}/{owner.pod}
    </Link>
);

/** True when every row of the group carries the same source port range (or none does). */
const uniformPortRange = (group: NatGroupView): boolean =>
    group.portRanges.length === 0 || (group.portRanges.length === 1 && group.portRanges[0].count === group.rules.length);

/**
 * A NAT group's logical IPs, each with the pod that owns it when known, and
 * its source port range when the group's rows differ in that.
 */
const NatGroupAddresses: React.FC<{
    group: NatGroupView;
    ownerOf: (address: string) => PodAddressOwner | undefined;
}> = ({ group, ownerOf }) => {
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
                const owner = ownerOf(ip);
                const range = rangeByIp.get(ip);
                return (
                    <React.Fragment key={ip}>
                        <code>{ip}</code>
                        {showRanges && <span>{range ? <code>{range}</code> : DASH}</span>}
                        <span>{owner ? <PodRef owner={owner} /> : DASH}</span>
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

const natField = (view: NatView, field: keyof NATRow): string | number | undefined =>
    view.kind === 'rule' ? (view.rule[field] as string | number | undefined) : undefined;

export interface NatRuleTableProps {
    nats: NATRow[];
    database?: LogicalDatabase | null;
    /** Resolve NAT.gateway_port (a Logical_Router_Port uuid) to its name. */
    gatewayPortName?: (uuid: string) => string | undefined;
}

/**
 * A router's NAT rules grouped by intent: plain per-address SNAT rows that
 * share an external IP fold into one expandable row listing the addresses
 * and their pods; dnat and dnat_and_snat rows stay rows of their own.
 */
export const NatRuleTable: React.FC<NatRuleTableProps> = ({ nats, database, gatewayPortName }) => {
    const views = React.useMemo(() => groupNatRules(nats, candidateSubnets(database)), [nats, database]);
    const ownerOf = React.useMemo(() => podAddressIndex(database), [database]);
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
            cell: (view) => <code>{externalOf(view) || '—'}</code>,
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
                const owner = logicalIp && !logicalPort ? ownerOf(logicalIp) : undefined;
                return (
                    <>
                        <code>{logicalIp ?? '—'}</code>
                        {logicalPort && <div style={SUBTLE}>port <code>{logicalPort}</code></div>}
                        {owner && <div><PodRef owner={owner} /></div>}
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

    return (
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
                view.kind === 'group' ? <NatGroupAddresses group={view} ownerOf={ownerOf} /> : undefined
            }
        />
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

export interface StaticRouteTableProps {
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
export const StaticRouteTable: React.FC<StaticRouteTableProps> = ({ routes, routerName, database, nodeHref }) => {
    const ordered = React.useMemo(() => groupStaticRoutes(routes).flatMap((group) => group.routes), [routes]);
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
                </>
            ),
            compare: (a, b) => comparePrefixes(a.ipPrefix, b.ipPrefix),
        },
        {
            key: 'nexthop',
            title: 'Next hop',
            cell: (route) => {
                const target = resolve(route);
                return (
                    <>
                        <code>{route.nexthop || '—'}</code>
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
        />
    );
};
