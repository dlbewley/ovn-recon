import * as React from 'react';
import { Link } from 'react-router';
import {
    Button,
    CodeBlock,
    CodeBlockCode,
    Label,
    Spinner,
    ToggleGroup,
    ToggleGroupItem,
} from '@patternfly/react-core';

import { ACLRow, LogicalDatabase } from '../types';
import {
    ACTION_COLORS,
    DIRECTION_HINTS,
    DrawerBodyProps,
    MatchReferences,
    OwnerName,
    OwnerNetwork,
    ownerQualifiers,
    SUBTLE_TEXT,
    WRAP_ANYWHERE,
} from './ConstructDrawerBody';
import { LadderPort } from './logicalLadderModel';
import {
    describeOwner,
    networkOfController,
    networkRoleResolverFor,
    NetworkRoleResolver,
    OWNER_NAME_KEY,
    ownerOf,
} from './ovnOwner';
import { PolicyIndex, zoneRowFor } from './policyIndex';
import {
    ReferencedAddressSet,
    referencedAddressSets,
    SwitchAclRow,
    switchAclRows,
    SwitchPortGroupRow,
    switchPortGroups,
} from './policyRows';
import RuleTable, { RuleColumn } from './RuleTable';
import { getResourcePath } from '../topology/links';

const PAGE_ROWS = 50;
const PAGE_ROW_CHOICES = [20, 50, 100];
/** Lines of a match shown in a collapsed row; the expanded row has it all. */
const MATCH_LINES = 2;
/** The most lines any cell of a collapsed row takes. */
const ROW_LINES = 3;
/** The Match column's share of the table, in percent: the short columns keep
 * their content's width and Match takes what is left. */
const MATCH_WIDTH = 45;
/** The ACL table's name columns, in percent: enough for a policy name on two lines. */
const OWNER_WIDTH = 20;
const VIA_WIDTH = 20;

/**
 * Half PatternFly's cell padding for the ACL table, so the columns' insets
 * do not take the room the match expression needs.
 */
const ACL_TABLE_STYLE = {
    '--pf-v6-c-table--cell--Padding--base': 'var(--pf-t--global--spacer--sm)',
} as React.CSSProperties;

/** Names wrap at their hyphens and after a slash, never inside a word, so a
 * column keeps a readable width instead of collapsing to a few characters. */
const BREAK_WORD: React.CSSProperties = { overflowWrap: 'break-word' };

/** Clamp to a number of lines with an ellipsis. Long tokens break anywhere
 * unless `wrap` says to keep words whole. */
const clampLines = (lines: number, wrap: React.CSSProperties = WRAP_ANYWHERE): React.CSSProperties => ({
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: lines,
    overflow: 'hidden',
    ...wrap,
});

/** An owner as one cell: what kind of object it is, above its name. The name
 * keeps to the lines the kind leaves, so the cell never outgrows a row. */
const OwnerCell: React.FC<{
    owner: ReturnType<typeof ownerOf>;
    kind: string;
    roleOf: NetworkRoleResolver;
    title?: string;
}> = ({ owner, kind, roleOf, title }) => {
    const qualifiers = ownerQualifiers(owner);
    return (
        <div title={title} style={BREAK_WORD} data-testid="owner-cell">
            <div
                style={{ ...SUBTLE_TEXT, ...clampLines(1) }}
                title={qualifiers ? `${kind} · ${qualifiers}` : undefined}
                data-testid="owner-kind"
            >
                {kind}
                {qualifiers && ` · ${qualifiers}`}
            </div>
            <div style={clampLines(ROW_LINES - 1, BREAK_WORD)} data-testid="owner-name">
                <OwnerName owner={owner} roleOf={roleOf} />
            </div>
        </div>
    );
};

type PolicyView = 'acls' | 'groups' | 'sets';

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

const includes = (query: string, ...values: Array<string | number | undefined>): boolean =>
    values.some((value) => value !== undefined && String(value).toLowerCase().includes(query));

