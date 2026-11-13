import * as React from 'react';
import { Link } from 'react-router';
import { Label } from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';

import { describeCounts, SeverityCountsInline } from '../insights/ui/FindingsViews';
import { NetworkInputs, networkSummaryFacts } from './networkPageModel';
import { NETWORK_KIND_LABEL, OverviewNetworkRow } from './overviewModel';

const NETWORK_COLUMNS = ['Name', 'Kind', 'Topology', 'Role', 'Nodes wired', 'Findings'];
const CARRIES_COLUMN = 'Physical network or subnets';

/** What the network carries, as the networks page listed it: its physical network, bridge or subnets. */
const carries = (row: OverviewNetworkRow, inputs: NetworkInputs): string => {
    const value = row.record.physicalNetworkName ?? row.record.bridge
        ?? networkSummaryFacts(row.record, inputs).find((fact) => fact.label === 'Subnets')?.value;
    return typeof value === 'string' ? value : '';
};

const networkLabel = (row: OverviewNetworkRow): string =>
    (row.record.namespace ? `${row.record.namespace}/${row.record.name}` : row.record.name);

const networkTestId = (row: OverviewNetworkRow): string =>
    [row.record.kind, row.record.namespace, row.record.name].filter(Boolean).join('-');

export interface NetworksTableProps {
    /** The rows to draw, in order. A host that caps the list hands over the capped rows. */
    rows: OverviewNetworkRow[];
    /** The CUDN, UDN and NAD watches have each settled: loaded, or failed. */
    loaded: boolean;
    /**
     * Add the "Physical network or subnets" column, read from these: the full list
     * on the explorer's Networks tab (ovn-recon-gbr.4) keeps what the networks page
     * showed.
     */
    inputs?: NetworkInputs;
}

/**
 * The networks table (ovn-recon-nfs.6): CUDN, UDN and NAD-only networks with the
 * nodes each is wired on and what was found about it, each row opening its network
 * page. Lifted out of the overview (ovn-recon-gbr.3) so a host other than the
 * overview page can draw it.
 */
const NetworksTable: React.FC<NetworksTableProps> = ({ rows, loaded, inputs }) => {
    const columns = inputs
        ? [...NETWORK_COLUMNS.slice(0, 4), CARRIES_COLUMN, ...NETWORK_COLUMNS.slice(4)]
        : NETWORK_COLUMNS;
    return (
        <Table aria-label="Networks" variant="compact">
            <Thead>
                {/* nowrap: a compact table otherwise cuts "Nodes wired" short with room to spare. */}
                <Tr>{columns.map((column) => <Th key={column} modifier="nowrap">{column}</Th>)}</Tr>
            </Thead>
            <Tbody>
                {loaded && rows.map((row) => (
                    <Tr key={row.key} data-testid={`overview-network-${networkTestId(row)}`}>
                        <Td dataLabel="Name">
                            <Link to={row.path}>{networkLabel(row)}</Link>
                            {row.notCreated && (
                                <Label
                                    isCompact
                                    status="danger"
                                    style={{ marginInlineStart: 'var(--pf-t--global--spacer--sm)' }}
                                    data-testid="overview-network-not-created"
                                >
                                    Not created
                                </Label>
                            )}
                        </Td>
                        <Td dataLabel="Kind">{NETWORK_KIND_LABEL[row.record.kind]}</Td>
                        <Td dataLabel="Topology">{row.record.topology}</Td>
                        <Td dataLabel="Role">{row.record.role ?? ''}</Td>
                        {inputs && <Td dataLabel={CARRIES_COLUMN}>{carries(row, inputs)}</Td>}
                        <Td dataLabel="Nodes wired">
                            {row.wired ? `${row.wired.wired} of ${row.wired.total}` : '-'}
                        </Td>
                        <Td dataLabel="Findings" data-testid={`overview-network-findings-${networkTestId(row)}`}>
                            {row.findings.total > 0 && (
                                <Link to={row.path} aria-label={`${describeCounts(row.findings)} on ${networkLabel(row)}`}>
                                    <SeverityCountsInline counts={row.findings} />
                                </Link>
                            )}
                        </Td>
                    </Tr>
                ))}
                {!loaded && <Tr><Td colSpan={columns.length}>Loading...</Td></Tr>}
                {loaded && rows.length === 0 && (
                    <Tr><Td colSpan={columns.length}>No networks found.</Td></Tr>
                )}
            </Tbody>
        </Table>
    );
};

export default NetworksTable;
