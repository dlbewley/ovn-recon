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
    Drawer,
    DrawerContent,
    DrawerPanelContent,
    DrawerHead,
    DrawerActions,
    DrawerCloseButton,
    DescriptionList,
    DescriptionListGroup,
    DescriptionListTerm,
    DescriptionListDescription,
    Flex,
    FlexItem,
    TextInput,
    FormSelect,
    FormSelectOption,
    Button,
    Alert,
    AlertGroup,
} from '@patternfly/react-core';

import { LogicalTopologyEdge, LogicalTopologyNode, LogicalTopologySnapshot } from '../types';
import { useOvnCollectorFeatureGate } from './useOvnCollectorFeatureGate';
import { getLogicalTopologyFixture } from './logicalTopologyFixtures';
import {
    filterLogicalEdges,
    filterLogicalNodes,
    freshnessFromAge,
    layoutLogicalNodes,
    logicalNodeKinds,
    parseSnapshotAgeMs,
    Point,
    SnapshotFreshnessState,
} from './logicalTopologyModel';

const REFRESH_INTERVAL_MS = 30000;

const getNodeColor = (kind: string): string => {
    if (kind === 'logical_router') return '#0066CC';
    if (kind === 'logical_switch') return '#2B9A66';
    if (kind === 'logical_switch_port') return '#8A5A00';
    return '#6A6E73';
};

const formatUtcTimestamp = (value: string): string => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'unknown';
    return date.toLocaleString();
};

const formatAge = (ageMs: number): string => {
    if (ageMs < 1000) return 'just now';
    const minutes = Math.floor(ageMs / 60000);
    const seconds = Math.floor((ageMs % 60000) / 1000);
    if (minutes <= 0) return `${seconds}s ago`;
    return `${minutes}m ${seconds}s ago`;
};

const freshnessVariant = (state: SnapshotFreshnessState): 'success' | 'warning' | 'danger' => {
    if (state === 'critical') return 'danger';
    if (state === 'warning') return 'warning';
    return 'success';
};

const freshnessTitle = (state: SnapshotFreshnessState): string => {
    if (state === 'critical') return 'Snapshot is stale';
    if (state === 'warning') return 'Snapshot age exceeds warning threshold';
    if (state === 'unknown') return 'Snapshot freshness unknown';
    return 'Snapshot is fresh';
};

