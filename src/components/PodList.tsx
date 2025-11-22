import * as React from 'react';
import { Page, PageSection, Title, Card, CardBody, EmptyState, Spinner } from '@patternfly/react-core';
import { Table, Thead, Tbody, Tr, Th, Td } from '@patternfly/react-table';
import { Helmet } from 'react-helmet';
import { Link } from 'react-router-dom';
import { useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import { CubesIcon } from '@patternfly/react-icons';

const PodList: React.FC = () => {
    const [pods, loaded, loadError] = useK8sWatchResource<any[]>({
        groupVersionKind: { version: 'v1', kind: 'Pod' },
        isList: true,
    });

    const columns = ['Name', 'Namespace', 'Status', 'Created'];

    return (
        <>
            <Helmet>
                <title>Pod List</title>
            </Helmet>
            <PageSection>
                <Title headingLevel="h1">Pod List</Title>
            </PageSection>
            <PageSection>
                <Card isFullHeight>
                    <CardBody>
                        {!loaded && <Spinner />}
                        {loaded && loadError && (
                            <EmptyState icon={CubesIcon}>
                                <Title headingLevel="h4" size="lg">
                                    Error loading pods
                                </Title>
                                <EmptyState>
                                    {loadError.message}
                                </EmptyState>
                            </EmptyState>
                        )}
                        {loaded && !loadError && (
                            <Table aria-label="Pod List">
                                <Thead>
                                    <Tr>
                                        {columns.map((col, index) => (
                                            <Th key={index}>{col}</Th>
                                        ))}
                                    </Tr>
                                </Thead>
                                <Tbody>
                                    {pods.map((pod) => (
                                        <Tr key={pod.metadata.uid}>
                                            <Td dataLabel="Name">
                                                <Link to={`/pod-details/${pod.metadata.namespace}/${pod.metadata.name}`}>
                                                    {pod.metadata.name}
                                                </Link>
                                            </Td>
                                            <Td dataLabel="Namespace">{pod.metadata.namespace}</Td>
                                            <Td dataLabel="Status">{pod.status?.phase}</Td>
                                            <Td dataLabel="Created">{pod.metadata.creationTimestamp}</Td>
                                        </Tr>
                                    ))}
                                </Tbody>
                            </Table>
                        )}
                    </CardBody>
                </Card>
            </PageSection>
        </>
    );
};

export default PodList;
