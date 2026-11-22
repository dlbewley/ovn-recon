import * as React from 'react';
import { Card, CardBody, CardTitle } from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';

import { APPLIED_CONFIG_MAP, AppliedComparison } from './cnoAppliedModel';

/**
 * The fields of the operator's spec it has not applied (ovn-recon-n7r.5): the spec's
 * value beside the one ConfigMap applied-cluster last recorded. Drawn only when they differ.
 */
const code: React.CSSProperties = { fontSize: 'var(--pf-t--global--font--size--sm)', overflowWrap: 'anywhere' };

const AppliedSpecCard: React.FC<{ comparison: AppliedComparison }> = ({ comparison }) => (
    <Card data-testid="network-config-applied">
        <CardTitle>Not applied yet</CardTitle>
        <CardBody>
            <Table variant="compact" aria-label="Fields not applied yet">
                <Thead>
                    <Tr>
                        <Th>Field</Th>
                        <Th>In the spec</Th>
                        <Th>Last applied ({APPLIED_CONFIG_MAP})</Th>
                    </Tr>
                </Thead>
                <Tbody>
                    {comparison.differences.map((difference) => (
                        <Tr key={difference.path} data-testid="network-config-applied-difference">
                            <Td dataLabel="Field"><code style={code}>{difference.path}</code></Td>
                            <Td dataLabel="In the spec"><code style={code}>{difference.spec}</code></Td>
                            <Td dataLabel="Last applied"><code style={code}>{difference.applied}</code></Td>
                        </Tr>
                    ))}
                </Tbody>
            </Table>
        </CardBody>
    </Card>
);

export default AppliedSpecCard;
