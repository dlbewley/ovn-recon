import * as React from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import { PageSection, Title, EmptyState, EmptyStateBody, Breadcrumb, BreadcrumbItem } from '@patternfly/react-core';
import { useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import { Helmet } from 'react-helmet';
import NodeVisualization from './NodeVisualization';
import { NodeNetworkState, ClusterUserDefinedNetwork, NetworkAttachmentDefinition } from '../types';

interface NodeNetworkStateDetailsProps {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    match?: any;
}

const NodeNetworkStateDetails: React.FC<NodeNetworkStateDetailsProps> = (props) => {
    const params = useParams<{ name: string }>();
    const location = useLocation();

    // Fallback to props.match.params.name if useParams is empty (common in Console plugins)
    // Also fallback to manual URL parsing if router fails
    let name = params.name || props?.match?.params?.name;
    let pathSegments: string[] = [];

    if (!name) {
        // Aggressive fallback: get the last segment of the URL
        pathSegments = location.pathname.split('/').filter(p => p);
        if (pathSegments.length > 0) {
            const lastSegment = pathSegments[pathSegments.length - 1];
            // Ensure we don't pick up 'node-network-state' if the name is missing
            if (lastSegment !== 'node-network-state') {
                name = lastSegment;
            }
        }
    }

    const watchResource = React.useMemo(() => name ? {
        groupVersionKind: {
            group: 'nmstate.io',
            version: 'v1beta1',
            kind: 'NodeNetworkState',
        },
        name: name,
        isList: false,
    } : null, [name]);

    const [nns, loaded, loadError] = useK8sWatchResource<NodeNetworkState>(watchResource);

    const [cudns] = useK8sWatchResource<ClusterUserDefinedNetwork[]>({
        groupVersionKind: {
            group: 'k8s.ovn.org',
            version: 'v1',
            kind: 'ClusterUserDefinedNetwork',
        },
        isList: true,
    });

    const [nads] = useK8sWatchResource<NetworkAttachmentDefinition[]>({
        groupVersionKind: {
            group: 'k8s.cni.cncf.io',
            version: 'v1',
            kind: 'NetworkAttachmentDefinition',
        },
        isList: true,
    });

    if (!name) {
        return <PageSection><Title headingLevel="h1">Loading...</Title></PageSection>;
    }

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

    if (!nns) {
        return (
            <PageSection>
                <EmptyState>
                    <Title headingLevel="h4" size="lg">
                        Node Network State Not Found
                    </Title>
                    <EmptyStateBody>
                        The requested NodeNetworkState resource "{name}" could not be found.
                    </EmptyStateBody>
                </EmptyState>
            </PageSection>
        );
    }

    const displayName = nns?.metadata?.name || name || 'Unknown Node';

    return (
        <>
            <Helmet>
                <title>Node Network State: {displayName}</title>
            </Helmet>
            <PageSection>
                <Breadcrumb>
                    <BreadcrumbItem>
                        <Link to="/ovn-recon/node-network-state">Node Network State</Link>
                    </BreadcrumbItem>
                    <BreadcrumbItem isActive>{displayName}</BreadcrumbItem>
                </Breadcrumb>
                <Title headingLevel="h1" className="pf-u-mt-lg">Node Network State: {displayName}</Title>
            </PageSection>
            <PageSection isFilled>
                <NodeVisualization nns={nns} cudns={cudns} nads={nads} />
            </PageSection>
        </>
    );
};

export default NodeNetworkStateDetails;
