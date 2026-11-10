import * as React from 'react';
import { useParams, Link, useLocation } from 'react-router';
import { PageSection, Title, EmptyState, EmptyStateBody, Breadcrumb, BreadcrumbItem, ExpandableSection, Flex, FlexItem } from '@patternfly/react-core';
import { DocumentTitle, K8sResourceCommon, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import NodeVisualization from './NodeVisualization';
import { useOvnCollectorFeatureGate } from './useOvnCollectorFeatureGate';
import { NodeNetworkState, ClusterUserDefinedNetwork, UserDefinedNetwork, NetworkAttachmentDefinition, NodeNetworkConfigurationEnactment, RouteAdvertisements, SriovNetworkNodeState, Vtep } from '../types';
import { getRunningRoutes, NODE_VTEPS_ANNOTATION } from './nodeVisualizationSelectors';
import { MAIN_TABLE_ID } from './kernelRoutes';
import KernelRouteTable from './KernelRouteTable';
import { logicalViewPath, physicalViewPath } from './networkPageModel';
import { readSelectParam } from './useSelectParam';

/** Where the SR-IOV Network Operator keeps its per-node state. */
const SRIOV_OPERATOR_NAMESPACE = 'openshift-sriov-network-operator';

interface NodeNetworkStateBodyProps {
    /** The node, which is also its NodeNetworkState's name. */
    name: string;
    /**
     * Set when the body is a tab on the console's own Node details page
     * (ovn-recon-zdt.1): the host page owns the title and breadcrumbs, so the
     * body shows links to the full OVN Recon pages instead, and says plainly when
     * the node has no NodeNetworkState.
     */
    embedded?: boolean;
}

/**
 * One node's physical topology: everything the routed physical page shows below its
 * route handling. The routed page (NodeNetworkStateDetails) and the Node details tab
 * (NodeOvnReconTab) both render this; there is no second copy.
 */
export const NodeNetworkStateBody: React.FC<NodeNetworkStateBodyProps> = ({ name, embedded = false }) => {
    const location = useLocation();
    const { enabled: ovnCollectorEnabled } = useOvnCollectorFeatureGate();

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

    if (!nns && embedded) {
        return <NoNodeNetworkState name={name} />;
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
            {!embedded && <DocumentTitle>{`OVN Recon - ${displayName}`}</DocumentTitle>}
            <PageSection>
                {embedded ? (
                    <EmbeddedLinks
                        name={displayName}
                        select={readSelectParam(location.search)}
                        showLogical={ovnCollectorEnabled}
                    />
                ) : (
                    <>
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
                    </>
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

/** The tab's header: where the full pages are. A graph selection carries over. */
const EmbeddedLinks: React.FC<{ name: string; select: string | null; showLogical: boolean }> = ({
    name, select, showLogical,
}) => (
    <Flex data-testid="ovn-recon-tab-links" spaceItems={{ default: 'spaceItemsLg' }}>
        <FlexItem>
            <Link to={physicalViewPath(name, select ?? undefined)}>Open physical topology in OVN Recon</Link>
        </FlexItem>
        {showLogical && (
            <FlexItem>
                <Link to={logicalViewPath(name)}>Open logical topology in OVN Recon</Link>
            </FlexItem>
        )}
    </Flex>
);

/** The tab's empty state: a Node with no NodeNetworkState is common, not an error. */
export const NoNodeNetworkState: React.FC<{ name: string; reason?: string }> = ({ name, reason }) => (
    <PageSection>
        <EmptyState data-testid="ovn-recon-tab-no-nns">
            <Title headingLevel="h4" size="lg">No NodeNetworkState for this node</Title>
            <EmptyStateBody>
                {reason ?? (
                    <>
                        OVN Recon draws a node&apos;s physical topology from its NodeNetworkState, which the
                        Kubernetes NMState Operator reports for every node it manages. There is none
                        named {name}.
                    </>
                )}{' '}
                <Link to="/ovn-recon">Open OVN Recon</Link>.
            </EmptyStateBody>
        </EmptyState>
    </PageSection>
);

interface NodeNetworkStateDetailsProps {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    match?: any;
}

/** The routed physical page, /ovn-recon/node-network-state/:name. */
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

    if (!name) {
        return <PageSection><Title headingLevel="h1">Loading...</Title></PageSection>;
    }

    return <NodeNetworkStateBody name={name} />;
};

export default NodeNetworkStateDetails;
