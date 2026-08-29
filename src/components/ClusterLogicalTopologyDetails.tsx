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
import ConstructDrawerBody from './ConstructDrawerBody';
import LogicalLadderView, { networkDisplayName, roleIcon, roleLabel } from './LogicalLadderView';
import SnapshotStatusLine from './SnapshotStatusLine';
import { freshnessFromAge, parseSnapshotAgeMs } from './snapshotFreshness';

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
            setTopology(null);
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
    const model = React.useMemo(() => {
        if (!topology) return null;
        const snapshots = hostFilter === 'all'
            ? topology.snapshots
            : topology.snapshots.filter((snapshot) => snapshot.metadata.nodeName === hostFilter);
        return mergeZones(snapshots);
    }, [topology, hostFilter]);

    const selectHost = React.useCallback((host: string) => {
        setHostFilter(host);
        // The previous selection and expansion state reference constructs
        // that may not exist in the narrowed model.
        setSelectedUuid(null);
        setExpandedGroups(new Set());
    }, []);

    const ageMs = React.useMemo(
        () => (topology ? parseSnapshotAgeMs(topology.metadata.generatedAt) : null),
        [topology],
    );
    const freshness = freshnessFromAge(ageMs);

    const selectedConstruct = React.useMemo(
        () => (model && selectedUuid ? model.constructByUuid.get(selectedUuid) ?? null : null),
        [model, selectedUuid],
    );

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
                                                    nodeHref={(node) => `/ovn-recon/ovn/${encodeURIComponent(node)}`}
                                                    physicalHref={(node) => `/ovn-recon/node-network-state/${encodeURIComponent(node)}`}
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
                                            The aggregate endpoint requires an ovn-collector image with
                                            snapshot contract v2.
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
                                    {topology && model && (
                                        <FlexItem>
                                            <SnapshotStatusLine
                                                freshness={freshness}
                                                ageMs={ageMs}
                                                zoneCount={model.zoneCount}
                                                sourceHealth={topology.metadata.sourceHealth}
                                                isLoading={isLoading}
                                            />
                                        </FlexItem>
                                    )}
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
                                </Flex>

                                <div
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
