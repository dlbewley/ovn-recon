import * as React from 'react';
import { Link } from 'react-router';
import {
    FormSelect,
    FormSelectOption,
    Pagination,
    TextInput,
    Toolbar,
    ToolbarContent,
    ToolbarItem,
} from '@patternfly/react-core';
import { ExpandableRowContent, Table, Tbody, Td, TdProps, Th, Thead, ThProps, Tr } from '@patternfly/react-table';

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
    /** Header wrapping; default nowrap. */
    headerModifier?: ThProps['modifier'];
    /** Cell wrapping (breakWord, fitContent, ...). */
    modifier?: TdProps['modifier'];
    /** The column's share of the table width, in percent. Give it to the
     * columns that should take the room the short ones leave. */
    width?: ThProps['width'];
}

/**
 * A text filter over a RuleTable's rows. Uncontrolled unless `value` is set,
 * so a page can keep the filter in its URL (the construct detail page's q).
 */
export interface RuleFilter<R> {
    ariaLabel: string;
    /** Placeholder, or a function of the unfiltered row count. */
    placeholder: string | ((total: number) => string);
    /** Whether a row matches the trimmed, lower-cased query. */
    matches: (row: R, query: string) => boolean;
    value?: string;
    onChange?: (value: string) => void;
}

/** A select over one property of the rows, with per-value counts. */
export interface RuleFacet<R> {
    key: string;
    ariaLabel: string;
    /** The "everything" option's label, given the unfiltered row count. */
    allLabel: (total: number) => string;
    valueOf: (row: R) => string;
    /** Option label for a value; default "value (count)". */
    optionLabel?: (value: string, count: number) => string;
}

/** The facet value that selects every row. */
export const ALL_FACET_VALUE = 'all';

