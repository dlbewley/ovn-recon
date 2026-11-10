import * as React from 'react';
import { useParams, Link, useLocation } from 'react-router';
import { PageSection, Title, EmptyState, EmptyStateBody, Breadcrumb, BreadcrumbItem, ExpandableSection } from '@patternfly/react-core';
import { DocumentTitle, K8sResourceCommon, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import NodeVisualization from './NodeVisualization';
import { useOvnCollectorFeatureGate } from './useOvnCollectorFeatureGate';
import { NodeNetworkState, ClusterUserDefinedNetwork, UserDefinedNetwork, NetworkAttachmentDefinition, NodeNetworkConfigurationEnactment, RouteAdvertisements, SriovNetworkNodeState, Vtep } from '../types';
import { getRunningRoutes, NODE_VTEPS_ANNOTATION } from './nodeVisualizationSelectors';
import { MAIN_TABLE_ID } from './kernelRoutes';
import KernelRouteTable from './KernelRouteTable';

/** Where the SR-IOV Network Operator keeps its per-node state. */
const SRIOV_OPERATOR_NAMESPACE = 'openshift-sriov-network-operator';

interface NodeNetworkStateDetailsProps {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    match?: any;
}

const NodeNetworkStateDetails: React.FC<NodeNetworkStateDetailsProps> = (props) => {
    const params = useParams<{ name: string }>();
    const location = useLocation();
    const { enabled: ovnCollectorEnabled } = useOvnCollectorFeatureGate();

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

    const [udns] = useK8sWatchResource<UserDefinedNetwork[]>({
        groupVersionKind: {
            group: 'k8s.ovn.org',
            version: 'v1',
            kind: 'UserDefinedNetwork',
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

    const [routeAdvertisements] = useK8sWatchResource<RouteAdvertisements[]>({
        groupVersionKind: {
            group: 'k8s.ovn.org',
            version: 'v1',
            kind: 'RouteAdvertisements',
        },
        isList: true,
    });

    // The per-node record of which NNCP configured what (ovn-recon-s3t.34).
    const [allEnactments] = useK8sWatchResource<NodeNetworkConfigurationEnactment[]>({
        groupVersionKind: {
            group: 'nmstate.io',
            version: 'v1beta1',
            kind: 'NodeNetworkConfigurationEnactment',
        },
        isList: true,
    });
    const enactments = React.useMemo(
        () => (allEnactments || []).filter(
            (enactment) => enactment.metadata?.labels?.['nmstate.io/node'] === name),
        [allEnactments, name]
    );

    // EVPN (ovn-recon-s3t.53). The VTEP kind arrived with EVPN support, so on a cluster
    // without it the watch reports no such model and yields nothing; a reader who may
    // not list VTEPs gets the same. Both are ignored: the graph draws as it did before.
    const [vteps] = useK8sWatchResource<Vtep[]>({
        groupVersionKind: {
            group: 'k8s.ovn.org',
            version: 'v1',
            kind: 'VTEP',
        },
        isList: true,
    });

    // This node's Node object, for the one annotation recording which address
    // OVN-Kubernetes discovered for each VTEP here. Watched by name, never as a list.
    const nodeWatchResource = React.useMemo(() => name ? {
        groupVersionKind: {
            version: 'v1',
            kind: 'Node',
        },
        name: name,
        isList: false,
    } : null, [name]);
    const [node] = useK8sWatchResource<K8sResourceCommon>(nodeWatchResource);
    // Passed on as the annotation string alone: a Node's status changes constantly,
    // and handing the whole object down would rebuild the graph on every heartbeat.
    const nodeVtepsAnnotation = node?.metadata?.annotations?.[NODE_VTEPS_ANNOTATION];

    // SR-IOV (ovn-recon-s3t.66). The operator keeps one SriovNetworkNodeState per node,
    // named for it, in its own namespace. On a cluster without the operator the kind
    // does not exist and the watch yields nothing; a reader who may not get it gets the
    // same. Either way the graph falls back to what NodeNetworkState alone says.
    const sriovNodeStateWatchResource = React.useMemo(() => name ? {
        groupVersionKind: {
            group: 'sriovnetwork.openshift.io',
            version: 'v1',
            kind: 'SriovNetworkNodeState',
        },
        namespace: SRIOV_OPERATOR_NAMESPACE,
        name: name,
        isList: false,
    } : null, [name]);
    const [sriovNodeState] = useK8sWatchResource<SriovNetworkNodeState>(sriovNodeStateWatchResource);

    // The node's main routing table (ovn-recon-dp7.2): every table is in
    // routes.running, but VRF tables belong to their VRF's drawer.
    const mainRoutes = React.useMemo(
        () => (nns ? getRunningRoutes(nns).filter((route) => route.tableId === MAIN_TABLE_ID) : []),
        [nns]
    );

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
            <DocumentTitle>{`OVN Recon - ${displayName}`}</DocumentTitle>
            <PageSection>
                <Breadcrumb>
                    <BreadcrumbItem>
                        <Link to="/ovn-recon">OVN Recon</Link>
                    </BreadcrumbItem>
                    <BreadcrumbItem isActive>{displayName}</BreadcrumbItem>
                </Breadcrumb>
                <Title headingLevel="h1" className="pf-u-mt-lg">Node Network Topology: {displayName}</Title>
                {ovnCollectorEnabled && (
                    <p className="pf-u-mt-sm">
                        <Link to={`/ovn-recon/ovn/${encodeURIComponent(displayName)}`}>
                            View logical OVN topology for this node
                        </Link>
                    </p>
                )}
                {mainRoutes.length > 0 && (
                    <ExpandableSection
                        className="pf-u-mt-md"
                        toggleText="Main routing table"
                        data-testid="main-routing-table"
                    >
                        <KernelRouteTable routes={mainRoutes} ariaLabel="Main routing table" />
                    </ExpandableSection>
                )}
            </PageSection>
            <PageSection isFilled>
                <NodeVisualization
                    nns={nns} cudns={cudns} udns={udns} nads={nads}
                    routeAdvertisements={routeAdvertisements} enactments={enactments}
                    vteps={vteps || undefined} nodeVtepsAnnotation={nodeVtepsAnnotation}
                    sriovNodeState={sriovNodeState || undefined}
                />
            </PageSection>
        </>
    );
};

export default NodeNetworkStateDetails;
