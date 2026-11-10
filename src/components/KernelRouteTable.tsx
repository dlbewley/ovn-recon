import * as React from 'react';
import { Button, Label } from '@patternfly/react-core';

import { comparePrefixes } from './ipPrefix';
import {
    buildKernelRouteTables,
    KernelNextHop,
    KernelRouteRow,
    kernelRouteSummary,
    kernelTableLabel,
    routeTablesVia,
} from './kernelRoutes';
import type { NnsRoute } from './nodeVisualizationSelectors';
import RuleTable, { RuleColumn } from './RuleTable';

const SUBTLE: React.CSSProperties = { color: 'var(--pf-t--global--text--color--subtle)' };
const DASH = <span style={SUBTLE}>—</span>;

/**
 * Turns an interface name into a click handler that selects it in the graph,
 * or undefined when the graph does not draw that interface.
 */
export type InterfaceSelector = (name: string) => (() => void) | undefined;

const InterfaceName: React.FC<{ name?: string; select?: InterfaceSelector }> = ({ name, select }) => {
    if (!name) return DASH;
    const onClick = select?.(name);
    return onClick ? (
        <Button variant="link" isInline onClick={onClick}>
            {name}
        </Button>
    ) : (
        <code>{name}</code>
    );
};

/** "on-link" where the router tables say it too (RouterRuleTables.tsx). */
const Gateway: React.FC<{ hop: KernelNextHop }> = ({ hop }) => (
    <>
        {hop.gateway ? <code>{hop.gateway}</code> : <span style={SUBTLE}>on-link</span>}
        {hop.weight !== undefined && <span style={SUBTLE}> weight {hop.weight}</span>}
    </>
);

const Destination: React.FC<{ row: KernelRouteRow }> = ({ row }) => (
    <>
        <code>{row.destination}</code>
        {row.isDefault && (
            <>
                {' '}
                <Label isCompact color="blue">default</Label>
            </>
        )}
        {row.nextHops.length > 1 && (
            <>
                {' '}
                <Label isCompact title={`${row.nextHops.length} next hops at one metric`}>ECMP</Label>
            </>
        )}
        {row.preferred && (
            <>
                {' '}
                <Label isCompact color="green">in use</Label>
                <div style={SUBTLE} data-testid="kernel-route-preferred">
                    lowest metric of {row.preferred.among} {row.family === 6 ? 'IPv6' : 'IPv4'} default routes
                </div>
            </>
        )}
    </>
);

/** One line per next hop, so the Gateway and Interface cells line up. */
const perHop = (row: KernelRouteRow, render: (hop: KernelNextHop) => React.ReactNode): React.ReactNode =>
    row.nextHops.length === 1
        ? render(row.nextHops[0])
        : row.nextHops.map((hop, index) => <div key={index}>{render(hop)}</div>);

export interface KernelRouteTableProps {
    routes: NnsRoute[];
    /** Show only routes with a next hop through this device. */
    viaInterface?: string;
    selectInterface?: InterfaceSelector;
    ariaLabel?: string;
}

/**
 * Kernel routes from NodeNetworkState as tables (ovn-recon-dp7.2): one per
 * kernel table, each summarised with its id, default routes pinned first,
 * then longest prefix first. Columns without a value in any row are left out.
 */
export const KernelRouteTable: React.FC<KernelRouteTableProps> = ({
    routes,
    viaInterface,
    selectInterface,
    ariaLabel = 'Kernel routes',
}) => {
    const groups = React.useMemo(() => {
        const all = buildKernelRouteTables(routes);
        return viaInterface ? routeTablesVia(all, viaInterface) : all;
    }, [routes, viaInterface]);
    const rows = groups.flatMap((group) => group.rows);

    // Decided across every table shown, so grouped tables share their columns.
    const showInterface =
        !viaInterface || rows.some((row) => row.nextHops.some((hop) => hop.interface !== viaInterface));
    const columns: RuleColumn<KernelRouteRow>[] = [
        {
            key: 'destination',
            title: 'Destination',
            cell: (row) => <Destination row={row} />,
            compare: (a, b) => comparePrefixes(a.destination, b.destination),
        },
        {
            key: 'gateway',
            title: 'Gateway',
            cell: (row) => perHop(row, (hop) => <Gateway hop={hop} />),
            compare: (a, b) => comparePrefixes(a.nextHops[0]?.gateway ?? '', b.nextHops[0]?.gateway ?? ''),
        },
    ];
    if (showInterface) {
        columns.push({
            key: 'interface',
            title: 'Interface',
            cell: (row) => perHop(row, (hop) => <InterfaceName name={hop.interface} select={selectInterface} />),
            sortValue: (row) => row.nextHops[0]?.interface ?? '',
        });
    }
    if (rows.some((row) => row.metric !== undefined)) {
        columns.push({
            key: 'metric',
            title: 'Metric',
            cell: (row) => row.metric ?? DASH,
            sortValue: (row) => row.metric ?? 0,
        });
    }
    if (rows.some((row) => row.sources.length > 0)) {
        columns.push({
            key: 'source',
            title: 'Source',
            cell: (row) =>
                row.sources.length === 0
                    ? DASH
                    : row.sources.map((source) => <div key={source}><code>{source}</code></div>),
            compare: (a, b) => comparePrefixes(a.sources[0] ?? '', b.sources[0] ?? ''),
        });
    }
    if (rows.some((row) => row.mtus.length > 0)) {
        columns.push({
            key: 'mtu',
            title: 'MTU',
            cell: (row) => (row.mtus.length === 0 ? DASH : row.mtus.join(', ')),
            sortValue: (row) => row.mtus[0] ?? 0,
        });
    }

    const grouped = groups.length > 1;
    return (
        <div data-testid="kernel-route-table">
            {groups.map((group, index) => (
                <div key={group.key} className={index < groups.length - 1 ? 'pf-u-mb-md' : undefined}>
                    <RuleTable
                        ariaLabel={grouped ? `${ariaLabel}, ${kernelTableLabel(group)}` : ariaLabel}
                        columns={columns}
                        rows={group.rows}
                        rowKey={(row) => row.key}
                        summary={
                            <span data-testid="kernel-route-summary">
                                {`${kernelTableLabel(group)} · ${kernelRouteSummary(group.rows)}`}
                            </span>
                        }
                    />
                </div>
            ))}
        </div>
    );
};

export default KernelRouteTable;