export interface RuleTableProps<R> {
    ariaLabel: string;
    columns: RuleColumn<R>[];
    /** Rows in their default order; sorting by a column reorders a copy. */
    rows: R[];
    rowKey: (row: R) => string;
    /** One line above the table: counts, chips. A function receives how many
     * rows the filter and facets leave out of how many. */
    summary?: React.ReactNode | ((counts: { shown: number; total: number }) => React.ReactNode);
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
    /** Per-page choices when paged; default pageSize ×1, ×2, ×5. */
    perPageOptions?: number[];
    /** A search box over the rows, shown in a toolbar above the table. */
    filter?: RuleFilter<R>;
    /** Selects over row properties, in the same toolbar. */
    facets?: RuleFacet<R>[];
    /** More toolbar items (a view switch, say), after the filter and facets. */
    toolbarItems?: React.ReactNode;
    /**
     * Expand the row with this key, turn to its page and scroll it into view,
     * once per value. For full-width pages only: scrolling inside the overlay
     * drawer shifts the whole console page (ovn-recon-dp7.7).
     */
    focusKey?: string;
    /** Called when the user expands or collapses a row. */
    onToggleRow?: (key: string, expanded: boolean) => void;
    /** The data-testid of a row; default rule-row-KEY. */
    rowTestId?: (key: string) => string;
    /** Shown in place of rows: when there are none, and when none match. */
    emptyMessage?: { none: React.ReactNode; noMatch: React.ReactNode };
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
    perPageOptions,
    filter,
    facets,
    toolbarItems,
    focusKey,
    onToggleRow,
    rowTestId = (key) => `rule-row-${key}`,
    emptyMessage,
}: RuleTableProps<R>): React.ReactElement => {
    const [ownQuery, setOwnQuery] = React.useState('');
    const queryText = filter?.value ?? ownQuery;
    const setQuery = (value: string) => {
        if (filter?.value === undefined) setOwnQuery(value);
        filter?.onChange?.(value);
    };
    const [facetValues, setFacetValues] = React.useState<Record<string, string>>({});

    const facetCounts = React.useMemo(
        () =>
            (facets ?? []).map((facet) => {
                const counts = new Map<string, number>();
                for (const row of rows) {
                    const value = facet.valueOf(row);
                    counts.set(value, (counts.get(value) ?? 0) + 1);
                }
                return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
            }),
        [facets, rows],
    );

    const query = queryText.trim().toLowerCase();
    const filteredRows = React.useMemo(() => {
        const active = (facets ?? []).filter(
            (facet) => (facetValues[facet.key] ?? ALL_FACET_VALUE) !== ALL_FACET_VALUE,
        );
        if (!query && active.length === 0) return rows;
        return rows.filter(
            (row) =>
                (!query || !filter || filter.matches(row, query)) &&
                active.every((facet) => facet.valueOf(row) === facetValues[facet.key]),
        );
    }, [rows, query, filter, facets, facetValues]);

    const [sort, setSort] = React.useState<{ index: number; direction: 'asc' | 'desc' } | null>(null);
    const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());
    const [page, setPage] = React.useState(1);
    const [perPage, setPerPage] = React.useState(pageSize ?? 0);
    // A different row set (a filter changed) starts again at its first page;
    // the same rows rebuilt (fresher data) keep the page.
    const rowSignature = pageSize ? filteredRows.map(rowKey).join('\n') : '';
    React.useEffect(() => {
        setPage(1);
    }, [rowSignature]);

    const sortedRows = React.useMemo(() => {
        const column = sort ? columns[sort.index] : undefined;
        if (!sort || !column || (!column.compare && !column.sortValue)) return filteredRows;
        const compare =
            column.compare ??
            ((a: R, b: R) => {
                const va = column.sortValue?.(a) ?? '';
                const vb = column.sortValue?.(b) ?? '';
                return typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
            });
        const sign = sort.direction === 'asc' ? 1 : -1;
        return [...filteredRows].sort((a, b) => sign * compare(a, b));
    }, [filteredRows, columns, sort]);

    const toggle = (key: string) => {
        const willExpand = !expanded.has(key);
        setExpanded((current) => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
        onToggleRow?.(key, willExpand);
    };

    const sortParams = (index: number): ThProps['sort'] | undefined => {
        const column = columns[index];
        if (!column.compare && !column.sortValue) return undefined;
        return {
            sortBy: sort ? { index: sort.index, direction: sort.direction } : {},
            onSort: (_event, columnIndex, direction) => setSort({ index: columnIndex, direction }),
            columnIndex: index,
        };
    };

    const paged = pageSize !== undefined && pageSize > 0 && filteredRows.length > pageSize;
    const pageCount = paged ? Math.max(1, Math.ceil(sortedRows.length / perPage)) : 1;
    const currentPage = Math.min(page, pageCount);
    const shownRows = paged ? sortedRows.slice((currentPage - 1) * perPage, currentPage * perPage) : sortedRows;

    // A focus request: expand the row and turn to its page now; scroll once
    // the row has rendered on that page.
    const [pendingScroll, setPendingScroll] = React.useState<string | null>(null);
    const focusedRef = React.useRef<string | undefined>(undefined);
    React.useEffect(() => {
        if (!focusKey || focusedRef.current === focusKey) return;
        const index = sortedRows.findIndex((row) => rowKey(row) === focusKey);
        if (index < 0) return;
        focusedRef.current = focusKey;
        setExpanded((current) => (current.has(focusKey) ? current : new Set(current).add(focusKey)));
        if (paged) setPage(Math.floor(index / perPage) + 1);
        setPendingScroll(focusKey);
    }, [focusKey, sortedRows, rowKey, paged, perPage]);
    const tableRef = React.useRef<HTMLDivElement | null>(null);
    React.useEffect(() => {
        if (!pendingScroll) return;
        const testId = rowTestId(pendingScroll);
        const element = [...(tableRef.current?.querySelectorAll('tr[data-testid]') ?? [])].find(
            (row) => row.getAttribute('data-testid') === testId,
        );
        if (!element) return;
        setPendingScroll(null);
        if (typeof (element as HTMLElement).scrollIntoView === 'function') {
            (element as HTMLElement).scrollIntoView({ block: 'start', behavior: 'smooth' });
        }
    });

    const expandable = expandedContent != null && rows.some((row) => expandedContent(row) !== undefined);
    const summaryNode =
        typeof summary === 'function' ? summary({ shown: filteredRows.length, total: rows.length }) : summary;
    const pageChoices = perPageOptions ?? (pageSize ? [pageSize, pageSize * 2, pageSize * 5] : []);
    const columnCount = columns.length + (expandable ? 1 : 0);

    return (
        <div ref={tableRef}>
            {(filter || (facets && facets.length > 0) || toolbarItems) && (
                <Toolbar inset={{ default: 'insetNone' }} className="pf-u-pb-sm">
                    <ToolbarContent>
                        {filter && (
                            <ToolbarItem>
                                <TextInput
                                    aria-label={filter.ariaLabel}
                                    type="search"
                                    placeholder={
                                        typeof filter.placeholder === 'function'
                                            ? filter.placeholder(rows.length)
                                            : filter.placeholder
                                    }
                                    value={queryText}
                                    onChange={(_event, value) => setQuery(value)}
                                />
                            </ToolbarItem>
                        )}
                        {(facets ?? []).map((facet, index) => (
                            <ToolbarItem key={facet.key}>
                                <FormSelect
                                    aria-label={facet.ariaLabel}
                                    value={facetValues[facet.key] ?? ALL_FACET_VALUE}
                                    onChange={(_event, value) =>
                                        setFacetValues((current) => ({ ...current, [facet.key]: value }))
                                    }
                                >
                                    <FormSelectOption value={ALL_FACET_VALUE} label={facet.allLabel(rows.length)} />
                                    {facetCounts[index].map(([value, count]) => (
                                        <FormSelectOption
                                            key={value}
                                            value={value}
                                            label={facet.optionLabel ? facet.optionLabel(value, count) : `${value} (${count})`}
                                        />
                                    ))}
                                </FormSelect>
                            </ToolbarItem>
                        ))}
                        {toolbarItems}
                    </ToolbarContent>
                </Toolbar>
            )}
            {(summaryNode || openAll) && (
                <div className="pf-u-mb-xs" data-testid="rule-table-summary">
                    {summaryNode}
                    {openAll && (
                        <>
                            {summaryNode ? ' · ' : ''}
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
                    perPageOptions={[...new Set(pageChoices)].map((value) => ({
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
                                <Th
                                    key={column.key}
                                    sort={sortParams(index)}
                                    modifier={column.headerModifier ?? 'nowrap'}
                                    width={column.width}
                                >
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
                                <Tr data-testid={rowTestId(key)}>
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
                                        <Td key={column.key} dataLabel={column.title} modifier={column.modifier}>
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
                    {emptyMessage && shownRows.length === 0 && (
                        <Tbody>
                            <Tr>
                                <Td colSpan={columnCount}>
                                    {rows.length === 0 ? emptyMessage.none : emptyMessage.noMatch}
                                </Td>
                            </Tr>
                        </Tbody>
                    )}
                </Table>
            </div>
        </div>
    );
};

export default RuleTable;