/** The name a port group goes by: its owner's name, else its hashed OVN name. */
const groupLabel = (group: { name: string; externalIds?: Record<string, string> }): string =>
    group.externalIds?.[OWNER_NAME_KEY] ?? group.name;

const RawRow: React.FC<{ row: unknown }> = ({ row }) => (
    <CodeBlock className="pf-u-mt-sm">
        <CodeBlockCode>{JSON.stringify(row, null, 2)}</CodeBlockCode>
    </CodeBlock>
);

/** A switch port, by this zone's uuid, as the Ports tab names it. */
const PortRef: React.FC<{ uuid: string; portByUuid: Map<string, LadderPort>; database: LogicalDatabase }> = ({
    uuid,
    portByUuid,
    database,
}) => {
    const port = portByUuid.get(uuid);
    if (port?.namespace && port.pod) {
        return (
            <Link to={getResourcePath({ apiVersion: 'v1', kind: 'Pod', namespace: port.namespace, name: port.pod })}>
                {port.namespace}/{port.pod}
            </Link>
        );
    }
    const name = port?.name ?? database.logicalSwitchPorts.find((row) => row.uuid === uuid)?.name ?? uuid;
    return <code>{name}</code>;
};

// ------------------------------------------------------------------ ACLs

const AclTable: React.FC<{
    rows: SwitchAclRow[];
    index: PolicyIndex;
    roleOf: NetworkRoleResolver;
    query: string;
    onQueryChange: (value: string) => void;
    summary: React.ReactNode;
}> = ({ rows, index, roleOf, query, onQueryChange, summary }) => {
    const ownerKind = (row: SwitchAclRow) => describeOwner(ownerOf(row.acl.externalIds), roleOf).kind;
    const ownerName = (row: SwitchAclRow) => describeOwner(ownerOf(row.acl.externalIds), roleOf).name ?? '';
    const viaNames = (row: SwitchAclRow) => [...(row.direct ? ['switch'] : []), ...row.via.map(groupLabel)];
    const viaText = (row: SwitchAclRow) => viaNames(row).join(', ');

    // The network every ACL here belongs to, when it is one and the same: the
    // column would repeat it on every row, so the summary line says it once.
    const networkKey = (row: SwitchAclRow) => {
        const controller = ownerOf(row.acl.externalIds)?.controller;
        return networkOfController(controller) ?? controller ?? '';
    };
    const oneNetwork = rows.length > 0 && new Set(rows.map(networkKey)).size === 1;

    const columns: RuleColumn<SwitchAclRow>[] = [
        {
            key: 'priority',
            title: 'Priority',
            cell: (row) => (
                <>
                    {row.acl.priority}
                    <div style={SUBTLE_TEXT} data-testid="acl-tier">tier {row.acl.tier}</div>
                </>
            ),
            sortValue: (row) => row.acl.priority,
            modifier: 'fitContent',
        },
        {
            key: 'action',
            title: 'Action',
            cell: (row) => (
                <>
                    <Label isCompact color={ACTION_COLORS[row.acl.action] ?? 'grey'}>{row.acl.action}</Label>
                    <div style={SUBTLE_TEXT} title={DIRECTION_HINTS[row.acl.direction]} data-testid="acl-direction">
                        {row.acl.direction}
                    </div>
                </>
            ),
            sortValue: (row) => `${row.acl.action} ${row.acl.direction}`,
            modifier: 'fitContent',
        },
        {
            key: 'owner',
            title: 'Owner',
            cell: (row) => (
                <OwnerCell
                    owner={ownerOf(row.acl.externalIds)}
                    kind={ownerKind(row)}
                    roleOf={roleOf}
                    title={row.acl.name}
                />
            ),
            sortValue: (row) => `${ownerKind(row)} ${ownerName(row)}`,
            width: OWNER_WIDTH,
        },
        ...(oneNetwork
            ? []
            : [{
                key: 'network',
                title: 'Network',
                cell: (row) => (
                    <div style={clampLines(ROW_LINES, BREAK_WORD)}>
                        <OwnerNetwork owner={ownerOf(row.acl.externalIds)} />
                    </div>
                ),
                sortValue: (row) => networkOfController(ownerOf(row.acl.externalIds)?.controller) ?? '',
            } as RuleColumn<SwitchAclRow>]),
        {
            key: 'via',
            title: 'Applied via',
            // The first name and a count; the expanded row lists them all. The
            // ports the ACL reaches on this switch share the cell's last line.
            cell: (row) => {
                const names = viaNames(row);
                const more = names.length - 1;
                return (
                    <div title={names.join(', ')} data-testid="acl-via">
                        <div style={clampLines(ROW_LINES - 1, BREAK_WORD)}>{names[0]}</div>
                        <div style={SUBTLE_TEXT} data-testid="acl-via-ports">
                            {more > 0 && `+${more} more · `}
                            {plural(row.portsHere, 'port')} here
                        </div>
                    </div>
                );
            },
            sortValue: viaText,
            width: VIA_WIDTH,
        },
        {
            key: 'match',
            title: 'Match',
            cell: (row) => (
                <div style={clampLines(MATCH_LINES)} title={row.acl.match} data-testid="acl-match" data-clamp-lines={MATCH_LINES}>
                    <code>{row.acl.match}</code>
                </div>
            ),
            width: MATCH_WIDTH,
        },
    ];

    return (
        <RuleTable<SwitchAclRow>
            ariaLabel="ACLs"
            tableStyle={ACL_TABLE_STYLE}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.acl.uuid}
            filter={{
                ariaLabel: 'Filter ACLs',
                placeholder: (total) => `Filter ${plural(total, 'ACL')}`,
                matches: (row, needle) =>
                    includes(needle, row.acl.match, row.acl.name, ownerName(row), ownerKind(row), viaText(row), row.acl.priority),
                value: query,
                onChange: onQueryChange,
            }}
            facets={[
                { key: 'direction', ariaLabel: 'Filter by direction', allLabel: () => 'All directions', valueOf: (row) => row.acl.direction },
                { key: 'action', ariaLabel: 'Filter by action', allLabel: () => 'All actions', valueOf: (row) => row.acl.action },
                { key: 'ownerType', ariaLabel: 'Filter by owner type', allLabel: () => 'All owner types', valueOf: ownerKind },
            ]}
            summary={({ shown, total }) => (
                <span data-testid="acl-summary">
                    {shown < total ? `${shown} of ${plural(total, 'ACL')}` : plural(total, 'ACL')}
                    {summary}
                    {oneNetwork && (
                        <span data-testid="acl-one-network">
                            {' · all on '}
                            <OwnerNetwork owner={ownerOf(rows[0].acl.externalIds)} />
                        </span>
                    )}
                </span>
            )}
            emptyMessage={{ none: 'No ACL applies on this switch.', noMatch: 'No ACLs match.' }}
            pageSize={PAGE_ROWS}
            perPageOptions={PAGE_ROW_CHOICES}
            expandedContent={(row) => (
                <div style={{ width: 0, minWidth: '100%' }} data-testid={`acl-detail-${row.acl.uuid}`}>
                    <div><strong>Match</strong></div>
                    <code style={WRAP_ANYWHERE}>{row.acl.match}</code>
                    <MatchReferences acl={row.acl} index={index} roleOf={roleOf} />
                    {row.via.length > 0 && (
                        <div className="pf-u-mt-sm" data-testid="acl-detail-via">
                            <div><strong>Applied via</strong></div>
                            {row.direct && <div>switch (the ACL is set on the switch itself)</div>}
                            {row.via.map((group) => (
                                <div key={group.uuid}>
                                    {groupLabel(group)} <code style={SUBTLE_TEXT}>@{group.name}</code>
                                </div>
                            ))}
                        </div>
                    )}
                    <RawRow row={row.acl} />
                </div>
            )}
        />
    );
};

