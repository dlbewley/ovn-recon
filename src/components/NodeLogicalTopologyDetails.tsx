import * as React from 'react';
import { useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import { useNavigate } from 'react-router';
import {
    PageSection,
    Title,
    EmptyState,
    EmptyStateBody,
    Card,
    CardTitle,
    CardBody,
    Drawer,
    DrawerContent,
    DrawerPanelContent,
    DrawerHead,
    DrawerActions,
    DrawerCloseButton,
    FormSelect,
    FormSelectOption,
    ToolbarItem,
    Alert,
    AlertGroup,
} from '@patternfly/react-core';

import { LogicalTopologySnapshot, NodeNetworkState } from '../types';
import { useOvnCollectorFeatureGate } from './useOvnCollectorFeatureGate';
import { fetchCollectorSnapshot } from './collectorApi';
import { buildLadderModel, LadderConstruct } from './logicalLadderModel';
import { FindingsSection } from '../insights/ui/FindingsViews';
import { useHideInfoFindings, visibleFindings } from '../insights/ui/useFindings';
import { constructFindings, useLogicalFindings, zoneFindings } from '../insights/ui/useLogicalFindings';
import { useLogicalClusterInputs, useNodePods } from '../insights/ui/useLogicalInputs';
import ConstructDrawerBody, { LOGICAL_DRAWER_WIDTH } from './ConstructDrawerBody';
import { useLadderViewport } from './useLadderViewport';
import ViewToolbar from './ViewToolbar';
import { LogicalLegend } from './GraphLegend';
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
import { clusterLogicalPath, nodeLogicalPath, nodePhysicalPath } from '../routes';

const REFRESH_INTERVAL_MS = 30000;

export interface NodeLogicalTopologyBodyProps {
    /** The node whose zone is drawn. */
    name: string;
    /**
     * What the host puts above the view, drawn once the collector gate has let the
     * view through. The routed page passes its document title, breadcrumb, heading
     * and cross-link; a host with a header of its own passes nothing.
     */
    header?: React.ReactNode;
    /**
     * Leave the "Filter by host" select out of the toolbar, for a host that has its
     * own way to change node. The NodeNetworkState list that fills it is then not
     * watched either.
     */
    hideHostSelect?: boolean;
    /**
     * Draw the view edge to edge, without the page padding, the card's frame or its
     * title: for a host that frames it (the explorer's node scope, ovn-recon-gbr.5),
     * so a collapsed tree leaves the ladder the width the routed page gave it.
     */
    flush?: boolean;
}

/**
 * One node's logical OVN topology: the ladder, its toolbar and its drawer, and the
 * states of the collector gate. Everything the routed page shows below its own
 * header. It reads and writes `?select=` on whatever page hosts it.
 */
export const NodeLogicalTopologyBody: React.FC<NodeLogicalTopologyBodyProps> = ({
    name,
    header,
    hideHostSelect = false,
    flush = false,
}) => {
    const { enabled, loaded: gateLoaded, loadError: gateError } = useOvnCollectorFeatureGate();

    // The host selector lists every NodeNetworkState, the plugin's node index
    // (the node list and the physical view's host selector use it too), so every
    // entry point agrees on what the nodes are. The collector's own node set is
    // not used on purpose: a node with an NNS the collector cannot snapshot
    // should appear here and fail visibly, not vanish (ovn-recon-60x).
    const [nodeNetworkStates] = useK8sWatchResource<NodeNetworkState[]>(hideHostSelect ? null : {
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
            navigate(clusterLogicalPath());
        } else if (value && value !== name) {
            navigate(nodeLogicalPath(value));
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

    // Findings (ovn-recon-7i6.3): evaluated on the snapshot fetched for this node,
    // with this node's pods and, where the CRDs exist, the NADs and
    // MultiNetworkPolicies. Those on a construct badge its card and open its drawer;
    // the rest (the zone's collection, rows on no one construct) list above the ladder.
    const pods = useNodePods(enabled ? name : undefined);
    const logicalClusterInputs = useLogicalClusterInputs();
    const allFindings = useLogicalFindings({
        nodeName: name,
        snapshot: snapshotNode === name ? snapshot : null,
        pods,
        cluster: logicalClusterInputs,
    });
    const [hideInfo, setHideInfo] = useHideInfoFindings();
    const findings = React.useMemo(() => visibleFindings(allFindings, hideInfo), [allFindings, hideInfo]);
    const pageFindings = React.useMemo(() => zoneFindings(findings), [findings]);
    const findingsFor = React.useCallback(
        (construct: LadderConstruct) => constructFindings([findings], construct, name),
        [findings, name],
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
            {header}
            <PageSection isFilled padding={flush ? { default: 'noPadding' } : undefined}>
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
                                            physicalHref={(node) => nodePhysicalPath(node)}
                                            onSelectConstruct={selectConstructFromDrawer}
                                            database={snapshot?.database ?? null}
                                            databaseNode={name}
                                            sectionsRefreshKey={snapshot?.metadata?.generatedAt}
                                            nodeForChassis={nodeForChassis}
                                            detailHref={detailHrefFor(name, selectedConstruct)}
                                            findings={findings}
                                            hideInfo={hideInfo}
                                        />
                                    </>
                                )}
                            </DrawerPanelContent>
                        )}
                    >
                        <Card isPlain={flush}>
                            {!flush && <CardTitle>Logical Topology</CardTitle>}
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

                                {pageFindings.length > 0 && (
                                    <div className="pf-u-mt-md" data-testid="zone-findings">
                                        <FindingsSection findings={pageFindings} />
                                    </div>
                                )}

                                <div className="pf-u-mt-md">
                                    <ViewToolbar
                                        label="Logical topology view"
                                        filters={(
                                            <>
                                                <ToolbarItem>
                                                    <LadderSearch
                                                        value={search}
                                                        onChange={setSearch}
                                                        matches={searchMatches}
                                                        selectedUuid={selectedUuid}
                                                        onReveal={selectConstructFromDrawer}
                                                    />
                                                </ToolbarItem>
                                                {!hideHostSelect && (
                                                    <ToolbarItem>
                                                        <FormSelect
                                                            aria-label="Filter by host"
                                                            style={{ minWidth: '10rem' }}
                                                            value={name}
                                                            onChange={handleHostSelect}
                                                        >
                                                            <FormSelectOption value="all" label="All hosts" />
                                                            {nodeNames.map((nodeName) => (
                                                                <FormSelectOption key={nodeName} value={nodeName} label={nodeName} />
                                                            ))}
                                                        </FormSelect>
                                                    </ToolbarItem>
                                                )}
                                                <ToolbarItem>
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
                                                </ToolbarItem>
                                            </>
                                        )}
                                        viewOptions={allFindings.some((finding) => finding.severity === 'info')
                                            ? [{ id: 'hide-info-findings-toggle', label: 'Hide info findings', checked: hideInfo, onChange: setHideInfo }]
                                            : undefined}
                                        zoom={{ onZoomOut: viewport.zoomOut, onZoomIn: viewport.zoomIn, onReset: viewport.resetView }}
                                        legend={<LogicalLegend />}
                                        refresh={{ onRefresh: () => loadSnapshot(), isLoading }}
                                        json={snapshot ? { label: `${name} cached snapshot`, filename: `${name}-snapshot.json`, payload: snapshot } : undefined}
                                        status={snapshot && !needsCollectorUpgrade ? (
                                            <SnapshotStatusLine
                                                freshness={freshnessState}
                                                ageMs={snapshotAgeMs}
                                                sourceHealth={snapshot.metadata.sourceHealth}
                                                ovn={summarizeOvnZones([snapshot.database?.nbGlobal])}
                                                isLoading={isLoading}
                                            />
                                        ) : undefined}
                                    />
                                </div>

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
                                                findingsFor={findingsFor}
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

