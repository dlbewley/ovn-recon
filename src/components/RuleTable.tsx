import * as React from 'react';
import { Link } from 'react-router';
import { Pagination } from '@patternfly/react-core';
import { ExpandableRowContent, Table, Tbody, Td, Th, Thead, ThProps, Tr } from '@patternfly/react-table';

/**
 * One column of a RuleTable. `sortValue` makes the column sortable; omit it
 * for columns whose order means nothing (flags, free text).
 */
export interface RuleColumn<R> {
    key: string;
    title: string;
    cell: (row: R) => React.ReactNode;
    sortValue?: (row: R) => string | number;
    /** Custom comparator, for values that sort numerically but read as text
     * (IP prefixes). Takes precedence over `sortValue`. */
    compare?: (a: R, b: R) => number;
}

export interface RuleTableProps<R> {
    ariaLabel: string;
    columns: RuleColumn<R>[];
    /** Rows in their default order; sorting by a column reorders a copy. */
    rows: R[];
    rowKey: (row: R) => string;
    /** One line above the table: counts, chips. */
    summary?: React.ReactNode;
    /** Detail for a row, or undefined when the row has nothing to expand. */
    expandedContent?: (row: R) => React.ReactNode | undefined;
    /** Link to the full list (the construct detail page) when one exists. */
    openAll?: { href: string; count: number };
    /**
     * Rows per page. When set and the rows outnumber it, a compact pager
     * shows under the summary and only the current page renders; sorting
     * applies to all rows first. Unset, every row renders.
     */
    pageSize?: number;
    /** Style for the table element, e.g. narrower cell padding where the
     * table has to fit a drawer. Unset, PatternFly's compact defaults apply. */
    tableStyle?: React.CSSProperties;
}

/**
 * The drawer's shell for row sets with columns (NAT, static routes, and the
 * router policies, MAC bindings, CoPP and QoS rules to come): a compact
 * table with a one-line summary first, sortable columns and expandable rows.
 * It scrolls horizontally inside its own box instead of widening the drawer.
 */
export const RuleTable = <R,>({
    ariaLabel,
    columns,
    rows,
    rowKey,
    summary,
    expandedContent,
    openAll,
    pageSize,
    tableStyle,
}: RuleTableProps<R>): React.ReactElement => {
    const [sort, setSort] = React.useState<{ index: number; direction: 'asc' | 'desc' } | null>(null);
    const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());
    const [page, setPage] = React.useState(1);
    const [perPage, setPerPage] = React.useState(pageSize ?? 0);
    // A different row set (a filter changed) starts again at its first page;
    // the same rows rebuilt (fresher data) keep the page.
    const rowSignature = pageSize ? rows.map(rowKey).join('\n') : '';
    React.useEffect(() => {
        setPage(1);
    }, [rowSignature]);

    const sortedRows = React.useMemo(() => {
        const column = sort ? columns[sort.index] : undefined;
        if (!sort || !column || (!column.compare && !column.sortValue)) return rows;
        const compare =
            column.compare ??
            ((a: R, b: R) => {
                const va = column.sortValue?.(a) ?? '';
                const vb = column.sortValue?.(b) ?? '';
                return typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
            });
        const sign = sort.direction === 'asc' ? 1 : -1;
        return [...rows].sort((a, b) => sign * compare(a, b));
    }, [rows, columns, sort]);

    const toggle = (key: string) =>
        setExpanded((current) => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });

    const sortParams = (index: number): ThProps['sort'] | undefined => {
        const column = columns[index];
        if (!column.compare && !column.sortValue) return undefined;
        return {
            sortBy: sort ? { index: sort.index, direction: sort.direction } : {},
            onSort: (_event, columnIndex, direction) => setSort({ index: columnIndex, direction }),
            columnIndex: index,
        };
    };

    const paged = pageSize !== undefined && pageSize > 0 && rows.length > pageSize;
    const pageCount = paged ? Math.max(1, Math.ceil(sortedRows.length / perPage)) : 1;
    const currentPage = Math.min(page, pageCount);
    const shownRows = paged ? sortedRows.slice((currentPage - 1) * perPage, currentPage * perPage) : sortedRows;

    const expandable = expandedContent != null && rows.some((row) => expandedContent(row) !== undefined);

    return (
        <div>
            {(summary || openAll) && (
                <div className="pf-u-mb-xs" data-testid="rule-table-summary">
                    {summary}
                    {openAll && (
                        <>
                            {summary ? ' · ' : ''}
                            <Link to={openAll.href}>Open all {openAll.count}</Link>
                        </>
                    )}
                </div>
            )}
            {paged && (
                <Pagination
                    itemCount={sortedRows.length}
                    perPage={perPage}
                    page={currentPage}
                    onSetPage={(_event, next) => setPage(next)}
                    onPerPageSelect={(_event, next) => {
                        setPerPage(next);
                        setPage(1);
                    }}
                    perPageOptions={[...new Set([pageSize, pageSize * 2, pageSize * 5])].map((value) => ({
                        title: String(value),
                        value,
                    }))}
                    isCompact
                    widgetId={`${ariaLabel}-pager`.replace(/\s+/g, '-')}
                    titles={{ paginationAriaLabel: `${ariaLabel} pages` }}
                    data-testid="rule-table-pager"
                />
            )}
            <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
                <Table aria-label={ariaLabel} variant="compact" isExpandable={expandable} style={tableStyle}>
                    <Thead>
                        <Tr>
                            {expandable && <Th screenReaderText="Row expansion" />}
                            {columns.map((column, index) => (
                                <Th key={column.key} sort={sortParams(index)} modifier="nowrap">
                                    {column.title}
                                </Th>
                            ))}
                        </Tr>
                    </Thead>
                    {shownRows.map((row, rowIndex) => {
                        const key = rowKey(row);
                        const content = expandable ? expandedContent?.(row) : undefined;
                        const isExpanded = content !== undefined && expanded.has(key);
                        return (
                            <Tbody key={key} isExpanded={isExpanded}>
                                <Tr data-testid={`rule-row-${key}`}>
                                    {expandable &&
                                        (content !== undefined ? (
                                            <Td
                                                expand={{
                                                    rowIndex,
                                                    isExpanded,
                                                    onToggle: () => toggle(key),
                                                    expandId: `${ariaLabel}-${key}`.replace(/\s+/g, '-'),
                                                }}
                                            />
                                        ) : (
                                            <Td />
                                        ))}
                                    {columns.map((column) => (
                                        <Td key={column.key} dataLabel={column.title}>
                                            {column.cell(row)}
                                        </Td>
                                    ))}
                                </Tr>
                                {content !== undefined && (
                                    <Tr isExpanded={isExpanded}>
                                        <Td />
                                        <Td dataLabel="Details" colSpan={columns.length}>
                                            <ExpandableRowContent>{isExpanded && content}</ExpandableRowContent>
                                        </Td>
                                    </Tr>
                                )}
                            </Tbody>
                        );
                    })}
                </Table>
            </div>
        </div>
    );
};

export default RuleTable;