// ----------------------------------------------------------- port groups

const PortGroupView: React.FC<{
    groups: SwitchPortGroupRow[];
    elsewhere: number;
    roleOf: NetworkRoleResolver;
    portByUuid: Map<string, LadderPort>;
    database: LogicalDatabase;
    query: string;
    onQueryChange: (value: string) => void;
}> = ({ groups, elsewhere, roleOf, portByUuid, database, query, onQueryChange }) => {
    const ownerKind = (row: SwitchPortGroupRow) => describeOwner(ownerOf(row.group.externalIds), roleOf).kind;
    const ownerName = (row: SwitchPortGroupRow) => describeOwner(ownerOf(row.group.externalIds), roleOf).name ?? '';
    const columns: RuleColumn<SwitchPortGroupRow>[] = [
        {
            key: 'owner',
            title: 'Owner',
            cell: (row) => <OwnerCell owner={ownerOf(row.group.externalIds)} kind={ownerKind(row)} roleOf={roleOf} />,
            sortValue: (row) => `${ownerKind(row)} ${ownerName(row)}`,
        },
        {
            key: 'network',
            title: 'Network',
            cell: (row) => <OwnerNetwork owner={ownerOf(row.group.externalIds)} />,
            sortValue: (row) => networkOfController(ownerOf(row.group.externalIds)?.controller) ?? '',
        },
        {
            key: 'name',
            title: 'OVN name',
            cell: (row) => <code style={WRAP_ANYWHERE}>{row.group.name}</code>,
            sortValue: (row) => row.group.name,
            modifier: 'breakWord',
        },
        {
            key: 'ports',
            title: 'Ports here',
            cell: (row) => row.portsHere.length,
            sortValue: (row) => row.portsHere.length,
            modifier: 'fitContent',
        },
        { key: 'acls', title: 'ACLs', cell: (row) => row.acls.length, sortValue: (row) => row.acls.length, modifier: 'fitContent' },
    ];
    return (
        <>
            <RuleTable<SwitchPortGroupRow>
                ariaLabel="Port groups"
                columns={columns}
                rows={groups}
                rowKey={(row) => row.group.uuid}
                filter={{
                    ariaLabel: 'Filter port groups',
                    placeholder: (total) => `Filter ${plural(total, 'port group')}`,
                    matches: (row, needle) => includes(needle, row.group.name, ownerName(row), ownerKind(row)),
                    value: query,
                    onChange: onQueryChange,
                }}
                facets={[
                    { key: 'ownerType', ariaLabel: 'Filter by owner type', allLabel: () => 'All owner types', valueOf: ownerKind },
                ]}
                summary={({ shown, total }) =>
                    shown < total ? `${shown} of ${plural(total, 'port group')}` : plural(total, 'port group')
                }
                emptyMessage={{ none: 'No port group has a port on this switch.', noMatch: 'No port groups match.' }}
                pageSize={PAGE_ROWS}
                perPageOptions={PAGE_ROW_CHOICES}
                expandedContent={(row) => (
                    <div style={{ width: 0, minWidth: '100%' }}>
                        <div><strong>Member ports here ({row.portsHere.length})</strong></div>
                        {row.portsHere.map((uuid) => (
                            <div key={uuid}><PortRef uuid={uuid} portByUuid={portByUuid} database={database} /></div>
                        ))}
                        <div className="pf-u-mt-sm"><strong>ACLs ({row.acls.length})</strong></div>
                        {row.acls.length === 0 ? (
                            <div style={SUBTLE_TEXT}>This group carries no ACL.</div>
                        ) : (
                            row.acls.map((acl) => <AclLine key={acl.uuid} acl={acl} />)
                        )}
                    </div>
                )}
            />
            <div className="pf-u-mt-sm" style={SUBTLE_TEXT} data-testid="port-groups-elsewhere">
                {plural(elsewhere, 'port group')} in this zone {elsewhere === 1 ? 'has' : 'have'} no port here.
            </div>
        </>
    );
};

