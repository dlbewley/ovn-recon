import * as React from 'react';
import { Link } from 'react-router';
import {
    Alert,
    Button,
    Card,
    CardBody,
    CardFooter,
    CardTitle,
    DescriptionList,
    DescriptionListDescription,
    DescriptionListGroup,
    DescriptionListTerm,
    Gallery,
    GalleryItem,
    PageSection,
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
    NodeNetworkState,
    RouteAdvertisements,
    UserDefinedNetwork,
} from '../types';
import { fetchClusterTopology } from './collectorApi';
import { freshnessFromAge, oldestSnapshotAgeMs } from './snapshotFreshness';
import SnapshotStatusLine from './SnapshotStatusLine';
import { useOvnCollectorFeatureGate } from './useOvnCollectorFeatureGate';
import {
    filterNodeSummaries,
    formatCudnBreakdown,
    nodeRole,
    summarizeFleet,
    summarizeNetworks,
    summarizeNode,
} from './overviewModel';

/**
 * The single front door for OVN Recon (ovn-recon-brx). One Networking entry
 * lands here. The page answers three things before anyone clicks -- what the
 * collector knows, what networks exist, and how the fleet is wired -- and the
 * node table carries enough per-node fact to pick a node for a reason. The
 * cluster logical view keeps its own route behind the first card.
 */

// Same cadence as the cluster view: the aggregate probes every zone, so it
// is not something to hammer from a page people leave open.
const COLLECTOR_REFRESH_MS = 60000;

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

const CONSOLE_LIST = {
    cudn: '/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork',
    udn: '/k8s/all-namespaces/k8s.ovn.org~v1~UserDefinedNetwork',
    nad: '/k8s/all-namespaces/k8s.cni.cncf.io~v1~NetworkAttachmentDefinition',
    ra: '/k8s/cluster/k8s.ovn.org~v1~RouteAdvertisements',
};

const nnsResourcePath = (name: string): string =>
    `/k8s/cluster/nmstate.io~v1beta1~NodeNetworkState/${encodeURIComponent(name)}`;

