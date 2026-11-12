import * as React from 'react';
import { Link } from 'react-router';
import {
    Button,
    Card,
    CardBody,
    CardFooter,
    CardTitle,
    DescriptionList,
    DescriptionListDescription,
    DescriptionListGroup,
    DescriptionListTerm,
    Flex,
    FlexItem,
    Grid,
    GridItem,
    Label,
    PageSection,
    Popover,
    SearchInput,
    Title,
    Toolbar,
    ToolbarContent,
    ToolbarItem,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { DocumentTitle, K8sResourceCommon, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';

import {
    ClusterLogicalTopology,
    ClusterUserDefinedNetwork,
    NetworkAttachmentDefinition,
    NodeNetworkConfigurationEnactment,
    NodeNetworkState,
    RouteAdvertisements,
    UserDefinedNetwork,
} from '../types';
import ClusterSearch from './ClusterSearch';
import FindingsCard from '../insights/ui/FindingsCard';
import { describeCounts, SeverityCountsInline } from '../insights/ui/FindingsViews';
import { useClusterFindings, useHideInfoFindings, visibleFindings } from '../insights/ui/useFindings';
import { nodePagePath } from '../insights/links';
import { fetchClusterTopology } from './collectorApi';
import { NetworkInputs, NETWORKS_PATH } from './networkPageModel';
import { freshnessFromAge } from './snapshotFreshness';
import SnapshotStatusLine, { formatAge, ovnReleaseOf, summarizeOvnZones } from './SnapshotStatusLine';
import { useOvnCollectorFeatureGate } from './useOvnCollectorFeatureGate';
import {
    filterNodeSummaries,
    findingCountsByNode,
    NETWORK_KIND_LABEL,
    nodeRole,
    OVERVIEW_NETWORK_LIMIT,
    OverviewNetworkRow,
    overviewNetworkRows,
    snapshotAges,
    summarizeFleet,
    summarizeNode,
} from './overviewModel';

/**
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
 * it (`useOverviewData`), as the other routed pages wrap their bodies.
 */

// Same cadence as the cluster view: the aggregate probes every zone, so it
// is not something to hammer from a page people leave open.
const COLLECTOR_REFRESH_MS = 60000;

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

const nnsResourcePath = (name: string): string =>
    `/k8s/cluster/nmstate.io~v1beta1~NodeNetworkState/${encodeURIComponent(name)}`;

/** What the page knows about the collector without asking it anything new. */
export interface CollectorState {
    /** `spec.collector.enabled` on the OvnRecon resource. */
    enabled: boolean;
    /** Whether `enabled` is known yet. */
    gateLoaded: boolean;
    /** The last aggregate the collector answered with. */
    topology: ClusterLogicalTopology | null;
    /** Why the last request failed; empty after one that worked. */
    error: string;
    loading: boolean;
}

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

const NETWORK_COLUMNS = ['Name', 'Kind', 'Topology', 'Role', 'Nodes wired', 'Findings'];

const networkLabel = (row: OverviewNetworkRow): string =>
    (row.record.namespace ? `${row.record.namespace}/${row.record.name}` : row.record.name);

const networkTestId = (row: OverviewNetworkRow): string =>
    [row.record.kind, row.record.namespace, row.record.name].filter(Boolean).join('-');

/**
 * The networks table (ovn-recon-nfs.6): every CUDN, UDN and NAD-only network with the
 * nodes it is wired on and what was found about it, each row opening its network page.
 * Capped, so a cluster with many networks still shows its nodes without a long scroll;
 * the rows come sorted with findings first, so the cap hides nothing that needs a look.
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
                <Table aria-label="Networks" variant="compact">
                    <Thead>
                        {/* nowrap: a compact table otherwise cuts "Nodes wired" short with room to spare. */}
                        <Tr>{NETWORK_COLUMNS.map((column) => <Th key={column} modifier="nowrap">{column}</Th>)}</Tr>
                    </Thead>
                    <Tbody>
                        {loaded && shown.map((row) => (
                            <Tr key={row.key} data-testid={`overview-network-${networkTestId(row)}`}>
                                <Td dataLabel="Name">
                                    <Link to={row.path}>{networkLabel(row)}</Link>
                                    {row.notCreated && (
                                        <Label
                                            isCompact
                                            status="danger"
                                            style={{ marginInlineStart: 'var(--pf-t--global--spacer--sm)' }}
                                            data-testid="overview-network-not-created"
                                        >
                                            Not created
                                        </Label>
                                    )}
                                </Td>
                                <Td dataLabel="Kind">{NETWORK_KIND_LABEL[row.record.kind]}</Td>
                                <Td dataLabel="Topology">{row.record.topology}</Td>
                                <Td dataLabel="Role">{row.record.role ?? ''}</Td>
                                <Td dataLabel="Nodes wired">
                                    {row.wired ? `${row.wired.wired} of ${row.wired.total}` : '-'}
                                </Td>
                                <Td dataLabel="Findings" data-testid={`overview-network-findings-${networkTestId(row)}`}>
                                    {row.findings.total > 0 && (
                                        <Link to={row.path} aria-label={`${describeCounts(row.findings)} on ${networkLabel(row)}`}>
                                            <SeverityCountsInline counts={row.findings} />
                                        </Link>
                                    )}
                                </Td>
                            </Tr>
                        ))}
                        {!loaded && <Tr><Td colSpan={NETWORK_COLUMNS.length}>Loading...</Td></Tr>}
                        {loaded && rows.length === 0 && (
                            <Tr><Td colSpan={NETWORK_COLUMNS.length}>No networks found.</Td></Tr>
                        )}
                    </Tbody>
                </Table>
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

// --- Collector --------------------------------------------------------------------

const MAX_WARNINGS_SHOWN = 5;

const Detail: React.FC<{ term: string; children: React.ReactNode }> = ({ term, children }) => (
    <DescriptionListGroup>
        <DescriptionListTerm>{term}</DescriptionListTerm>
        <DescriptionListDescription>{children}</DescriptionListDescription>
    </DescriptionListGroup>
);

/**
 * The collector in one line (ovn-recon-nt4.9): freshness, how many node databases the
 * cluster view is assembled from, and anything degraded, with the rest behind
 * "Collector details". It replaces the Cluster logical topology card, so it also
 * carries that card's way into the cluster view. Only what the aggregate response and
 * the feature gate already say is shown here.
 */
const CollectorStatus: React.FC<{ collector: CollectorState }> = ({ collector }) => {
    const { enabled, gateLoaded, topology, error, loading } = collector;

    // Keep the age text moving between refetches.
    const [ageTick, setAgeTick] = React.useState(0);
    React.useEffect(() => {
        const timer = window.setInterval(() => setAgeTick((tick) => tick + 1), 30000);
        return () => window.clearInterval(timer);
    }, []);
    const ages = React.useMemo(
        () => snapshotAges((topology?.snapshots ?? []).map((snapshot) => snapshot.metadata?.generatedAt)),
        // ageTick is a deliberate extra dependency: it forces the ages to recompute.
        [topology, ageTick],
    );
    const ovn = React.useMemo(
        () => summarizeOvnZones((topology?.snapshots ?? []).map((snapshot) => snapshot.database?.nbGlobal)),
        [topology],
    );

    const active = gateLoaded && enabled;
    const unreachable = active && Boolean(error) && !topology;
    const warnings = topology?.warnings ?? [];
    const releases = [...new Set((ovn?.versions ?? []).map(ovnReleaseOf))];

    let details: React.ReactNode;
    if (!active) {
        details = (
            <p>
                The logical topology views and the OVN part of search need the collector. It is switched on
                with <code>spec.collector.enabled</code> on the OvnRecon resource.
            </p>
        );
    } else if (unreachable) {
        details = (
            <>
                <p>The collector did not answer: {error}</p>
                <p style={subtle}>Retried every {COLLECTOR_REFRESH_MS / 1000} seconds.</p>
            </>
        );
    } else if (!topology) {
        details = <p>Waiting for the collector&apos;s first answer.</p>;
    } else {
        details = (
            <DescriptionList isCompact isHorizontal horizontalTermWidthModifier={{ default: '16ch' }}>
                <Detail term="Source health">{topology.metadata.sourceHealth || 'unknown'}</Detail>
                <Detail term="Node databases">{topology.snapshots.length}</Detail>
                {ages.oldestMs != null && <Detail term="Oldest snapshot">{formatAge(ages.oldestMs)}</Detail>}
                {ages.newestMs != null && <Detail term="Newest snapshot">{formatAge(ages.newestMs)}</Detail>}
                {releases.length > 0 && <Detail term="OVN version">{releases.join(', ')}</Detail>}
                <Detail term="Refreshed">every {COLLECTOR_REFRESH_MS / 1000} seconds</Detail>
                {error && <Detail term="Last refresh failed">{error}</Detail>}
                {warnings.length > 0 && (
                    <Detail term="Warnings">
                        {warnings.slice(0, MAX_WARNINGS_SHOWN).map((warning) => (
                            <div key={`${warning.code}:${warning.message}`} style={{ overflowWrap: 'anywhere' }}>
                                {warning.code}: {warning.message}
                            </div>
                        ))}
                        {warnings.length > MAX_WARNINGS_SHOWN && (
                            <div style={subtle}>and {warnings.length - MAX_WARNINGS_SHOWN} more</div>
                        )}
                    </Detail>
                )}
            </DescriptionList>
        );
    }

    return (
        <Card data-testid="overview-collector-status">
            <CardBody>
                <Flex
                    spaceItems={{ default: 'spaceItemsMd' }}
                    alignItems={{ default: 'alignItemsCenter' }}
                    rowGap={{ default: 'rowGapSm' }}
                >
                    <FlexItem>
                        <strong>Cluster logical topology</strong>
                    </FlexItem>
                    {!gateLoaded && <FlexItem><span style={subtle}>Loading...</span></FlexItem>}
                    {gateLoaded && !enabled && (
                        <FlexItem><Label isCompact color="grey">Collector not enabled</Label></FlexItem>
                    )}
                    {unreachable && (
                        <FlexItem><Label isCompact status="warning">Collector unreachable</Label></FlexItem>
                    )}
                    {active && !unreachable && (
                        <FlexItem>
                            <SnapshotStatusLine
                                freshness={freshnessFromAge(ages.oldestMs)}
                                ageMs={ages.oldestMs}
                                ageQualifier="oldest node "
                                zoneCount={topology?.snapshots.length}
                                sourceHealth={topology?.metadata.sourceHealth}
                                isLoading={loading && !topology}
                            />
                        </FlexItem>
                    )}
                    {active && warnings.length > 0 && (
                        <FlexItem>
                            <Label isCompact color="yellow">{plural(warnings.length, 'collector warning')}</Label>
                        </FlexItem>
                    )}
                    {gateLoaded && (
                        <FlexItem>
                            <Popover
                                aria-label="Collector details"
                                headerContent="Collector"
                                bodyContent={<div data-testid="overview-collector-details">{details}</div>}
                                minWidth="min(24rem, 90vw)"
                            >
                                <Button variant="link" isInline>Collector details</Button>
                            </Popover>
                        </FlexItem>
                    )}
                    {active && (
                        <FlexItem align={{ default: 'alignRight' }}>
                            <Link to="/ovn-recon/ovn">Open cluster view</Link>
                        </FlexItem>
                    )}
                </Flex>
            </CardBody>
        </Card>
    );
};

// --- The page ---------------------------------------------------------------------

const NODE_COLUMNS = ['Node', 'Role', 'Findings', 'Interfaces', 'Bridges', 'Mappings', 'LLDP', 'Views'];

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

    const [query, setQuery] = React.useState('');

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
    const fleet = React.useMemo(() => summarizeFleet(summaries), [summaries]);
    const visible = React.useMemo(() => filterNodeSummaries(summaries, query), [summaries, query]);
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
                    Physical and logical network topology across {plural(fleet.nodes, 'node')}
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
                                <Toolbar inset={{ default: 'insetNone' }}>
                                    <ToolbarContent>
                                        <ToolbarItem>
                                            <SearchInput
                                                aria-label="Filter nodes by name"
                                                placeholder="Filter by name"
                                                value={query}
                                                onChange={(_event, value) => setQuery(value)}
                                                onClear={() => setQuery('')}
                                            />
                                        </ToolbarItem>
                                        <ToolbarItem>
                                            <span style={subtle}>
                                                {visible.length === summaries.length
                                                    ? plural(summaries.length, 'node')
                                                    : `${visible.length} of ${plural(summaries.length, 'node')}`}
                                                {' with NodeNetworkState'}
                                            </span>
                                        </ToolbarItem>
                                        {/* What the Physical card said, in the one place the nodes are. */}
                                        <ToolbarItem align={{ default: 'alignEnd' }}>
                                            <span style={subtle} data-testid="overview-fleet-summary">
                                                {plural(fleet.bridgeMappings, 'bridge mapping')} across {plural(fleet.bridges, 'bridge')}
                                                {' · '}
                                                {fleet.nodesWithLldp === 0
                                                    ? 'no node reports LLDP neighbors'
                                                    : `${plural(fleet.nodesWithLldp, 'node')} report${fleet.nodesWithLldp === 1 ? 's' : ''} LLDP neighbors`}
                                            </span>
                                        </ToolbarItem>
                                    </ToolbarContent>
                                </Toolbar>
                                <Table aria-label="Nodes" variant="compact">
                                    <Thead>
                                        <Tr>
                                            {NODE_COLUMNS.map((column) => <Th key={column} modifier="nowrap">{column}</Th>)}
                                        </Tr>
                                    </Thead>
                                    <Tbody>
                                        {nnsLoaded && gateLoaded && visible.map((node) => (
                                            <Tr key={node.name} data-testid={`overview-node-${node.name}`}>
                                                <Td dataLabel="Node">
                                                    <Link to={`/ovn-recon/node-network-state/${encodeURIComponent(node.name)}`}>{node.name}</Link>
                                                </Td>
                                                <Td dataLabel="Role">{rolesByNode.get(node.name) ?? ''}</Td>
                                                <Td dataLabel="Findings" data-testid={`overview-findings-${node.name}`}>
                                                    {findingCounts.has(node.name) && (
                                                        <Link
                                                            to={nodePagePath(node.name)}
                                                            aria-label={`${describeCounts(findingCounts.get(node.name)!)} on ${node.name}`}
                                                        >
                                                            <SeverityCountsInline counts={findingCounts.get(node.name)!} />
                                                        </Link>
                                                    )}
                                                </Td>
                                                <Td dataLabel="Interfaces">{node.interfacesUp} up / {node.interfacesTotal}</Td>
                                                <Td dataLabel="Bridges">{node.bridges.join(', ')}</Td>
                                                <Td dataLabel="Mappings">{node.bridgeMappings}</Td>
                                                <Td dataLabel="LLDP">{node.lldpNeighbors}</Td>
                                                <Td dataLabel="Views">
                                                    <Link to={`/ovn-recon/node-network-state/${encodeURIComponent(node.name)}`}>Physical</Link>
                                                    {showLogical && (
                                                        <>
                                                            {' · '}
                                                            <Link to={`/ovn-recon/ovn/${encodeURIComponent(node.name)}`}>Logical</Link>
                                                        </>
                                                    )}
                                                    {' · '}
                                                    <a href={nnsResourcePath(node.name)} target="_blank" rel="noopener noreferrer">NNS</a>
                                                </Td>
                                            </Tr>
                                        ))}
                                        {(!nnsLoaded || !gateLoaded) && !nnsError && (
                                            <Tr><Td colSpan={NODE_COLUMNS.length}>Loading...</Td></Tr>
                                        )}
                                        {nnsError && (
                                            <Tr><Td colSpan={NODE_COLUMNS.length}>Error loading NodeNetworkStates: {nnsError}</Td></Tr>
                                        )}
                                        {nnsLoaded && gateLoaded && !nnsError && visible.length === 0 && (
                                            <Tr><Td colSpan={NODE_COLUMNS.length}>{summaries.length === 0 ? 'No NodeNetworkState resources found.' : 'No nodes match.'}</Td></Tr>
                                        )}
                                    </Tbody>
                                </Table>
                            </CardBody>
                        </Card>
                    </GridItem>

                    <GridItem span={12}>
                        <CollectorStatus collector={collector} />
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

/**
 * The collector's aggregate, polled while the gate is on. A disabled collector is
 * never asked.
 */
const useCollectorState = (): CollectorState => {
    const { enabled, loaded: gateLoaded } = useOvnCollectorFeatureGate();
    const [topology, setTopology] = React.useState<ClusterLogicalTopology | null>(null);
    const [error, setError] = React.useState<string>('');
    const [loading, setLoading] = React.useState<boolean>(false);
    React.useEffect(() => {
        if (!enabled) return undefined;
        let cancelled = false;
        const load = async () => {
            setLoading(true);
            try {
                const payload = await fetchClusterTopology();
                if (!cancelled) {
                    setTopology(payload);
                    setError('');
                }
            } catch (caught) {
                if (!cancelled) {
                    setError(caught instanceof Error ? caught.message : 'Failed to reach the collector');
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        load();
        const timer = window.setInterval(load, COLLECTOR_REFRESH_MS);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
        };
    }, [enabled]);
    return React.useMemo(
        () => ({ enabled, gateLoaded, topology, error, loading }),
        [enabled, gateLoaded, topology, error, loading],
    );
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
