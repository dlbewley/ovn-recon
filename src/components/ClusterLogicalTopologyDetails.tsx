import * as React from 'react';
import { DocumentTitle } from '@openshift-console/dynamic-plugin-sdk';
import { Link } from 'react-router';
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
    Drawer,
    DrawerContent,
    DrawerPanelContent,
    DrawerHead,
    DrawerActions,
    DrawerCloseButton,
    Flex,
    FlexItem,
    TextInput,
    FormSelect,
    FormSelectOption,
    Button,
    Alert,
    AlertGroup,
} from '@patternfly/react-core';

import { ClusterLogicalTopology } from '../types';
import { useOvnCollectorFeatureGate } from './useOvnCollectorFeatureGate';
import { fetchClusterTopology } from './collectorApi';
import { mergeZones } from './logicalClusterModel';
import { aggregateId } from './logicalLadderLayout';
import ConstructDrawerBody from './ConstructDrawerBody';
import SnapshotJsonControls from './SnapshotJsonControls';
import LogicalLadderView, { networkDisplayName, roleIcon, roleLabel } from './LogicalLadderView';
import SnapshotStatusLine from './SnapshotStatusLine';
import { freshnessFromAge, oldestSnapshotAgeMs } from './snapshotFreshness';

// Aggregate collection probes every zone, so refresh less eagerly than the
// per-node view.
const REFRESH_INTERVAL_MS = 60000;

interface Point {
    x: number;
    y: number;
}

