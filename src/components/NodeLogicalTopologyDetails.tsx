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

interface Point {
    x: number;
    y: number;
}

const kindOrder = ['logical_router', 'logical_switch', 'logical_switch_port'];

const getNodeColor = (kind: string): string => {
    if (kind === 'logical_router') return '#0066CC';
    if (kind === 'logical_switch') return '#2B9A66';
    if (kind === 'logical_switch_port') return '#8A5A00';
    return '#6A6E73';
};

const layoutNodes = (nodes: LogicalTopologyNode[]): Record<string, Point> => {
    const kinds = Array.from(new Set(nodes.map((node) => node.kind))).sort((a, b) => {
        const aIndex = kindOrder.indexOf(a);
        const bIndex = kindOrder.indexOf(b);
        if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
        if (aIndex === -1) return 1;
        if (bIndex === -1) return -1;
        return aIndex - bIndex;
    });

    const byKind = kinds.reduce((acc, kind) => {
        acc[kind] = nodes.filter((node) => node.kind === kind).sort((a, b) => a.label.localeCompare(b.label));
        return acc;
    }, {} as Record<string, LogicalTopologyNode[]>);

    const positions: Record<string, Point> = {};
    kinds.forEach((kind, kindIndex) => {
        byKind[kind].forEach((node, nodeIndex) => {
            positions[node.id] = {
                x: 160 + kindIndex * 260,
                y: 120 + nodeIndex * 110,
            };
        });
    });

    return positions;
};

const NodeLogicalTopologyDetails: React.FC = () => {
    const { name = '' } = useParams<{ name: string }>();
    const { enabled, loaded: gateLoaded, loadError: gateError } = useOvnCollectorFeatureGate();

    const [snapshot, setSnapshot] = React.useState<LogicalTopologySnapshot | null>(null);
    const [snapshotError, setSnapshotError] = React.useState<string>('');
    const [sourceLabel, setSourceLabel] = React.useState<'collector' | 'fixture' | ''>('');
    const [search, setSearch] = React.useState<string>('');
    const [kindFilter, setKindFilter] = React.useState<string>('all');
    const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null);
    const [zoom, setZoom] = React.useState<number>(1);
    const [pan, setPan] = React.useState<Point>({ x: 0, y: 0 });
    const [isDragging, setIsDragging] = React.useState<boolean>(false);
    const [lastPointer, setLastPointer] = React.useState<Point | null>(null);

    React.useEffect(() => {
        if (!enabled || !name) return;

        let cancelled = false;
        const loadSnapshot = async () => {
            setSnapshotError('');
            try {
                const response = await fetch(`/api/v1/snapshots/${name}`);
                if (!response.ok) throw new Error(`Collector returned ${response.status}`);
                const payload = await response.json() as LogicalTopologySnapshot;
                if (!cancelled) {
                    setSnapshot(payload);
                    setSourceLabel('collector');
                }
            } catch (error) {
                const fixture = getLogicalTopologyFixture(name);
                if (!cancelled && fixture) {
                    setSnapshot(fixture);
                    setSourceLabel('fixture');
                    setSnapshotError(`Collector unavailable for ${name}; using fixture data.`);
                } else if (!cancelled) {
                    setSnapshot(null);
                    setSnapshotError(error instanceof Error ? error.message : 'Failed to load logical topology');
                }
            }
        };

        loadSnapshot();
        return () => { cancelled = true; };
    }, [enabled, name]);

    const filteredNodes = React.useMemo(() => {
        if (!snapshot) return [];
        const query = search.trim().toLowerCase();
        return snapshot.nodes.filter((node) => {
            const matchesKind = kindFilter === 'all' || node.kind === kindFilter;
            const matchesSearch = query === ''
                || node.label.toLowerCase().includes(query)
                || node.id.toLowerCase().includes(query)
                || node.kind.toLowerCase().includes(query);
            return matchesKind && matchesSearch;
        });
    }, [snapshot, search, kindFilter]);

    const visibleNodeIds = React.useMemo(() => new Set(filteredNodes.map((node) => node.id)), [filteredNodes]);

    const filteredEdges = React.useMemo(() => {
        if (!snapshot) return [];
        return snapshot.edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target));
    }, [snapshot, visibleNodeIds]);

    const positions = React.useMemo(() => layoutNodes(filteredNodes), [filteredNodes]);

    const selectedNode = React.useMemo(
        () => filteredNodes.find((node) => node.id === selectedNodeId) || null,
        [filteredNodes, selectedNodeId],
    );

    const kinds = React.useMemo(() => {
        if (!snapshot) return [];
        return Array.from(new Set(snapshot.nodes.map((node) => node.kind))).sort();
    }, [snapshot]);

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
                                    {snapshotError && (
                                        <Alert variant="warning" isInline title={snapshotError} />
                                    )}
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
