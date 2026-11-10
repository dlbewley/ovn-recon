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
/** Characters of a match shown in the table cell; the expanded row has it all. */
const MATCH_PREVIEW = 160;

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
    const viaText = (row: SwitchAclRow) =>
        [...(row.direct ? ['switch'] : []), ...row.via.map(groupLabel)].join(', ');

    const columns: RuleColumn<SwitchAclRow>[] = [
        { key: 'priority', title: 'Priority', cell: (row) => row.acl.priority, sortValue: (row) => row.acl.priority },
        {
            key: 'direction',
            title: 'Direction',
            cell: (row) => <span title={DIRECTION_HINTS[row.acl.direction]}>{row.acl.direction}</span>,
            sortValue: (row) => row.acl.direction,
        },
        {
            key: 'action',
            title: 'Action',
            cell: (row) => <Label isCompact color={ACTION_COLORS[row.acl.action] ?? 'grey'}>{row.acl.action}</Label>,
            sortValue: (row) => row.acl.action,
        },
        { key: 'tier', title: 'Tier', cell: (row) => row.acl.tier, sortValue: (row) => row.acl.tier },
        { key: 'ownerType', title: 'Owner type', cell: ownerKind, sortValue: ownerKind },
        {
            key: 'owner',
            title: 'Owner',
            cell: (row) => {
                const owner = ownerOf(row.acl.externalIds);
                const qualifiers = ownerQualifiers(owner);
                return (
                    <span title={row.acl.name}>
                        <OwnerName owner={owner} roleOf={roleOf} />
                        {qualifiers && <div style={SUBTLE_TEXT}>{qualifiers}</div>}
                    </span>
                );
            },
            sortValue: ownerName,
            modifier: 'breakWord',
        },
        {
            key: 'network',
            title: 'Network',
            cell: (row) => <OwnerNetwork owner={ownerOf(row.acl.externalIds)} />,
            sortValue: (row) => networkOfController(ownerOf(row.acl.externalIds)?.controller) ?? '',
        },
        {
            key: 'via',
            title: 'Applied via',
            cell: (row) => (
                <>
                    {row.direct && <div>switch</div>}
                    {row.via.map((group) => (
                        <div key={group.uuid} title={`@${group.name}`} style={WRAP_ANYWHERE}>
                            {groupLabel(group)}
                        </div>
                    ))}
                </>
            ),
            sortValue: viaText,
            modifier: 'breakWord',
        },
        { key: 'ports', title: 'Ports here', cell: (row) => row.portsHere, sortValue: (row) => row.portsHere },
        {
            key: 'match',
            title: 'Match',
            cell: (row) => (
                <code style={WRAP_ANYWHERE} title={row.acl.match.length > MATCH_PREVIEW ? row.acl.match : undefined}>
                    {row.acl.match.length > MATCH_PREVIEW ? `${row.acl.match.slice(0, MATCH_PREVIEW)}…` : row.acl.match}
                </code>
            ),
            modifier: 'breakWord',
        },
    ];

    return (
        <RuleTable<SwitchAclRow>
            ariaLabel="ACLs"
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
        { key: 'ownerType', title: 'Owner type', cell: ownerKind, sortValue: ownerKind },
        {
            key: 'owner',
            title: 'Owner',
            cell: (row) => {
                const owner = ownerOf(row.group.externalIds);
                const qualifiers = ownerQualifiers(owner);
                return (
                    <>
                        <OwnerName owner={owner} roleOf={roleOf} />
                        {qualifiers && <span style={SUBTLE_TEXT}> ({qualifiers})</span>}
                    </>
                );
            },
            sortValue: ownerName,
            modifier: 'breakWord',
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
        { key: 'ports', title: 'Ports here', cell: (row) => row.portsHere.length, sortValue: (row) => row.portsHere.length },
        { key: 'acls', title: 'ACLs', cell: (row) => row.acls.length, sortValue: (row) => row.acls.length },
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
        { key: 'ownerType', title: 'Owner type', cell: ownerKind, sortValue: ownerKind },
        {
            key: 'owner',
            title: 'Owner',
            cell: (set) => (set.row ? <OwnerName owner={ownerOf(set.row.externalIds)} roleOf={roleOf} /> : <span style={SUBTLE_TEXT}>no such row in this zone</span>),
            sortValue: ownerName,
            modifier: 'breakWord',
        },
        {
            key: 'addresses',
            title: 'Addresses',
            cell: (set) => set.row?.addresses.length ?? <span style={SUBTLE_TEXT}>—</span>,
            sortValue: (set) => set.row?.addresses.length ?? -1,
        },
        { key: 'acls', title: 'ACLs naming it', cell: (set) => set.acls, sortValue: (set) => set.acls },
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