const ClusterLogicalTopologyDetails: React.FC = () => {
    const { enabled, loaded: gateLoaded, loadError: gateError } = useOvnCollectorFeatureGate();

    const [topology, setTopology] = React.useState<ClusterLogicalTopology | null>(null);
    const [isLoading, setIsLoading] = React.useState<boolean>(false);
    const [fetchError, setFetchError] = React.useState<string>('');
    const [search, setSearch] = React.useState<string>('');
    const [hostFilter, setHostFilter] = React.useState<string>('all');
    const [networkFilter, setNetworkFilter] = React.useState<string>('all');
    const [selectedUuid, setSelectedUuid] = React.useState<string | null>(null);
    const [expandedGroups, setExpandedGroups] = React.useState<ReadonlySet<string>>(new Set());
    const [zoom, setZoom] = React.useState<number>(1);
    const [pan, setPan] = React.useState<Point>({ x: 0, y: 0 });
    const [isDragging, setIsDragging] = React.useState<boolean>(false);
    const [lastPointer, setLastPointer] = React.useState<Point | null>(null);

    const loadTopology = React.useCallback(async () => {
        if (!enabled) return;
        setIsLoading(true);
        setFetchError('');
        try {
            const payload = await fetchClusterTopology();
            setTopology(payload);
        } catch (error) {
            // Keep the last-good topology rendered: a transient failure (a
            // collector pod handoff, a proxy blip) must not blank the view.
            setFetchError(error instanceof Error ? error.message : 'Failed to load cluster topology');
        } finally {
            setIsLoading(false);
        }
    }, [enabled]);

    React.useEffect(() => {
        if (!enabled) return;
        loadTopology();
        const timer = window.setInterval(() => {
            loadTopology();
        }, REFRESH_INTERVAL_MS);
        return () => {
            window.clearInterval(timer);
        };
    }, [enabled, loadTopology]);

    const hosts = React.useMemo(
        () =>
            [...new Set((topology?.snapshots ?? []).map((snapshot) => snapshot.metadata.nodeName))]
                .filter(Boolean)
                .sort(),
        [topology],
    );

    // A host selection narrows the merge to that node's zone: node-bound
    // constructs collapse to that node's single instances, and shared
    // constructs render as that zone sees them — the single-node perspective.
    const visibleSnapshots = React.useMemo(() => {
        if (!topology) return null;
        return hostFilter === 'all'
            ? topology.snapshots
            : topology.snapshots.filter((snapshot) => snapshot.metadata.nodeName === hostFilter);
    }, [topology, hostFilter]);

    const model = React.useMemo(
        () => (visibleSnapshots ? mergeZones(visibleSnapshots) : null),
        [visibleSnapshots],
    );

    const selectHost = React.useCallback((host: string) => {
        setHostFilter(host);
        // The previous selection and expansion state reference constructs
        // that may not exist in the narrowed model.
        setSelectedUuid(null);
        setExpandedGroups(new Set());
    }, []);

    // Re-render the age text periodically so it doesn't freeze between the
    // 60s refetches.
    const [ageTick, setAgeTick] = React.useState(0);
    React.useEffect(() => {
        const timer = window.setInterval(() => setAgeTick((tick) => tick + 1), 30000);
        return () => window.clearInterval(timer);
    }, []);

    // Freshness comes from the zone snapshots themselves — the aggregate
    // envelope's generatedAt is stamped at assembly time on every request,
    // so it always reads "just now" and says nothing. The view is only as
    // fresh as the stalest zone it is showing.
    const ageMs = React.useMemo(
        () =>
            visibleSnapshots
                ? oldestSnapshotAgeMs(visibleSnapshots.map((snapshot) => snapshot.metadata?.generatedAt))
                : null,
        // ageTick is a deliberate extra dependency: it forces the age to
        // recompute between refetches.
        [visibleSnapshots, ageTick],
    );
    const freshness = freshnessFromAge(ageMs);

    const selectedConstruct = React.useMemo(
        () => (model && selectedUuid ? model.constructByUuid.get(selectedUuid) ?? null : null),
        [model, selectedUuid],
    );

    // Relationships-tab navigation: selecting a construct that sits inside a
    // collapsed aggregate also expands its group, a network filter hiding the
    // target follows it, and the view is asked to reveal it (the page pans on
    // the reported position — mirroring the physical view, where only drawer
    // navigation moves the viewport).
    const [revealRequest, setRevealRequest] = React.useState<{ uuid: string; nonce: number }>();
    const canvasRef = React.useRef<HTMLDivElement | null>(null);
    const selectConstructFromDrawer = React.useCallback((uuid: string) => {
        const target = model?.constructByUuid.get(uuid);
        if (target) {
            setExpandedGroups((current) =>
                new Set(current).add(aggregateId(target.network, target.tier, target.role)));
            setNetworkFilter((current) => (current !== 'all' && current !== target.network ? target.network : current));
        }
        setSelectedUuid(uuid);
        setRevealRequest((current) => ({ uuid, nonce: (current?.nonce ?? 0) + 1 }));
    }, [model]);

    const revealPosition = React.useCallback((position: { x: number; y: number }) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const { width: cw, height: ch } = canvas.getBoundingClientRect();
        setPan({ x: cw / 2 - position.x * zoom, y: ch / 2 - position.y * zoom });
    }, [zoom]);

    // The Config tab's raw rows come from one representative zone: the zone
    // whose uuid survived the merge (zones[0]).
    const drawerDatabase = React.useMemo(() => {
        if (!selectedConstruct || !topology) return null;
        const zone = selectedConstruct.zones?.[0];
        const snapshot = topology.snapshots.find((candidate) => candidate.metadata.nodeName === zone);
        return snapshot?.database ? { node: zone, database: snapshot.database } : null;
    }, [selectedConstruct, topology]);

    const snapshotJson = React.useMemo(() => {
        if (!topology) return null;
        if (hostFilter !== 'all') {
            const snapshot = topology.snapshots.find(
                (candidate) => candidate.metadata.nodeName === hostFilter);
            return snapshot
                ? { label: `${hostFilter} cached snapshot`, filename: `${hostFilter}-snapshot.json`, payload: snapshot }
                : null;
        }
        return {
            label: 'Cluster logical topology (all nodes)',
            filename: 'cluster-logical-topology.json',
            payload: topology,
        };
    }, [topology, hostFilter]);

    const toggleAggregate = React.useCallback((aggregateIdValue: string) => {
        setExpandedGroups((current) => {
            const next = new Set(current);
            if (next.has(aggregateIdValue)) {
                next.delete(aggregateIdValue);
            } else {
                next.add(aggregateIdValue);
            }
            return next;
        });
    }, []);

    const zoomIn = () => setZoom((value) => Math.min(2.5, Number((value + 0.1).toFixed(2))));
    const zoomOut = () => setZoom((value) => Math.max(0.3, Number((value - 0.1).toFixed(2))));
    const resetView = () => {
        setZoom(1);
        setPan({ x: 0, y: 0 });
    };

    const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
        event.preventDefault();
        if (event.deltaY < 0) zoomIn(); else zoomOut();
    };

    const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
        setIsDragging(true);
        setLastPointer({ x: event.clientX, y: event.clientY });
    };

    const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
        if (!isDragging || !lastPointer) return;
        const dx = event.clientX - lastPointer.x;
        const dy = event.clientY - lastPointer.y;
        setPan((current) => ({ x: current.x + dx, y: current.y + dy }));
        setLastPointer({ x: event.clientX, y: event.clientY });
    };

    const handleMouseUp = () => {
        setIsDragging(false);
        setLastPointer(null);
    };

    if (!gateLoaded) {
        return <PageSection><Title headingLevel="h1">Loading...</Title></PageSection>;
    }

    if (gateError) {
        return (
            <PageSection>
                <Title headingLevel="h1">Error</Title>
                <p>{gateError.message}</p>
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
            <DocumentTitle>OVN Recon - Cluster Logical Topology</DocumentTitle>
            <PageSection>
                <Breadcrumb>
                    <BreadcrumbItem>
                        <Link to="/ovn-recon/node-network-state">OVN Recon</Link>
                    </BreadcrumbItem>
                    <BreadcrumbItem isActive>Cluster logical topology</BreadcrumbItem>
                </Breadcrumb>
                <Title headingLevel="h1" className="pf-u-mt-lg">Cluster Logical OVN Topology</Title>
            </PageSection>
            <PageSection isFilled>
                <Drawer isExpanded={selectedConstruct != null}>
                    <DrawerContent
                        panelContent={(
                            <DrawerPanelContent minSize="320px">
                                {selectedConstruct && model && (
                                    <>
                                        <DrawerHead>
                                            <Title headingLevel="h2">
                                                {roleIcon(selectedConstruct.role)}{' '}
                                                {roleLabel(selectedConstruct.role)}
                                                {selectedConstruct.node ? ` · ${selectedConstruct.node}` : ''}
                                            </Title>
                                            <DrawerActions>
                                                <DrawerCloseButton onClick={() => setSelectedUuid(null)} />
                                            </DrawerActions>
                                        </DrawerHead>
                                        <Card>
                                            <CardBody>
                                                <ConstructDrawerBody
                                                    construct={selectedConstruct}
                                                    model={model}
                                                    totalNodes={model.zoneCount}
                                                    nodeHref={(node) => `/ovn-recon/ovn/${encodeURIComponent(node)}`}
                                                    physicalHref={(node) => `/ovn-recon/node-network-state/${encodeURIComponent(node)}`}
                                                    onSelectConstruct={selectConstructFromDrawer}
                                                    database={drawerDatabase?.database}
                                                    databaseNode={drawerDatabase?.node}
                                                />
                                            </CardBody>
                                        </Card>
                                    </>
                                )}
                            </DrawerPanelContent>
                        )}
                    >
                        <Card>
                            <CardTitle>Cluster Topology</CardTitle>
                            <CardBody>
                                <AlertGroup isToast={false}>
                                    {fetchError && (
                                        <Alert variant="warning" isInline title={fetchError}>
                                            {topology
                                                ? 'Showing the last loaded topology; refresh retries automatically.'
                                                : 'The aggregate endpoint requires an ovn-collector image with snapshot contract v2.'}
                                        </Alert>
                                    )}
                                    {topology && topology.warnings.length > 0 && (
                                        <Alert
                                            variant="warning"
                                            isInline
                                            isExpandable
                                            title={`${topology.warnings.length} collector warning${topology.warnings.length === 1 ? '' : 's'}`}
                                        >
                                            {topology.warnings.map((warning) => (
                                                <div key={`${warning.code}:${warning.message}`}>
                                                    {warning.code}: {warning.message}
                                                </div>
                                            ))}
                                        </Alert>
                                    )}
                                </AlertGroup>

                                <Flex className="pf-u-mt-md" spaceItems={{ default: 'spaceItemsMd' }} alignItems={{ default: 'alignItemsCenter' }}>
                                    <FlexItem>
                                        <TextInput
                                            aria-label="Search constructs"
                                            type="search"
                                            placeholder="Search by name, role, node, or subnet"
                                            value={search}
                                            onChange={(_event, value) => setSearch(value)}
                                        />
                                    </FlexItem>
                                    <FlexItem>
                                        <FormSelect
                                            aria-label="Filter by host"
                                            value={hostFilter}
                                            onChange={(_event, value) => selectHost(value)}
                                        >
                                            <FormSelectOption value="all" label="All hosts" />
                                            {hosts.map((host) => (
                                                <FormSelectOption key={host} value={host} label={host} />
                                            ))}
                                        </FormSelect>
                                    </FlexItem>
                                    <FlexItem>
                                        <FormSelect
                                            aria-label="Filter by network"
                                            value={networkFilter}
                                            onChange={(_event, value) => setNetworkFilter(value)}
                                        >
                                            <FormSelectOption value="all" label="All networks" />
                                            {model?.networks.map((network) => (
                                                <FormSelectOption
                                                    key={network}
                                                    value={network}
                                                    label={networkDisplayName(network)}
                                                />
                                            ))}
                                        </FormSelect>
                                    </FlexItem>
                                    <FlexItem><Button variant="secondary" onClick={zoomOut}>-</Button></FlexItem>
                                    <FlexItem><Button variant="secondary" onClick={zoomIn}>+</Button></FlexItem>
                                    <FlexItem><Button variant="link" onClick={resetView}>Reset view</Button></FlexItem>
                                    <FlexItem>
                                        <Button variant="tertiary" onClick={() => loadTopology()} isDisabled={isLoading}>
                                            Refresh now
                                        </Button>
                                    </FlexItem>
                                    {snapshotJson && (
                                        <FlexItem>
                                            <SnapshotJsonControls
                                                label={snapshotJson.label}
                                                filename={snapshotJson.filename}
                                                payload={snapshotJson.payload}
                                            />
                                        </FlexItem>
                                    )}
                                    {topology && model && (
                                        <FlexItem align={{ default: 'alignRight' }}>
                                            <SnapshotStatusLine
                                                freshness={freshness}
                                                ageMs={ageMs}
                                                ageQualifier={(visibleSnapshots?.length ?? 0) > 1 ? 'oldest node ' : undefined}
                                                zoneCount={model.zoneCount}
                                                sourceHealth={topology.metadata.sourceHealth}
                                                isLoading={isLoading}
                                            />
                                        </FlexItem>
                                    )}
                                </Flex>

                                <div
                                    ref={canvasRef}
                                    className="pf-u-mt-md"
                                    style={{ height: 'max(560px, calc(100vh - 340px))', border: '1px solid var(--pf-t--global--border--color--default)', overflow: 'hidden', cursor: isDragging ? 'grabbing' : 'grab' }}
                                    onWheel={handleWheel}
                                    onMouseDown={handleMouseDown}
                                    onMouseMove={handleMouseMove}
                                    onMouseUp={handleMouseUp}
                                    onMouseLeave={handleMouseUp}
                                >
                                    {model && (
                                        <div style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0' }}>
                                            <LogicalLadderView
                                                model={model}
                                                selectedUuid={selectedUuid}
                                                onSelect={setSelectedUuid}
                                                networkFilter={networkFilter}
                                                search={search}
                                                expandedGroupIds={expandedGroups}
                                                onAggregateToggle={toggleAggregate}
                                                onNetworkSelect={setNetworkFilter}
                                                revealRequest={revealRequest}
                                                onRevealPosition={revealPosition}
                                            />
                                        </div>
                                    )}
                                </div>
                            </CardBody>
                        </Card>
                    </DrawerContent>
                </Drawer>
            </PageSection>
        </>
    );
};

export default ClusterLogicalTopologyDetails;
