import * as React from 'react';
import { NodeNetworkState } from '../types';
import { PageSection, Title, Card, CardBody, CardTitle } from '@patternfly/react-core';
import { Table, Thead, Tr, Th, Tbody, Td } from '@patternfly/react-table';
import { useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import { Helmet } from 'react-helmet';
import { Link } from 'react-router-dom';
import { useOvnCollectorFeatureGate } from './useOvnCollectorFeatureGate';

const NodeNetworkStateList: React.FC = () => {
    const { enabled: ovnCollectorEnabled, loaded: featureLoaded } = useOvnCollectorFeatureGate();
    const [nodeNetworkStates, loaded, loadError] = useK8sWatchResource<NodeNetworkState[]>({
        groupVersionKind: {
            group: 'nmstate.io',
            version: 'v1beta1',
            kind: 'NodeNetworkState',
        },
        isList: true,
    });

    const columns = ovnCollectorEnabled ? ['Name', 'NNS', 'Logical OVN'] : ['Name', 'NNS'];

    return (
        <>
            <Helmet>
                <title>OVN Recon - Nodes</title>
            </Helmet>
            <PageSection>
                <Title headingLevel="h1">OVN Recon - Nodes</Title>
            </PageSection>
            <PageSection isFilled>
                <Card>
                    <CardTitle>View Node Topology</CardTitle>
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
                                {loaded && featureLoaded && nodeNetworkStates?.map((nns, rowIndex) => {
                                    const nnsName = nns.metadata?.name || '';
                                    const resourcePath = `/k8s/cluster/nmstate.io~v1beta1~NodeNetworkState/${nnsName}`;
                                    return (
                                        <Tr key={rowIndex}>
                                            <Td dataLabel={columns[0]}>
                                                <Link to={`/ovn-recon/node-network-state/${nnsName}`}>
                                                    {nnsName}
                                                </Link>
                                            </Td>
                                            <Td dataLabel={columns[1]}>
                                                <a href={resourcePath} target="_blank" rel="noopener noreferrer">
                                                    NodeNetworkState
                                                </a>
                                            </Td>
                                            {ovnCollectorEnabled && (
                                                <Td dataLabel={columns[2]}>
                                                    <Link to={`/ovn-recon/ovn/${nnsName}`}>
                                                        Logical Topology
                                                    </Link>
                                                </Td>
                                            )}
                                        </Tr>
                                    );
                                })}
                                {(!loaded || !featureLoaded) && !loadError && (
                                    <Tr>
                                        <Td colSpan={columns.length}>Loading...</Td>
                                    </Tr>
                                )}
                                {loadError && (
                                    <Tr>
                                        <Td colSpan={columns.length}>Error loading NodeNetworkStates: {loadError.message}</Td>
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