const AclLine: React.FC<{ acl: ACLRow }> = ({ acl }) => (
    <div className="pf-u-mb-xs">
        {acl.priority} {acl.direction}{' '}
        <Label isCompact color={ACTION_COLORS[acl.action] ?? 'grey'}>{acl.action}</Label>{' '}
        <code style={WRAP_ANYWHERE}>{acl.match}</code>
    </div>
);

// ---------------------------------------------------------- address sets

const AddressSetView: React.FC<{
    sets: ReferencedAddressSet[];
    roleOf: NetworkRoleResolver;
    query: string;
    onQueryChange: (value: string) => void;
}> = ({ sets, roleOf, query, onQueryChange }) => {
    const ownerKind = (set: ReferencedAddressSet) =>
        set.row ? describeOwner(ownerOf(set.row.externalIds), roleOf).kind : 'Unresolved';
    const ownerName = (set: ReferencedAddressSet) =>
        set.row ? describeOwner(ownerOf(set.row.externalIds), roleOf).name ?? '' : '';
    const columns: RuleColumn<ReferencedAddressSet>[] = [
        {
            key: 'name',
            title: 'Name',
            cell: (set) => <code style={WRAP_ANYWHERE}>${set.name}</code>,
            sortValue: (set) => set.name,
            modifier: 'breakWord',
        },
        {
            key: 'owner',
            title: 'Owner',
            cell: (set) =>
                set.row ? (
                    <OwnerCell owner={ownerOf(set.row.externalIds)} kind={ownerKind(set)} roleOf={roleOf} />
                ) : (
                    <span style={SUBTLE_TEXT}>no such row in this zone</span>
                ),
            sortValue: (set) => `${ownerKind(set)} ${ownerName(set)}`,
        },
        {
            key: 'addresses',
            title: 'Addresses',
            cell: (set) => set.row?.addresses.length ?? <span style={SUBTLE_TEXT}>—</span>,
            sortValue: (set) => set.row?.addresses.length ?? -1,
            modifier: 'fitContent',
        },
        { key: 'acls', title: 'ACLs naming it', cell: (set) => set.acls, sortValue: (set) => set.acls, modifier: 'fitContent' },
    ];
    return (
        <RuleTable<ReferencedAddressSet>
            ariaLabel="Address sets"
            columns={columns}
            rows={sets}
            rowKey={(set) => set.name}
            filter={{
                ariaLabel: 'Filter address sets',
                placeholder: (total) => `Filter ${plural(total, 'address set')}`,
                matches: (set, needle) =>
                    includes(needle, set.name, ownerName(set), ...(set.row?.addresses ?? [])),
                value: query,
                onChange: onQueryChange,
            }}
            summary={`${plural(sets.length, 'address set')} named by the ACLs listed here`}
            emptyMessage={{ none: 'The ACLs here name no address set.', noMatch: 'No address sets match.' }}
            pageSize={PAGE_ROWS}
            perPageOptions={PAGE_ROW_CHOICES}
            expandedContent={(set) =>
                set.row ? (
                    <div style={{ width: 0, minWidth: '100%' }}>
                        {set.row.addresses.length === 0 ? (
                            <div style={SUBTLE_TEXT}>The set is empty.</div>
                        ) : (
                            set.row.addresses.map((address) => (
                                <div key={address}><code>{address}</code></div>
                            ))
                        )}
                    </div>
                ) : undefined
            }
        />
    );
};

