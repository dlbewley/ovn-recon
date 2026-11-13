import * as React from 'react';
import { Link } from 'react-router';
import {
    Card,
    CardBody,
    CardFooter,
    CardTitle,
    Grid,
    GridItem,
    PageSection,
    Title,
} from '@patternfly/react-core';
import { DocumentTitle, K8sResourceCommon, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';

import {
    ClusterUserDefinedNetwork,
    NetworkAttachmentDefinition,
    NodeNetworkConfigurationEnactment,
    NodeNetworkState,
    RouteAdvertisements,
    UserDefinedNetwork,
} from '../types';
import ClusterSearch from './ClusterSearch';
import CollectorStatus, { CollectorState, useCollectorState } from './CollectorStatus';
import FindingsCard from '../insights/ui/FindingsCard';
import { useClusterFindings, useHideInfoFindings, visibleFindings } from '../insights/ui/useFindings';
import { clusterLogicalPath } from '../routes';
import { NetworkInputs, NETWORKS_PATH } from './networkPageModel';
import NetworksTable from './NetworksTable';
import NodesTable from './NodesTable';
import {
    findingCountsByNode,
    nodeRole,
    OVERVIEW_NETWORK_LIMIT,
    OverviewNetworkRow,
    overviewNetworkRows,
    summarizeNode,
} from './overviewModel';

/**
 * No longer routed (ovn-recon-gbr.4): the explorer shell, `OvnReconApp`, lands on its
 * Cluster scope instead, drawn from the same parts and from `useOverviewData`, which
 * the shell still calls. The page stays until the passthrough is removed
 * (ovn-recon-gbr.10).
 *
 * The single front door for OVN Recon (ovn-recon-brx), laid out by ovn-recon-nt4.9.
 * One Networking entry lands here. Top to bottom: a search over every node
 * (ovn-recon-tpp.2); what is wrong (the findings summary) beside what exists (the
 * networks table, ovn-recon-nfs.6); the node table, with enough per-node fact to pick
 * a node for a reason; and one line on the collector, which also opens the cluster
 * logical view.
 *
 * Everything sits in one PatternFly Grid. Each row's cells fill all twelve columns
 * from the xl breakpoint and every cell takes the full width below it, so the page
 * fills a wide window and stacks on a narrow one. No cell depends on the collector:
 * with it disabled the status line says so and nothing else moves.
 *
 * `OverviewBody` draws the page from what it is handed; the routed page only gathers
 * it (`useOverviewData`), as the other routed pages wrap their bodies. The nodes
 * table, the networks table and the collector line are components of their own
 * (`NodesTable`, `NetworksTable`, `CollectorStatus`, ovn-recon-gbr.3) that this page
 * places in its grid, so another host can place them elsewhere.
 */

const subtle: React.CSSProperties = { color: 'var(--pf-t--global--text--color--subtle)' };

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** Stable empties: a fresh `[]` per render would re-evaluate every finding. */
const NO_NODES: K8sResourceCommon[] = [];
const NO_CUDNS: ClusterUserDefinedNetwork[] = [];
const NO_UDNS: UserDefinedNetwork[] = [];
const NO_NADS: NetworkAttachmentDefinition[] = [];
const NO_ROUTE_ADVERTISEMENTS: RouteAdvertisements[] = [];
const NO_ENACTMENTS: NodeNetworkConfigurationEnactment[] = [];

const listOr = <T,>(list: T[] | undefined | null, empty: T[]): T[] => (Array.isArray(list) ? list : empty);

// Part of OverviewBodyProps, so it stays importable from here.
export type { CollectorState };

export interface OverviewBodyProps {
    /** Every node's NodeNetworkState; undefined or null while loading, refused or absent. */
    nodeNetworkStates: NodeNetworkState[] | undefined | null;
    nodeNetworkStatesLoaded: boolean;
    /** Why NodeNetworkState could not be read, when it could not. */
    nodeNetworkStatesError?: string;
    nodes: K8sResourceCommon[];
    cudns: ClusterUserDefinedNetwork[];
    udns: UserDefinedNetwork[];
    nads: NetworkAttachmentDefinition[];
    routeAdvertisements: RouteAdvertisements[];
    enactments: NodeNetworkConfigurationEnactment[];
    /** The CUDN, UDN and NAD watches have each settled: loaded, or failed. */
    networksLoaded: boolean;
    collector: CollectorState;
}

// --- Networks ---------------------------------------------------------------------

/**
 * The networks card (ovn-recon-nfs.6): the networks table under a title that opens the
 * networks page. Capped, so a cluster with many networks still shows its nodes without
 * a long scroll; the rows come sorted with findings first, so the cap hides nothing
 * that needs a look.
 */
const NetworksCard: React.FC<{ rows: OverviewNetworkRow[]; loaded: boolean }> = ({ rows, loaded }) => {
    const shown = rows.slice(0, OVERVIEW_NETWORK_LIMIT);
    return (
        <Card isFullHeight data-testid="overview-networks-card">
            <CardTitle>
                <Link to={NETWORKS_PATH}>Networks</Link>
                {loaded && <span style={{ ...subtle, fontWeight: 'normal', marginInlineStart: '0.5em' }}>{rows.length}</span>}
            </CardTitle>
            <CardBody>
                <NetworksTable rows={shown} loaded={loaded} />
            </CardBody>
            {loaded && rows.length > shown.length && (
                <CardFooter data-testid="overview-networks-more">
                    <span style={subtle}>Showing {shown.length} of {plural(rows.length, 'network')}.</span>{' '}
                    <Link to={NETWORKS_PATH}>View all networks</Link>
                </CardFooter>
            )}
        </Card>
    );
};

// --- The page ---------------------------------------------------------------------

export const OverviewBody: React.FC<OverviewBodyProps> = ({
    nodeNetworkStates,
    nodeNetworkStatesLoaded: nnsLoaded,
    nodeNetworkStatesError: nnsError,
    nodes,
    cudns,
    udns,
    nads,
    routeAdvertisements,
    enactments,
    networksLoaded,
    collector,
}) => {
    const { enabled: collectorEnabled, gateLoaded } = collector;
    const showLogical = gateLoaded && collectorEnabled;
    const nnsSettled = nnsLoaded || Boolean(nnsError);

    // Findings across the cluster (ovn-recon-7i6.1): network rules once, node rules on
    // every node. Any list that is missing or refused reads as empty.
    const allFindings = useClusterFindings({
        nodeNetworkStates,
        nodeNetworkStatesLoaded: nnsLoaded && !nnsError,
        cudns,
        udns,
        nads,
        enactments,
    });
    const [hideInfo, setHideInfo] = useHideInfoFindings();
    const findings = React.useMemo(() => visibleFindings(allFindings, hideInfo), [allFindings, hideInfo]);
    const findingCounts = React.useMemo(() => findingCountsByNode(findings), [findings]);

    const summaries = React.useMemo(
        () => (nodeNetworkStates ?? []).map(summarizeNode).sort((a, b) => a.name.localeCompare(b.name)),
        [nodeNetworkStates],
    );
    const rolesByNode = React.useMemo(() => {
        const roles = new Map<string, string>();
        for (const node of nodes) {
            if (node.metadata?.name) roles.set(node.metadata.name, nodeRole(node));
        }
        return roles;
    }, [nodes]);
    const nodeNames = React.useMemo(() => summaries.map((summary) => summary.name), [summaries]);

    const networkInputs = React.useMemo<NetworkInputs>(
        () => ({ cudns, udns, nads, routeAdvertisements }),
        [cudns, udns, nads, routeAdvertisements],
    );
    const networkRows = React.useMemo(
        () => overviewNetworkRows(
            networkInputs,
            nnsLoaded && !nnsError && Array.isArray(nodeNetworkStates) ? nodeNetworkStates : undefined,
            findings,
        ),
        [networkInputs, nodeNetworkStates, nnsLoaded, nnsError, findings],
    );

    return (
        <>
            <DocumentTitle>OVN Recon</DocumentTitle>
            <PageSection>
                <Title headingLevel="h1">OVN Recon</Title>
                <p style={subtle}>
                    Physical and logical network topology across {plural(summaries.length, 'node')}
                </p>
            </PageSection>

            <PageSection isFilled>
                <Grid hasGutter data-testid="overview-grid">
                    <GridItem span={12}>
                        <ClusterSearch
                            nodeNetworkStates={nodeNetworkStates ?? undefined}
                            nodes={nodes}
                            stateLoaded={nnsSettled}
                            stateError={nnsError}
                            collectorEnabled={collectorEnabled}
                            gateLoaded={gateLoaded}
                        />
                    </GridItem>

                    <GridItem span={12} xl={4}>
                        <FindingsCard
                            findings={findings}
                            allFindings={allFindings}
                            hideInfo={hideInfo}
                            onHideInfoChange={setHideInfo}
                            nodeNames={nodeNames}
                            loaded={nnsSettled}
                            unavailable={nnsError ? 'NodeNetworkStates could not be read, so node findings are unknown.' : undefined}
                        />
                    </GridItem>
                    <GridItem span={12} xl={8}>
                        <NetworksCard rows={networkRows} loaded={networksLoaded} />
                    </GridItem>

                    <GridItem span={12}>
                        <Card data-testid="overview-nodes-card">
                            <CardTitle>Nodes</CardTitle>
                            <CardBody>
                                <NodesTable
                                    summaries={summaries}
                                    roles={rolesByNode}
                                    findingCounts={findingCounts}
                                    loaded={nnsLoaded && gateLoaded}
                                    error={nnsError}
                                    showLogical={showLogical}
                                />
                            </CardBody>
                        </Card>
                    </GridItem>

                    <GridItem span={12}>
                        {/* The line replaced the Cluster logical topology card, so here it
                            also carries that card's way into the cluster view. */}
                        <Card data-testid="overview-collector-status">
                            <CardBody>
                                <CollectorStatus
                                    collector={collector}
                                    label={<strong>Cluster logical topology</strong>}
                                    action={showLogical ? <Link to={clusterLogicalPath()}>Open cluster view</Link> : undefined}
                                />
                            </CardBody>
                        </Card>
                    </GridItem>
                </Grid>
            </PageSection>
        </>
    );
};

// --- Data -------------------------------------------------------------------------

const errorText = (error: unknown): string | undefined => {
    if (!error) return undefined;
    return (error instanceof Error ? error.message : (error as { message?: string }).message) || String(error);
};

/** Everything the overview reads: the watches the plugin already makes, and the collector. */
export const useOverviewData = (): OverviewBodyProps => {
    const [nodeNetworkStates, nnsLoaded, nnsError] = useK8sWatchResource<NodeNetworkState[]>({
        groupVersionKind: { group: 'nmstate.io', version: 'v1beta1', kind: 'NodeNetworkState' },
        isList: true,
    });
    const [nodes] = useK8sWatchResource<K8sResourceCommon[]>({
        groupVersionKind: { version: 'v1', kind: 'Node' },
        isList: true,
    });
    const [cudns, cudnsLoaded, cudnsError] = useK8sWatchResource<ClusterUserDefinedNetwork[]>({
        groupVersionKind: { group: 'k8s.ovn.org', version: 'v1', kind: 'ClusterUserDefinedNetwork' },
        isList: true,
    });
    const [udns, udnsLoaded, udnsError] = useK8sWatchResource<UserDefinedNetwork[]>({
        groupVersionKind: { group: 'k8s.ovn.org', version: 'v1', kind: 'UserDefinedNetwork' },
        isList: true,
    });
    const [nads, nadsLoaded, nadsError] = useK8sWatchResource<NetworkAttachmentDefinition[]>({
        groupVersionKind: { group: 'k8s.cni.cncf.io', version: 'v1', kind: 'NetworkAttachmentDefinition' },
        isList: true,
    });
    const [routeAdvertisements] = useK8sWatchResource<RouteAdvertisements[]>({
        groupVersionKind: { group: 'k8s.ovn.org', version: 'v1', kind: 'RouteAdvertisements' },
        isList: true,
    });
    // The per-node record of which NNCP configured what, for the findings that read it
    // (bond-degraded, nnce-failing), as the node page watches it. Without nmstate, or
    // without permission, the watch yields nothing and those rules stay quiet.
    const [enactments] = useK8sWatchResource<NodeNetworkConfigurationEnactment[]>({
        groupVersionKind: { group: 'nmstate.io', version: 'v1beta1', kind: 'NodeNetworkConfigurationEnactment' },
        isList: true,
    });
    const collector = useCollectorState();

    return {
        nodeNetworkStates,
        nodeNetworkStatesLoaded: nnsLoaded,
        nodeNetworkStatesError: errorText(nnsError),
        nodes: listOr(nodes, NO_NODES),
        cudns: listOr(cudns, NO_CUDNS),
        udns: listOr(udns, NO_UDNS),
        nads: listOr(nads, NO_NADS),
        routeAdvertisements: listOr(routeAdvertisements, NO_ROUTE_ADVERTISEMENTS),
        enactments: listOr(enactments, NO_ENACTMENTS),
        // A kind the cluster does not serve, or one the user may not list, has settled
        // too: the table then lists what the other kinds hold.
        networksLoaded: (cudnsLoaded || Boolean(cudnsError))
            && (udnsLoaded || Boolean(udnsError))
            && (nadsLoaded || Boolean(nadsError)),
        collector,
    };
};

/** The routed page: gathers the data and hands it to the body. */
const OvnReconOverview: React.FC = () => <OverviewBody {...useOverviewData()} />;

export default OvnReconOverview;
