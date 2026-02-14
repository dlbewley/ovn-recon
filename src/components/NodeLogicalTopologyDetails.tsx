import * as React from 'react';
import { useParams, Link } from 'react-router-dom';
import { Helmet } from 'react-helmet';
import {
    PageSection,
    Title,
    EmptyState,
    EmptyStateBody,
    Breadcrumb,
    BreadcrumbItem,
    Card,
    CardTitle,
    CardBody,
} from '@patternfly/react-core';

import { useOvnCollectorFeatureGate } from './useOvnCollectorFeatureGate';

const NodeLogicalTopologyDetails: React.FC = () => {
    const { name = '' } = useParams<{ name: string }>();
    const { enabled, loaded, loadError } = useOvnCollectorFeatureGate();

    if (!loaded) {
        return <PageSection><Title headingLevel="h1">Loading...</Title></PageSection>;
    }

    if (loadError) {
        return (
            <PageSection>
                <Title headingLevel="h1">Error</Title>
                <p>{loadError.message}</p>
            </PageSection>
        );
    }

    if (!enabled) {
        return (
            <PageSection>
                <EmptyState>
                    <Title headingLevel="h4" size="lg">Logical OVN view is disabled</Title>
                    <EmptyStateBody>
                        Enable the <code>ovn-collector</code> feature gate in OvnRecon to access this view.
                    </EmptyStateBody>
                </EmptyState>
            </PageSection>
        );
    }

    return (
        <>
            <Helmet>
                <title>OVN Recon - Logical OVN ({name})</title>
            </Helmet>
            <PageSection>
                <Breadcrumb>
                    <BreadcrumbItem>
                        <Link to="/ovn-recon/node-network-state">OVN Recon</Link>
                    </BreadcrumbItem>
                    <BreadcrumbItem isActive>Logical OVN: {name}</BreadcrumbItem>
                </Breadcrumb>
                <Title headingLevel="h1" className="pf-u-mt-lg">Logical OVN Topology: {name}</Title>
            </PageSection>
            <PageSection isFilled>
                <Card>
                    <CardTitle>Logical topology view scaffold</CardTitle>
                    <CardBody>
                        Route and feature gate are active. Collector-backed rendering will be wired in the next task.
                    </CardBody>
                </Card>
            </PageSection>
        </>
    );
};

export default NodeLogicalTopologyDetails;
