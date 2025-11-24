import * as React from 'react';
import { PageSection, Title, Card, CardBody } from '@patternfly/react-core';
import { Table, Thead, Tr, Th, Tbody, Td } from '@patternfly/react-table';
import { useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import { Helmet } from 'react-helmet';
import { Link } from 'react-router-dom';

const NodeNetworkStateList: React.FC = () => {
    const [nodeNetworkStates, loaded, loadError] = useK8sWatchResource<any[]>({
        groupVersionKind: {
            group: 'nmstate.io',
            version: 'v1beta1',
            kind: 'NodeNetworkState',
        },
        isList: true,
    });

    const columns = ['Name', 'Created'];

    return (
        <>
            <Helmet>
                <title>Node Network State</title>
            </Helmet>
            <PageSection>
                <Title headingLevel="h1">Node Network State</Title>
            </PageSection>
            <PageSection isFilled>
                <Card>
                    <CardBody>
                        <Table aria-label="Node Network State List">
                            <Thead>
                                <Tr>
                                    {columns.map((column, columnIndex) => (
                                        <Th key={columnIndex}>{column}</Th>
                                    ))}
                                </Tr>
                            </Thead>
                            <Tbody>
                                {loaded && nodeNetworkStates?.map((nns, rowIndex) => (
                                    <Tr key={rowIndex}>
                                        <Td dataLabel={columns[0]}>
                                            <Link to={`/example/node-network-state/${nns.metadata.name}`}>
                                                {nns.metadata.name}
                                            </Link>
                                        </Td>
                                        <Td dataLabel={columns[1]}>
                                            {nns.metadata.creationTimestamp}
                                        </Td>
                                    </Tr>
                                ))}
                                {!loaded && !loadError && (
                                    <Tr>
                                        <Td colSpan={2}>Loading...</Td>
                                    </Tr>
                                )}
                                {loadError && (
                                    <Tr>
                                        <Td colSpan={2}>Error loading NodeNetworkStates: {loadError.message}</Td>
                                    </Tr>
                                )}
                            </Tbody>
                        </Table>
                    </CardBody>
                </Card>
            </PageSection>
        </>
    );
};

export default NodeNetworkStateList;