// ------------------------------------------------------------------- tab

export interface PolicyBodyProps extends DrawerBodyProps {
    /** Clear the port the ACL view is narrowed to. */
    onClearPort?: () => void;
}

/**
 * The detail page's Policy tab (ovn-recon-e2b.8, decision 9): the ACLs that
 * apply on the switch, the port groups with a port on it, and the address
 * sets those ACLs name, behind a view switch. With the port parameter set the
 * ACL view lists only the ACLs on that port. Switches only: ACLs attach to
 * switches and port groups, not routers.
 */
export const PolicyBody: React.FC<PolicyBodyProps> = ({
    construct,
    policy,
    databaseNode,
    query = '',
    onQueryChange = () => undefined,
    focusPort,
    onClearPort,
}) => {
    const [view, setView] = React.useState<PolicyView>('acls');
    const ready = policy.status === 'ready' ? policy : undefined;
    const roleOf = React.useMemo(() => networkRoleResolverFor(ready?.database), [ready?.database]);
    const portByUuid = React.useMemo(() => {
        const map = new Map<string, LadderPort>();
        if (!ready) return map;
        for (const port of construct.ports) {
            const zonePort = zoneRowFor(ready.database.logicalSwitchPorts, port);
            if (zonePort) map.set(zonePort.uuid, port);
        }
        return map;
    }, [construct.ports, ready]);

    const zonePortUuid = React.useMemo(() => {
        if (!ready || !focusPort) return undefined;
        return ready.database.logicalSwitchPorts.find((row) => row.name === focusPort)?.uuid;
    }, [ready, focusPort]);

    const switchAcls = React.useMemo(
        () => (ready?.switchUuid ? switchAclRows(ready.index, ready.database, ready.switchUuid) : []),
        [ready],
    );
    const aclRows = React.useMemo(
        () =>
            ready?.switchUuid && zonePortUuid
                ? switchAclRows(ready.index, ready.database, ready.switchUuid, zonePortUuid)
                : switchAcls,
        [ready, zonePortUuid, switchAcls],
    );
    const groups = React.useMemo(
        () => (ready?.switchUuid ? switchPortGroups(ready.index, ready.database, ready.switchUuid) : { here: [], elsewhere: 0 }),
        [ready],
    );
    const sets = React.useMemo(
        () => (ready ? referencedAddressSets(ready.index, aclRows.map((row) => row.acl)) : []),
        [ready, aclRows],
    );

    if (policy.status === 'loading') {
        return <div><Spinner size="md" aria-label="Loading policy" /> Loading ACLs, port groups and address sets…</div>;
    }
    if (!ready) {
        return (
            <div style={SUBTLE_TEXT} data-testid="policy-not-collected">
                ACL, port group and address set rows were not collected for node {databaseNode}.
            </div>
        );
    }
    if (!ready.switchUuid) {
        return <div style={SUBTLE_TEXT}>The northbound database of node {databaseNode} does not hold this switch.</div>;
    }

    const narrowed = focusPort && view === 'acls';

    return (
        <>
            <ToggleGroup aria-label="Policy view" className="pf-u-mb-md">
                <ToggleGroupItem
                    text={`ACLs (${aclRows.length})`}
                    buttonId="policy-view-acls"
                    isSelected={view === 'acls'}
                    onChange={() => setView('acls')}
                />
                <ToggleGroupItem
                    text={`Port groups (${groups.here.length})`}
                    buttonId="policy-view-groups"
                    isSelected={view === 'groups'}
                    onChange={() => setView('groups')}
                />
                <ToggleGroupItem
                    text={`Address sets (${sets.length})`}
                    buttonId="policy-view-sets"
                    isSelected={view === 'sets'}
                    onChange={() => setView('sets')}
                />
            </ToggleGroup>
            {narrowed && (
                <div className="pf-u-mb-sm" data-testid="policy-port">
                    {zonePortUuid ? (
                        <>
                            ACLs that apply to port <code>{focusPort}</code>
                        </>
                    ) : (
                        <>
                            Port <code>{focusPort}</code> is not in this zone; showing every ACL on the switch.
                        </>
                    )}{' '}
                    {onClearPort && (
                        <Button variant="link" isInline onClick={onClearPort}>
                            Show all ACLs on the switch
                        </Button>
                    )}
                </div>
            )}
            {view === 'acls' && (
                <AclTable
                    rows={aclRows}
                    index={ready.index}
                    roleOf={roleOf}
                    query={query}
                    onQueryChange={onQueryChange}
                    summary={databaseNode ? ` · ACL rows from node ${databaseNode}` : ''}
                />
            )}
            {view === 'groups' && (
                <PortGroupView
                    groups={groups.here}
                    elsewhere={groups.elsewhere}
                    roleOf={roleOf}
                    portByUuid={portByUuid}
                    database={ready.database}
                    query={query}
                    onQueryChange={onQueryChange}
                />
            )}
            {view === 'sets' && (
                <AddressSetView sets={sets} roleOf={roleOf} query={query} onQueryChange={onQueryChange} />
            )}
        </>
    );
};

export default PolicyBody;