const NodeLogicalTopologyDetails: React.FC = () => {
    const { name = '' } = useParams<{ name: string }>();
    const { enabled, loaded: gateLoaded, loadError: gateError } = useOvnCollectorFeatureGate();

    const [snapshot, setSnapshot] = React.useState<LogicalTopologySnapshot | null>(null);
    const [isLoading, setIsLoading] = React.useState<boolean>(false);
    const [snapshotError, setSnapshotError] = React.useState<string>('');
    const [sourceLabel, setSourceLabel] = React.useState<'collector' | 'fixture' | ''>('');
    const [lastLoadedAt, setLastLoadedAt] = React.useState<number>(Date.now());
    const [search, setSearch] = React.useState<string>('');
    const [kindFilter, setKindFilter] = React.useState<string>('all');
    const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null);
    const [zoom, setZoom] = React.useState<number>(1);
    const [pan, setPan] = React.useState<Point>({ x: 0, y: 0 });
    const [isDragging, setIsDragging] = React.useState<boolean>(false);
    const [lastPointer, setLastPointer] = React.useState<Point | null>(null);

    const loadSnapshot = React.useCallback(async (allowFixtureFallback: boolean) => {
        if (!enabled || !name) return;

        setIsLoading(true);
        setSnapshotError('');

        try {
            const response = await fetch(`/api/v1/snapshots/${name}`);
            if (!response.ok) throw new Error(`Collector returned ${response.status}`);
            const payload = await response.json() as LogicalTopologySnapshot;
            setSnapshot(payload);
            setSourceLabel('collector');
            setLastLoadedAt(Date.now());
        } catch (error) {
            if (!allowFixtureFallback) {
                setSnapshotError(error instanceof Error ? error.message : 'Failed to load logical topology');
                setSourceLabel('');
                setSnapshot(null);
                setIsLoading(false);
                return;
            }

            const fixture = getLogicalTopologyFixture(name);
            if (fixture) {
                setSnapshot(fixture);
                setSourceLabel('fixture');
                setSnapshotError(`Collector unavailable for ${name}; showing fixture data.`);
                setLastLoadedAt(Date.now());
            } else {
                setSnapshot(null);
                setSourceLabel('');
                setSnapshotError(error instanceof Error ? error.message : 'Failed to load logical topology');
            }
        } finally {
            setIsLoading(false);
        }
    }, [enabled, name]);

    React.useEffect(() => {
        if (!enabled || !name) return;

        loadSnapshot(true);
        const timer = window.setInterval(() => {
            loadSnapshot(true);
        }, REFRESH_INTERVAL_MS);

        return () => {
            window.clearInterval(timer);
        };
    }, [enabled, name, loadSnapshot]);

    const snapshotAgeMs = React.useMemo(() => {
        if (!snapshot?.metadata?.generatedAt) return null;
        return parseSnapshotAgeMs(snapshot.metadata.generatedAt);
    }, [snapshot, lastLoadedAt]);

    const freshnessState = React.useMemo(
        () => freshnessFromAge(snapshotAgeMs),
        [snapshotAgeMs],
    );

    const filteredNodes = React.useMemo(
        () => filterLogicalNodes(snapshot, search, kindFilter),
        [snapshot, search, kindFilter],
    );

    const visibleNodeIds = React.useMemo(() => new Set(filteredNodes.map((node) => node.id)), [filteredNodes]);

    const filteredEdges = React.useMemo(
        () => filterLogicalEdges(snapshot, visibleNodeIds),
        [snapshot, visibleNodeIds],
    );

    const positions = React.useMemo(() => layoutLogicalNodes(filteredNodes), [filteredNodes]);

    const selectedNode = React.useMemo(
        () => filteredNodes.find((node) => node.id === selectedNodeId) || null,
        [filteredNodes, selectedNodeId],
    );

    const kinds = React.useMemo(() => logicalNodeKinds(snapshot), [snapshot]);

    const zoomIn = () => setZoom((value) => Math.min(2.5, Number((value + 0.1).toFixed(2))));
    const zoomOut = () => setZoom((value) => Math.max(0.4, Number((value - 0.1).toFixed(2))));
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
                <Drawer isExpanded={selectedNode != null}>
                    <DrawerContent
                        panelContent={(
                            <DrawerPanelContent minSize="300px">
                                {selectedNode && (
                                    <>
                                        <DrawerHead>
                                            <Title headingLevel="h2">{selectedNode.label}</Title>
                                            <DrawerActions>
                                                <DrawerCloseButton onClick={() => setSelectedNodeId(null)} />
                                            </DrawerActions>
                                        </DrawerHead>
                                        <Card>
                                            <CardBody>
                                                <DescriptionList isCompact>
                                                    <DescriptionListGroup>
                                                        <DescriptionListTerm>ID</DescriptionListTerm>
                                                        <DescriptionListDescription>{selectedNode.id}</DescriptionListDescription>
                                                    </DescriptionListGroup>
                                                    <DescriptionListGroup>
                                                        <DescriptionListTerm>Kind</DescriptionListTerm>
                                                        <DescriptionListDescription>{selectedNode.kind}</DescriptionListDescription>
                                                    </DescriptionListGroup>
                                                    {selectedNode.data && (
                                                        <DescriptionListGroup>
                                                            <DescriptionListTerm>Data</DescriptionListTerm>
                                                            <DescriptionListDescription>
                                                                <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(selectedNode.data, null, 2)}</pre>
                                                            </DescriptionListDescription>
                                                        </DescriptionListGroup>
                                                    )}
                                                </DescriptionList>
                                            </CardBody>
                                        </Card>
                                    </>
                                )}
                            </DrawerPanelContent>
                        )}
                    >
                        <Card>
                            <CardTitle>Logical Topology Graph</CardTitle>
                            <CardBody>
                                <AlertGroup isToast={false}>
                                    {isLoading && (
                                        <Alert variant="info" isInline title="Refreshing logical topology snapshot..." />
                                    )}
                                    {snapshotError && (
                                        <Alert variant="warning" isInline title={snapshotError} />
                                    )}
                                    {snapshot && (
                                        <Alert
                                            variant={freshnessVariant(freshnessState)}
                                            isInline
                                            title={freshnessTitle(freshnessState)}
                                        >
                                            <div>Generated: {formatUtcTimestamp(snapshot.metadata.generatedAt)}</div>
                                            {snapshotAgeMs != null && <div>Age: {formatAge(snapshotAgeMs)}</div>}
                                        </Alert>
                                    )}
                                    {snapshot?.metadata?.sourceHealth && snapshot.metadata.sourceHealth !== 'healthy' && (
                                        <Alert
                                            variant="warning"
                                            isInline
                                            title={`Collector source health: ${snapshot.metadata.sourceHealth}`}
                                        />
                                    )}
                                    {snapshot?.warnings?.map((warning) => (
                                        <Alert
                                            key={warning.code}
                                            variant="warning"
                                            isInline
                                            title={`${warning.code}: ${warning.message}`}
                                        />
                                    ))}
                                    {sourceLabel && (
                                        <Alert
                                            variant={sourceLabel === 'collector' ? 'success' : 'info'}
                                            isInline
                                            title={`Data source: ${sourceLabel}`}
                                        />
                                    )}
                                </AlertGroup>

                                <Flex className="pf-u-mt-md" spaceItems={{ default: 'spaceItemsMd' }}>
                                    <FlexItem>
                                        <TextInput
                                            aria-label="Search nodes"
                                            type="search"
                                            placeholder="Search by label, id, or kind"
                                            value={search}
                                            onChange={(_event, value) => setSearch(value)}
                                        />
                                    </FlexItem>
                                    <FlexItem>
                                        <FormSelect
                                            aria-label="Filter by kind"
                                            value={kindFilter}
                                            onChange={(_event, value) => setKindFilter(value)}
                                        >
                                            <FormSelectOption value="all" label="All kinds" />
                                            {kinds.map((kind) => (
                                                <FormSelectOption key={kind} value={kind} label={kind} />
                                            ))}
                                        </FormSelect>
                                    </FlexItem>
                                    <FlexItem><Button variant="secondary" onClick={zoomOut}>-</Button></FlexItem>
                                    <FlexItem><Button variant="secondary" onClick={zoomIn}>+</Button></FlexItem>
                                    <FlexItem><Button variant="link" onClick={resetView}>Reset view</Button></FlexItem>
                                    <FlexItem>
                                        <Button variant="tertiary" onClick={() => loadSnapshot(false)} isDisabled={isLoading}>
                                            Refresh now
                                        </Button>
                                    </FlexItem>
                                </Flex>

                                <div
                                    className="pf-u-mt-md"
                                    style={{ height: '640px', border: '1px solid var(--pf-t--global--border--color--default)', overflow: 'hidden', cursor: isDragging ? 'grabbing' : 'grab' }}
                                    onWheel={handleWheel}
                                    onMouseDown={handleMouseDown}
                                    onMouseMove={handleMouseMove}
                                    onMouseUp={handleMouseUp}
                                    onMouseLeave={handleMouseUp}
                                >
                                    <svg width="100%" height="100%">
                                        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
                                            {filteredEdges.map((edge: LogicalTopologyEdge) => {
                                                const source = positions[edge.source];
                                                const target = positions[edge.target];
                                                if (!source || !target) return null;
                                                return (
                                                    <line
                                                        key={edge.id}
                                                        x1={source.x}
                                                        y1={source.y}
                                                        x2={target.x}
                                                        y2={target.y}
                                                        stroke="var(--pf-t--global--border--color--default)"
                                                        strokeWidth={2}
                                                    />
                                                );
                                            })}
                                            {filteredNodes.map((node: LogicalTopologyNode) => {
                                                const point = positions[node.id];
                                                if (!point) return null;
                                                const isSelected = selectedNodeId === node.id;
                                                return (
                                                    <g
                                                        key={node.id}
                                                        transform={`translate(${point.x}, ${point.y})`}
                                                        onClick={() => setSelectedNodeId(node.id)}
                                                        style={{ cursor: 'pointer' }}
                                                    >
                                                        <circle
                                                            r={26}
                                                            fill={getNodeColor(node.kind)}
                                                            stroke={isSelected ? '#151515' : '#fff'}
                                                            strokeWidth={isSelected ? 3 : 2}
                                                        />
                                                        <text
                                                            y={45}
                                                            textAnchor="middle"
                                                            fill="var(--pf-t--global--text--color--regular)"
                                                            fontSize="12"
                                                        >
                                                            {node.label}
                                                        </text>
                                                    </g>
                                                );
                                            })}
                                        </g>
                                    </svg>
                                </div>
                            </CardBody>
                        </Card>
                    </DrawerContent>
                </Drawer>
            </PageSection>
        </>
    );
};

export default NodeLogicalTopologyDetails;
