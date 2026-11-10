import * as React from 'react';
import { DocumentTitle, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import { useParams, Link, useNavigate } from 'react-router';
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
import ConstructDrawerBody, { LOGICAL_DRAWER_WIDTH } from './ConstructDrawerBody';
import { useLadderViewport } from './useLadderViewport';
import SnapshotJsonControls from './SnapshotJsonControls';
import LogicalLadderView, {
    LadderSearch,
    ladderSearchMatches,
    networkDisplayName,
    roleIcon,
    roleLabel,
} from './LogicalLadderView';
import SnapshotStatusLine, { summarizeOvnZones } from './SnapshotStatusLine';
import { useChassisNodeNames } from './useChassisNodeNames';
import { freshnessFromAge, parseSnapshotAgeMs } from './snapshotFreshness';
import { constructSelectValue, findConstructBySelectValue, useSelectionDeepLink } from './useSelectParam';
import { detailHrefFor } from './constructDetailLinks';

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

    // Gateway port placement in the drawer names chassis by SB chassis id;
    // Nodes carry the mapping back to node names.
    const nodeForChassis = useChassisNodeNames();

    const [snapshot, setSnapshot] = React.useState<LogicalTopologySnapshot | null>(null);
    // The node the snapshot on screen was fetched for. A select link applies
    // only to that node's model, never to the previous node's in the render
    // between a route change and the reset below.
    const [snapshotNode, setSnapshotNode] = React.useState<string>('');
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
    const [selectedUuid, setSelectedUuid] = React.useState<string | null>(null);
    // Pan, zoom and reveal against the canvas left beside the inline drawer
    // (ovn-recon-dp7.7).
    const viewport = useLadderViewport({ selectedUuid, minZoom: 0.4 });

    // Same control as the cluster view's "Filter by host", but that page filters
    // a merged model in place while this one holds a single node's snapshot, so
    // here a choice is a route change: another node loads its snapshot, and
    // "All hosts" climbs back out to the cluster view.
    const navigate = useNavigate();
    const handleHostSelect = (_event: React.FormEvent<HTMLSelectElement>, value: string) => {
        if (value === 'all') {
            navigate('/ovn-recon/ovn');
        } else if (value && value !== name) {
            navigate(`/ovn-recon/ovn/${encodeURIComponent(value)}`);
        }
    };

    // A snapshot is per node. Switching nodes must not leave the previous node's
    // constructs, selection, filters or viewport on screen under the new title
    // while the next snapshot loads.
    React.useEffect(() => {
        setSnapshot(null);
        setSnapshotNode('');
        setSnapshotError('');
        setSelectedUuid(null);
        setRevealRequest(undefined);
        setSearch('');
        setNetworkFilter('all');
        viewport.resetView();
    }, [name]);

    const loadSnapshot = React.useCallback(async () => {
        if (!enabled || !name) return;

        setIsLoading(true);
        setSnapshotError('');

        try {
            const payload = await fetchCollectorSnapshot(name);
            setSnapshot(payload);
            setSnapshotNode(name);
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

    // select=KIND:NAME in the URL (ovn-recon-s3t.16): restored through the
    // same path as drawer navigation, written back on every selection change.
    useSelectionDeepLink({
        selected: selectedConstruct,
        encode: constructSelectValue,
        resolve: (value) => (model && snapshotNode === name ? findConstructBySelectValue(model, value) : null),
        apply: (construct) => selectConstructFromDrawer(construct.uuid),
    });

    const searchMatches = React.useMemo(
        () => (model ? ladderSearchMatches(model, networkFilter, search) : []),
        [model, networkFilter, search],
    );

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
                        <Link to="/ovn-recon">OVN Recon</Link>
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
                <Drawer isExpanded={selectedConstruct != null} isInline>
                    <DrawerContent
                        panelContent={(
                            <DrawerPanelContent isResizable widths={{ default: LOGICAL_DRAWER_WIDTH }} minSize="320px">
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
                                        <ConstructDrawerBody
                                            construct={selectedConstruct}
                                            model={model}
                                            fallbackNode={name}
                                            physicalHref={(node) => `/ovn-recon/node-network-state/${encodeURIComponent(node)}`}
                                            onSelectConstruct={selectConstructFromDrawer}
                                            database={snapshot?.database ?? null}
                                            databaseNode={name}
                                            sectionsRefreshKey={snapshot?.metadata?.generatedAt}
                                            nodeForChassis={nodeForChassis}
                                            detailHref={detailHrefFor(name, selectedConstruct)}
                                        />
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
                                        <LadderSearch
                                            value={search}
                                            onChange={setSearch}
                                            matches={searchMatches}
                                            selectedUuid={selectedUuid}
                                            onReveal={selectConstructFromDrawer}
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
                                    <FlexItem><Button variant="secondary" onClick={viewport.zoomOut}>-</Button></FlexItem>
                                    <FlexItem><Button variant="secondary" onClick={viewport.zoomIn}>+</Button></FlexItem>
                                    <FlexItem><Button variant="link" onClick={viewport.resetView}>Reset view</Button></FlexItem>
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
                                                ovn={summarizeOvnZones([snapshot.database?.nbGlobal])}
                                                isLoading={isLoading}
                                            />
                                        </FlexItem>
                                    )}
                                </Flex>

                                <div
                                    {...viewport.canvasProps}
                                    className="pf-u-mt-md"
                                    data-testid="ladder-canvas"
                                    style={{ height: 'max(560px, calc(100vh - 340px))', border: '1px solid var(--pf-t--global--border--color--default)', overflow: 'hidden', cursor: viewport.isDragging ? 'grabbing' : 'grab' }}
                                >
                                    {model && (
                                        <div data-testid="ladder-content" style={{ transform: viewport.contentTransform, transformOrigin: '0 0' }}>
                                            <LogicalLadderView
                                                model={model}
                                                selectedUuid={selectedUuid}
                                                onSelect={setSelectedUuid}
                                                networkFilter={networkFilter}
                                                search={search}
                                                revealRequest={revealRequest}
                                                onRevealBox={viewport.onRevealBox}
                                                onSelectedBox={viewport.onSelectedBox}
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
