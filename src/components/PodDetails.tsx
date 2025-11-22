import * as React from 'react';
import { useParams } from 'react-router-dom';
import { Page, PageSection, Title, Card, CardBody, DescriptionList, DescriptionListTerm, DescriptionListGroup, DescriptionListDescription, Spinner, EmptyState } from '@patternfly/react-core';
import { Helmet } from 'react-helmet';
import { useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import { CubesIcon } from '@patternfly/react-icons';

const PodDetails: React.FC<any> = (props) => {
    let { ns, name } = useParams<{ ns: string; name: string }>();

    if (!ns || !name) {
        const parts = window.location.pathname.split('/');
        const podDetailsIndex = parts.indexOf('pod-details');
        if (podDetailsIndex !== -1 && parts.length > podDetailsIndex + 2) {
            ns = parts[podDetailsIndex + 1];
            name = parts[podDetailsIndex + 2];
        }
    }

    const [pod, loaded, loadError] = useK8sWatchResource<any>({
        groupVersionKind: { version: 'v1', kind: 'Pod' },
        name: name,
        namespace: ns,
    });

    return (
        <>
            <Helmet>
                <title>Pod Details: {name}</title>
            </Helmet>
            <PageSection>
                <Title headingLevel="h1">Pod Details: {name}</Title>
            </PageSection>
            <PageSection>
                <Card isFullHeight>
                    <CardBody>
                        {!loaded && <Spinner />}
                        {loaded && loadError && (
                            <EmptyState icon={CubesIcon}>
                                <Title headingLevel="h4" size="lg">
                                    Error loading pod
                                </Title>
                                <EmptyState>
                                    {loadError.message}
                                </EmptyState>
                            </EmptyState>
                        )}
                        {loaded && !loadError && pod && (
                            <DescriptionList>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>Name</DescriptionListTerm>
                                    <DescriptionListDescription>{pod.metadata.name}</DescriptionListDescription>
                                </DescriptionListGroup>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>Namespace</DescriptionListTerm>
                                    <DescriptionListDescription>{pod.metadata.namespace}</DescriptionListDescription>
                                </DescriptionListGroup>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>Status</DescriptionListTerm>
                                    <DescriptionListDescription>{pod.status?.phase}</DescriptionListDescription>
                                </DescriptionListGroup>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>Node</DescriptionListTerm>
                                    <DescriptionListDescription>{pod.spec?.nodeName}</DescriptionListDescription>
                                </DescriptionListGroup>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>IP</DescriptionListTerm>
                                    <DescriptionListDescription>{pod.status?.podIP}</DescriptionListDescription>
                                </DescriptionListGroup>
                            </DescriptionList>
                        )}
                    </CardBody>
                </Card>
            </PageSection>
        </>
    );
};

export default PodDetails;