const OvnReconOverview: React.FC = () => {
    const { enabled: collectorEnabled, loaded: gateLoaded } = useOvnCollectorFeatureGate();

    const [nodeNetworkStates, nnsLoaded, nnsError] = useK8sWatchResource<NodeNetworkState[]>({
        groupVersionKind: { group: 'nmstate.io', version: 'v1beta1', kind: 'NodeNetworkState' },
        isList: true,
    });
    const [nodes] = useK8sWatchResource<K8sResourceCommon[]>({
        groupVersionKind: { version: 'v1', kind: 'Node' },
        isList: true,
    });
    const [cudns] = useK8sWatchResource<ClusterUserDefinedNetwork[]>({
        groupVersionKind: { group: 'k8s.ovn.org', version: 'v1', kind: 'ClusterUserDefinedNetwork' },
        isList: true,
    });
    const [udns] = useK8sWatchResource<UserDefinedNetwork[]>({
        groupVersionKind: { group: 'k8s.ovn.org', version: 'v1', kind: 'UserDefinedNetwork' },
        isList: true,
    });
    const [nads] = useK8sWatchResource<NetworkAttachmentDefinition[]>({
        groupVersionKind: { group: 'k8s.cni.cncf.io', version: 'v1', kind: 'NetworkAttachmentDefinition' },
        isList: true,
    });
    const [routeAdvertisements] = useK8sWatchResource<RouteAdvertisements[]>({
        groupVersionKind: { group: 'k8s.ovn.org', version: 'v1', kind: 'RouteAdvertisements' },
        isList: true,
    });

    // Collector envelope for the first card. Only asked for when the gate is
    // on; a disabled collector has no card at all rather than a broken one.
    const [topology, setTopology] = React.useState<ClusterLogicalTopology | null>(null);
    const [collectorError, setCollectorError] = React.useState<string>('');
    const [collectorLoading, setCollectorLoading] = React.useState<boolean>(false);
    React.useEffect(() => {
        if (!collectorEnabled) return undefined;
        let cancelled = false;
        const load = async () => {
            setCollectorLoading(true);
            try {
                const payload = await fetchClusterTopology();
                if (!cancelled) {
                    setTopology(payload);
                    setCollectorError('');
                }
            } catch (error) {
                if (!cancelled) {
                    setCollectorError(error instanceof Error ? error.message : 'Failed to reach the collector');
                }
            } finally {
                if (!cancelled) setCollectorLoading(false);
            }
        };
        load();
        const timer = window.setInterval(load, COLLECTOR_REFRESH_MS);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
        };
    }, [collectorEnabled]);

    // Keep the age text moving between refetches.
    const [ageTick, setAgeTick] = React.useState(0);
    React.useEffect(() => {
        const timer = window.setInterval(() => setAgeTick((tick) => tick + 1), 30000);
        return () => window.clearInterval(timer);
    }, []);
    const collectorAgeMs = React.useMemo(
        () => (topology ? oldestSnapshotAgeMs(topology.snapshots.map((s) => s.metadata?.generatedAt)) : null),
        // ageTick is a deliberate extra dependency: it forces the age to recompute.
        [topology, ageTick],
    );

    const [query, setQuery] = React.useState('');

    const summaries = React.useMemo(
        () => (nodeNetworkStates ?? []).map(summarizeNode).sort((a, b) => a.name.localeCompare(b.name)),
        [nodeNetworkStates],
    );
    const rolesByNode = React.useMemo(() => {
        const roles = new Map<string, string>();
        for (const node of nodes ?? []) {
            if (node.metadata?.name) roles.set(node.metadata.name, nodeRole(node));
        }
        return roles;
    }, [nodes]);
    const networks = React.useMemo(
        () => summarizeNetworks(cudns ?? [], udns ?? [], nads ?? [], routeAdvertisements ?? []),
        [cudns, udns, nads, routeAdvertisements],
    );
    const fleet = React.useMemo(() => summarizeFleet(summaries), [summaries]);
    const visible = React.useMemo(() => filterNodeSummaries(summaries, query), [summaries, query]);

    const columns = ['Node', 'Role', 'Interfaces', 'Bridges', 'Mappings', 'LLDP', 'Views'];
    const showLogical = gateLoaded && collectorEnabled;
    const cudnBreakdown = formatCudnBreakdown(networks.cudnsByTopology);

    return (
        <>
            <DocumentTitle>OVN Recon</DocumentTitle>
            <PageSection>
                <Title headingLevel="h1">OVN Recon</Title>
                <p style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
                    Physical and logical network topology across {plural(fleet.nodes, 'node')}
                </p>
            </PageSection>

            <PageSection>
                <Gallery hasGutter minWidths={{ default: '280px' }}>
                    {showLogical && (
                        <GalleryItem>
                            <Card isFullHeight data-testid="overview-collector-card">
                                <CardTitle>Cluster logical topology</CardTitle>
                                <CardBody>
                                    {collectorError && !topology ? (
                                        <Alert variant="warning" isInline isPlain title="Collector unreachable">
                                            {collectorError}
                                        </Alert>
                                    ) : (
                                        <SnapshotStatusLine
                                            freshness={freshnessFromAge(collectorAgeMs)}
                                            ageMs={collectorAgeMs}
                                            ageQualifier="oldest node "
                                            zoneCount={topology?.snapshots.length}
                                            sourceHealth={topology?.metadata.sourceHealth}
                                            isLoading={collectorLoading && !topology}
                                        />
                                    )}
                                    {topology && topology.warnings.length > 0 && (
                                        <p style={{ marginTop: 8 }}>
                                            {plural(topology.warnings.length, 'collector warning')}
                                        </p>
                                    )}
                                </CardBody>
                                <CardFooter>
                                    <Button variant="primary" component={(props) => <Link {...props} to="/ovn-recon/ovn" />}>
                                        Open cluster view
                                    </Button>
                                </CardFooter>
                            </Card>
                        </GalleryItem>
                    )}
                    <GalleryItem>
                        <Card isFullHeight data-testid="overview-networks-card">
                            <CardTitle>Networks</CardTitle>
                            <CardBody>
                                <DescriptionList isCompact isHorizontal>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>CUDNs</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            <a href={CONSOLE_LIST.cudn}>{networks.cudns}</a>
                                            {cudnBreakdown && <span> ({cudnBreakdown})</span>}
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>UDNs</DescriptionListTerm>
                                        <DescriptionListDescription><a href={CONSOLE_LIST.udn}>{networks.udns}</a></DescriptionListDescription>
                                    </DescriptionListGroup>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>NADs</DescriptionListTerm>
                                        <DescriptionListDescription><a href={CONSOLE_LIST.nad}>{networks.nads}</a></DescriptionListDescription>
                                    </DescriptionListGroup>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>Route advertisements</DescriptionListTerm>
                                        <DescriptionListDescription><a href={CONSOLE_LIST.ra}>{networks.routeAdvertisements}</a></DescriptionListDescription>
                                    </DescriptionListGroup>
                                </DescriptionList>
                            </CardBody>
                        </Card>
                    </GalleryItem>
                    <GalleryItem>
                        <Card isFullHeight data-testid="overview-physical-card">
                            <CardTitle>Physical</CardTitle>
                            <CardBody>
                                <DescriptionList isCompact isHorizontal>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>Nodes</DescriptionListTerm>
                                        <DescriptionListDescription>{fleet.nodes} with NodeNetworkState</DescriptionListDescription>
                                    </DescriptionListGroup>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>Bridge mappings</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            {fleet.bridgeMappings} across {plural(fleet.bridges, 'bridge')}
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>LLDP</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            {fleet.nodesWithLldp === 0
                                                ? 'no node reports neighbors'
                                                : `${plural(fleet.nodesWithLldp, 'node')} report${fleet.nodesWithLldp === 1 ? 's' : ''} neighbors`}
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                </DescriptionList>
                            </CardBody>
                        </Card>
                    </GalleryItem>
                </Gallery>
            </PageSection>

            <PageSection isFilled>
                <Card>
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
                                    <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
                                        {visible.length === summaries.length
                                            ? plural(summaries.length, 'node')
                                            : `${visible.length} of ${plural(summaries.length, 'node')}`}
                                    </span>
                                </ToolbarItem>
                            </ToolbarContent>
                        </Toolbar>
                        <Table aria-label="Nodes" variant="compact">
                            <Thead>
                                <Tr>
                                    {columns.map((column) => <Th key={column}>{column}</Th>)}
                                </Tr>
                            </Thead>
                            <Tbody>
                                {nnsLoaded && gateLoaded && visible.map((node) => (
                                    <Tr key={node.name} data-testid={`overview-node-${node.name}`}>
                                        <Td dataLabel="Node">
                                            <Link to={`/ovn-recon/node-network-state/${encodeURIComponent(node.name)}`}>{node.name}</Link>
                                        </Td>
                                        <Td dataLabel="Role">{rolesByNode.get(node.name) ?? ''}</Td>
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
                                    <Tr><Td colSpan={columns.length}>Loading...</Td></Tr>
                                )}
                                {nnsError && (
                                    <Tr><Td colSpan={columns.length}>Error loading NodeNetworkStates: {nnsError.message}</Td></Tr>
                                )}
                                {nnsLoaded && gateLoaded && !nnsError && visible.length === 0 && (
                                    <Tr><Td colSpan={columns.length}>{summaries.length === 0 ? 'No NodeNetworkState resources found.' : 'No nodes match.'}</Td></Tr>
                                )}
                            </Tbody>
                        </Table>
                    </CardBody>
                </Card>
            </PageSection>
        </>
    );
};

export default OvnReconOverview;
