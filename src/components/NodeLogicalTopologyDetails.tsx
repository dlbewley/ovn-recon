import * as React from 'react';
import { DocumentTitle, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import { useParams, Link } from 'react-router';
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
    DrawerPanelBody,
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

import { LogicalTopologySnapshot, NodeNetworkState } from '../types';
import { useOvnCollectorFeatureGate } from './useOvnCollectorFeatureGate';
import { fetchCollectorSnapshot } from './collectorApi';
import { buildLadderModel } from './logicalLadderModel';
import ConstructDrawerBody from './ConstructDrawerBody';
import SnapshotJsonControls from './SnapshotJsonControls';
import LogicalLadderView, { networkDisplayName, roleIcon, roleLabel } from './LogicalLadderView';
import SnapshotStatusLine from './SnapshotStatusLine';
import { freshnessFromAge, parseSnapshotAgeMs } from './snapshotFreshness';
import { navigateToPath } from './navigateToPath';

const REFRESH_INTERVAL_MS = 30000;

const resolveNodeName = (routeName?: string): string => {
    const fromRoute = routeName?.trim();
    if (fromRoute) {
        return fromRoute;
    }

    if (typeof window === 'undefined') {
        return '';
    }

    const path = window.location.pathname || '';
    const match = path.match(/\/ovn-recon\/ovn\/([^/?#]+)/);
    if (!match || !match[1]) {
        return '';
    }

    try {
        return decodeURIComponent(match[1]);
    } catch {
        return match[1];
    }
};

interface Point {
    x: number;
    y: number;
}

const NodeLogicalTopologyDetails: React.FC = () => {
    const { name: routeName } = useParams<{ name?: string }>();
    const name = React.useMemo(() => resolveNodeName(routeName), [routeName]);
    const { enabled, loaded: gateLoaded, loadError: gateError } = useOvnCollectorFeatureGate();

    // The host selector lists every NodeNetworkState, the plugin's node index
    // (the node list and the physical view's host selector use it too), so every
    // entry point agrees on what the nodes are. The collector's own node set is
    // not used on purpose: a node with an NNS the collector cannot snapshot
    // should appear here and fail visibly, not vanish (ovn-recon-60x).
    const [nodeNetworkStates] = useK8sWatchResource<NodeNetworkState[]>({
        groupVersionKind: { group: 'nmstate.io', version: 'v1beta1', kind: 'NodeNetworkState' },
        isList: true,
    });
    const nodeNames = React.useMemo(() => {
        const names = new Set((nodeNetworkStates ?? []).map((nns) => nns.metadata?.name || '').filter(Boolean));
        // Keep the current node selectable before the list has loaded, or when it
        // carries no NodeNetworkState, so the select never shows the wrong node.
        if (name) names.add(name);
        return Array.from(names).sort((a, b) => a.localeCompare(b));
    }, [nodeNetworkStates, name]);

    const [snapshot, setSnapshot] = React.useState<LogicalTopologySnapshot | null>(null);
    const [isLoading, setIsLoading] = React.useState<boolean>(false);
    const [snapshotError, setSnapshotError] = React.useState<string>('');
    const [lastLoadedAt, setLastLoadedAt] = React.useState<number>(Date.now());
    const [search, setSearch] = React.useState<string>('');
    const [networkFilter, setNetworkFilter] = React.useState<string>('all');

    // Relationships-tab navigation reveals the target: a network filter
    // hiding it follows it, and the view reports the laid-out position so
    // the page can pan it into view (drawer navigation only, matching the
    // physical view).
    const [revealRequest, setRevealRequest] = React.useState<{ uuid: string; nonce: number }>();
    const canvasRef = React.useRef<HTMLDivElement | null>(null);
    const [selectedUuid, setSelectedUuid] = React.useState<string | null>(null);
    const [zoom, setZoom] = React.useState<number>(1);
    const [pan, setPan] = React.useState<Point>({ x: 0, y: 0 });
    const [isDragging, setIsDragging] = React.useState<boolean>(false);
    const [lastPointer, setLastPointer] = React.useState<Point | null>(null);

    // Same control as the cluster view's "Filter by host", but that page filters
    // a merged model in place while this one holds a single node's snapshot, so
    // here a choice is a route change: another node loads its snapshot, and
    // "All hosts" climbs back out to the cluster view.
    const handleHostSelect = (_event: React.FormEvent<HTMLSelectElement>, value: string) => {
        if (value === 'all') {
            navigateToPath('/ovn-recon/ovn');
        } else if (value && value !== name) {
            navigateToPath(`/ovn-recon/ovn/${encodeURIComponent(value)}`);
        }
    };

    // A snapshot is per node. Switching nodes must not leave the previous node's
    // constructs, selection, filters or viewport on screen under the new title
    // while the next snapshot loads.
    React.useEffect(() => {
        setSnapshot(null);
        setSnapshotError('');
        setSelectedUuid(null);
        setRevealRequest(undefined);
        setSearch('');
        setNetworkFilter('all');
        setZoom(1);
        setPan({ x: 0, y: 0 });
    }, [name]);

    const loadSnapshot = React.useCallback(async () => {
        if (!enabled || !name) return;

        setIsLoading(true);
        setSnapshotError('');

        try {
            const payload = await fetchCollectorSnapshot(name);
            setSnapshot(payload);
            setLastLoadedAt(Date.now());
        } catch (error) {
            // Keep the last-good snapshot rendered: a transient failure (a
            // collector pod handoff, a proxy blip) must not blank the view.
            setSnapshotError(error instanceof Error ? error.message : 'Failed to load logical topology');
        } finally {
            setIsLoading(false);
        }
    }, [enabled, name]);

    React.useEffect(() => {
        if (!enabled || !name) return;

        loadSnapshot();
        const timer = window.setInterval(() => {
            loadSnapshot();
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

    const model = React.useMemo(() => {
        if (!snapshot?.database) return null;
        return buildLadderModel(snapshot.database);
    }, [snapshot]);

    const needsCollectorUpgrade = snapshot != null && snapshot.database == null;
    const hasNoGraphData = model != null && model.constructs.length === 0;

    const selectedConstruct = React.useMemo(
        () => (model && selectedUuid ? model.constructByUuid.get(selectedUuid) ?? null : null),
        [model, selectedUuid],
    );

    const selectConstructFromDrawer = React.useCallback((uuid: string) => {
        const target = model?.constructByUuid.get(uuid);
        if (target) {
            setNetworkFilter((current) => (current !== 'all' && current !== target.network ? target.network : current));
        }
        setSelectedUuid(uuid);
        setRevealRequest((current) => ({ uuid, nonce: (current?.nonce ?? 0) + 1 }));
    }, [model]);

    const revealPosition = React.useCallback((position: Point) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const { width: cw, height: ch } = canvas.getBoundingClientRect();
        setPan({ x: cw / 2 - position.x * zoom, y: ch / 2 - position.y * zoom });
    }, [zoom]);

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
            <DocumentTitle>{`OVN Recon - Logical OVN (${name})`}</DocumentTitle>
            <PageSection>
                <Breadcrumb>
                    <BreadcrumbItem>
                        <Link to="/ovn-recon/node-network-state">OVN Recon</Link>
                    </BreadcrumbItem>
                    <BreadcrumbItem>
                        <Link to="/ovn-recon/ovn">Cluster logical topology</Link>
                    </BreadcrumbItem>
                    <BreadcrumbItem isActive>Logical OVN: {name}</BreadcrumbItem>
                </Breadcrumb>
                <Title headingLevel="h1" className="pf-u-mt-lg">Logical OVN Topology: {name}</Title>
                {/* Mirror of the physical page's "View logical OVN topology
                    for this node" link, so the two views cross-link
                    symmetrically (ovn-recon-xfr). */}
                <p className="pf-u-mt-sm">
                    <Link to={`/ovn-recon/node-network-state/${encodeURIComponent(name)}`}>
                        View physical topology for this node
                    </Link>
                </p>
            </PageSection>
            <PageSection isFilled>
                <Drawer isExpanded={selectedConstruct != null}>
                    <DrawerContent
                        panelContent={(
                            <DrawerPanelContent isResizable widths={{ default: 'width_33' }} minSize="320px">
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
                                        <DrawerPanelBody>
                                            <ConstructDrawerBody
                                                construct={selectedConstruct}
                                                model={model}
                                                fallbackNode={name}
                                                physicalHref={(node) => `/ovn-recon/node-network-state/${encodeURIComponent(node)}`}
                                                onSelectConstruct={selectConstructFromDrawer}
                                                database={snapshot?.database ?? null}
                                                databaseNode={name}
                                            />
                                        </DrawerPanelBody>
                                    </>
                                )}
                            </DrawerPanelContent>
                        )}
                    >
                        <Card>
                            <CardTitle>Logical Topology</CardTitle>
                            <CardBody>
                                <AlertGroup isToast={false}>
                                    {snapshotError && (
                                        <Alert variant="warning" isInline title={snapshotError}>
                                            {snapshot ? 'Showing the last loaded topology; refresh retries automatically.' : null}
                                        </Alert>
                                    )}
                                    {snapshot && snapshot.warnings.length > 0 && (
                                        <Alert
                                            variant="warning"
                                            isInline
                                            isExpandable
                                            title={`${snapshot.warnings.length} collector warning${snapshot.warnings.length === 1 ? '' : 's'}`}
                                        >
                                            {snapshot.warnings.map((warning) => (
                                                <div key={`${warning.code}:${warning.message}`}>
                                                    {warning.code}: {warning.message}
                                                </div>
                                            ))}
                                        </Alert>
                                    )}
                                    {needsCollectorUpgrade && (
                                        <Alert
                                            variant="danger"
                                            isInline
                                            title={`Snapshot schema "${snapshot?.metadata?.schemaVersion}" is not supported`}
                                        >
                                            This view requires snapshot contract v2. Upgrade the ovn-collector
                                            image so snapshots include the logical database payload.
                                        </Alert>
                                    )}
                                    {hasNoGraphData && (
                                        <Alert
                                            variant="info"
                                            isInline
                                            title={`No logical topology returned for ${name || 'this node'}.`}
                                        >
                                            The collector request succeeded, but the snapshot database holds no
                                            switches or routers for this node.
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
                                            value={name}
                                            onChange={handleHostSelect}
                                        >
                                            <FormSelectOption value="all" label="All hosts" />
                                            {nodeNames.map((nodeName) => (
                                                <FormSelectOption key={nodeName} value={nodeName} label={nodeName} />
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
                                        <Button variant="tertiary" onClick={() => loadSnapshot()} isDisabled={isLoading}>
                                            Refresh now
                                        </Button>
                                    </FlexItem>
                                    {snapshot && (
                                        <FlexItem>
                                            <SnapshotJsonControls
                                                label={`${name} cached snapshot`}
                                                filename={`${name}-snapshot.json`}
                                                payload={snapshot}
                                            />
                                        </FlexItem>
                                    )}
                                    {snapshot && !needsCollectorUpgrade && (
                                        <FlexItem align={{ default: 'alignRight' }}>
                                            <SnapshotStatusLine
                                                freshness={freshnessState}
                                                ageMs={snapshotAgeMs}
                                                sourceHealth={snapshot.metadata.sourceHealth}
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

export default NodeLogicalTopologyDetails;
