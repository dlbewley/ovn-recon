import * as React from 'react';
import { Link } from 'react-router';
import { SearchInput, Toolbar, ToolbarContent, ToolbarItem } from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';

import { nodePagePath } from '../insights/links';
import type { SeverityCounts } from '../insights/selectors';
import { describeCounts, SeverityCountsInline } from '../insights/ui/FindingsViews';
import { nodeLogicalPath, nodePhysicalPath } from '../routes';
import { filterNodeSummaries, NodeSummary, summarizeFleet } from './overviewModel';

const NODE_COLUMNS = ['Node', 'Role', 'Findings', 'Interfaces', 'Bridges', 'Mappings', 'LLDP', 'Views'];

const subtle: React.CSSProperties = { color: 'var(--pf-t--global--text--color--subtle)' };

/**
 * Narrower cell padding, and none at the table's edges so the columns line up with
 * the toolbar: one line per node beside the explorer's tree at 1440 px
 * (ovn-recon-gbr.4).
 */
const DENSE_CELLS = {
    '--pf-v6-c-table--cell--Padding--base': '12px',
    '--pf-v6-c-table--cell--first-last-child--PaddingInline': '0px',
} as React.CSSProperties;

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** A node's NodeNetworkState on the console's own resource page. */
export const nnsResourcePath = (name: string): string =>
    `/k8s/cluster/nmstate.io~v1beta1~NodeNetworkState/${encodeURIComponent(name)}`;

export interface NodesTableProps {
    /** One summary per NodeNetworkState, in the order to list them. */
    summaries: NodeSummary[];
    /** Each node's role by node name, from the Node list. */
    roles: ReadonlyMap<string, string>;
    /** Findings counted per node name; a node with none is absent. */
    findingCounts: ReadonlyMap<string, SeverityCounts>;
    /** The NodeNetworkState list and the collector gate have both answered. */
    loaded: boolean;
    /** Why NodeNetworkState could not be read, when it could not. */
    error?: string;
    /** Offer each node's logical view: the collector is on. */
    showLogical: boolean;
}

/**
 * The node table and its toolbar: a name filter, how many nodes report a
 * NodeNetworkState, the fleet's bridge and LLDP totals, and one row per node with
 * enough fact to pick a node for a reason. Lifted out of the overview
 * (ovn-recon-gbr.3) so a host other than the overview page can draw it. The name
 * filter is its own state.
 */
const NodesTable: React.FC<NodesTableProps> = ({ summaries, roles, findingCounts, loaded, error, showLogical }) => {
    const [query, setQuery] = React.useState('');
    const fleet = React.useMemo(() => summarizeFleet(summaries), [summaries]);
    const visible = React.useMemo(() => filterNodeSummaries(summaries, query), [summaries, query]);

    return (
        <>
            <Toolbar inset={{ default: 'insetNone' }}>
                <ToolbarContent>
                    <ToolbarItem>
                        <SearchInput
                            aria-label="Filter nodes by name"
                            placeholder="Filter by name"
                            value={query}
                            onChange={(_event, value) => setQuery(value)}
                            onClear={() => setQuery('')}
                        />
                    </ToolbarItem>
                    <ToolbarItem>
                        <span style={subtle}>
                            {visible.length === summaries.length
                                ? plural(summaries.length, 'node')
                                : `${visible.length} of ${plural(summaries.length, 'node')}`}
                            {' with NodeNetworkState'}
                        </span>
                    </ToolbarItem>
                    {/* What the Physical card said, in the one place the nodes are. */}
                    <ToolbarItem align={{ default: 'alignEnd' }}>
                        <span style={subtle} data-testid="overview-fleet-summary">
                            {plural(fleet.bridgeMappings, 'bridge mapping')} across {plural(fleet.bridges, 'bridge')}
                            {' · '}
                            {fleet.nodesWithLldp === 0
                                ? 'no node reports LLDP neighbors'
                                : `${plural(fleet.nodesWithLldp, 'node')} report${fleet.nodesWithLldp === 1 ? 's' : ''} LLDP neighbors`}
                        </span>
                    </ToolbarItem>
                </ToolbarContent>
            </Toolbar>
            <Table aria-label="Nodes" variant="compact" style={DENSE_CELLS}>
                <Thead>
                    <Tr>
                        {NODE_COLUMNS.map((column) => <Th key={column} modifier="nowrap">{column}</Th>)}
                    </Tr>
                </Thead>
                <Tbody>
                    {loaded && visible.map((node) => (
                        <Tr key={node.name} data-testid={`overview-node-${node.name}`}>
                            <Td dataLabel="Node">
                                <Link to={nodePhysicalPath(node.name)}>{node.name}</Link>
                            </Td>
                            <Td dataLabel="Role">{roles.get(node.name) ?? ''}</Td>
                            <Td dataLabel="Findings" data-testid={`overview-findings-${node.name}`}>
                                {findingCounts.has(node.name) && (
                                    <Link
                                        to={nodePagePath(node.name)}
                                        aria-label={`${describeCounts(findingCounts.get(node.name)!)} on ${node.name}`}
                                    >
                                        <SeverityCountsInline counts={findingCounts.get(node.name)!} />
                                    </Link>
                                )}
                            </Td>
                            <Td dataLabel="Interfaces">{node.interfacesUp} up / {node.interfacesTotal}</Td>
                            <Td dataLabel="Bridges">{node.bridges.join(', ')}</Td>
                            <Td dataLabel="Mappings">{node.bridgeMappings}</Td>
                            <Td dataLabel="LLDP">{node.lldpNeighbors}</Td>
                            <Td dataLabel="Views">
                                <Link to={nodePhysicalPath(node.name)}>Physical</Link>
                                {showLogical && (
                                    <>
                                        {' · '}
                                        <Link to={nodeLogicalPath(node.name)}>Logical</Link>
                                    </>
                                )}
                                {' · '}
                                <a href={nnsResourcePath(node.name)} target="_blank" rel="noopener noreferrer">NNS</a>
                            </Td>
                        </Tr>
                    ))}
                    {!loaded && !error && (
                        <Tr><Td colSpan={NODE_COLUMNS.length}>Loading...</Td></Tr>
                    )}
                    {error && (
                        <Tr><Td colSpan={NODE_COLUMNS.length}>Error loading NodeNetworkStates: {error}</Td></Tr>
                    )}
                    {loaded && !error && visible.length === 0 && (
                        <Tr><Td colSpan={NODE_COLUMNS.length}>{summaries.length === 0 ? 'No NodeNetworkState resources found.' : 'No nodes match.'}</Td></Tr>
                    )}
                </Tbody>
            </Table>
        </>
    );
};

export default NodesTable;
