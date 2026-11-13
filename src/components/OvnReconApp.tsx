import * as React from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import {
    Button,
    Drawer,
    DrawerContent,
    DrawerPanelBody,
    DrawerPanelContent,
    EmptyState,
    EmptyStateBody,
    Flex,
    FlexItem,
    PageSection,
    Spinner,
    Title,
} from '@patternfly/react-core';
import { AngleDoubleLeftIcon, AngleDoubleRightIcon } from '@patternfly/react-icons';
import { DocumentTitle } from '@openshift-console/dynamic-plugin-sdk';

import {
    ExplorerView,
    networkPath,
    nodePhysicalPath,
    overviewPath,
    searchPath,
    SHELL_ROUTES,
    viewForLocation,
} from '../routes';
import { ClusterSearchInput, ClusterSearchRoute, useClusterSearch } from './ClusterSearch';
import {
    ClusterFindingsTab,
    ClusterLogicalTab,
    ClusterNetworksTab,
    ClusterNodesTab,
    ClusterScopeHeader,
    ClusterSearchTab,
} from './ClusterScope';
import CollectorStatus from './CollectorStatus';
import ExplorerTree from './ExplorerTree';
import {
    ExplorerTreeItem,
    ExplorerTreeNetwork,
    ExplorerTreeNode,
    NETWORKS_GROUP_ID,
    NODES_GROUP_ID,
    selectedItemId,
} from './explorerTreeModel';
import { ExplorerData, useExplorerData } from './useExplorerData';

/**
 * The OVN Recon explorer (ovn-recon-gbr.4): the one page the plugin registers. The
 * console mounts it at `/ovn-recon/*` (one non-exact `console.page/route`) and keeps
 * it mounted while the path beneath changes, so the tree, its filter and the cluster
 * watches outlive every hop inside OVN Recon. It is mounted afresh after a trip to
 * another console page, and twice on a cold page load (the console replaces its
 * whole frame once at startup), so nothing here is one-shot work on mount.
 *
 * Top to bottom: a title row (the page title, the collector's status and the cluster
 * search box), then an inline PatternFly Drawer whose resizable start panel holds the
 * tree and whose content is the selected scope. A round button on the divider
 * collapses the tree to a rail. The Cluster scope (Nodes, Networks, Findings, Logical
 * topology, Search results) is drawn here. Node, network and construct URLs still
 * render their own pages, loaded on demand, with the tree beside them; they move into
 * the shell as scopes of their own in ovn-recon-gbr.5 and ovn-recon-gbr.6.
 *
 * The URL holds the selection and the tab (`viewForLocation`). The tree's width and
 * whether it is collapsed are plain component state until ovn-recon-gbr.9 keeps them
 * in the console's user settings.
 */

const NodeNetworkStateDetails = React.lazy(() => import('./NodeNetworkStateDetails'));
const NodeLogicalTopologyDetails = React.lazy(() => import('./NodeLogicalTopologyDetails'));
const ConstructDetails = React.lazy(() => import('./ConstructDetails'));
const NetworkDetails = React.lazy(() => import('./NetworkDetails'));

export const TREE_PANEL_ID = 'ovn-recon-explorer-tree';
export const TREE_DEFAULT_SIZE = '280px';
export const TREE_MIN_SIZE = '200px';
export const TREE_MAX_SIZE = '480px';
const RAIL_SIZE = '48px';
/** Half the round collapse button, so it sits astride the divider. */
const TOGGLE_HALF = 14;

// --- Small parts --------------------------------------------------------------------

const Loading: React.FC = () => (
    <PageSection>
        <Spinner size="lg" aria-label="Loading" />
    </PageSection>
);

const NotFound: React.FC = () => {
    const location = useLocation();
    return (
        <PageSection>
            <DocumentTitle>OVN Recon - Page not found</DocumentTitle>
            <EmptyState titleText="Page not found" headingLevel="h2" data-testid="explorer-not-found">
                <EmptyStateBody>
                    OVN Recon has no page at <code>{location.pathname}</code>.{' '}
                    <Link to={overviewPath()}>Go to the cluster</Link>.
                </EmptyStateBody>
            </EmptyState>
        </PageSection>
    );
};

/** `/ovn-recon` and `/ovn-recon/node-network-state`: the Nodes tab, or an old `?q=` search link. */
const ClusterIndex: React.FC<{ view: ExplorerView | null; data: ExplorerData }> = ({ view, data }) => {
    if (view?.scope === 'cluster' && view.tab === 'search') {
        return <Navigate to={searchPath(view.params.q ?? '')} replace />;
    }
    return <ClusterNodesTab data={data} />;
};

/** The width of the tree's panel, followed while it is dragged; the fallback until it is measured. */
const usePanelWidth = (
    container: React.RefObject<HTMLDivElement>,
    active: boolean,
    fallback: string,
): number => {
    const [width, setWidth] = React.useState<number>(() => parseInt(fallback, 10));
    React.useLayoutEffect(() => {
        if (!active) return undefined;
        const panel = container.current?.querySelector<HTMLElement>(`#${TREE_PANEL_ID}`);
        if (!panel) return undefined;
        const measure = () => {
            if (panel.offsetWidth > 0) setWidth(panel.offsetWidth);
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(measure);
        observer.observe(panel);
        return () => observer.disconnect();
    }, [container, active]);
    return width;
};

// --- The shell ----------------------------------------------------------------------

const OvnReconApp: React.FC = () => {
    const location = useLocation();
    const navigate = useNavigate();
    const view = React.useMemo(
        () => viewForLocation({ pathname: location.pathname, search: location.search }),
        [location.pathname, location.search],
    );
    const data = useExplorerData();
    const onSearchTab = view?.scope === 'cluster' && view.tab === 'search';

    // Search lives at its own path, never as `?q=` on whatever page is open (the
    // construct page reads `?q=` as its own filter).
    const searchRoute = React.useMemo<ClusterSearchRoute>(() => ({
        submitted: onSearchTab ? view.params.q ?? '' : '',
        go: (text: string) => {
            if (text !== '') navigate(searchPath(text));
            else if (onSearchTab) navigate(overviewPath());
        },
    }), [onSearchTab, view, navigate]);
    const search = useClusterSearch({
        nodeNetworkStates: data.nodeNetworkStates ?? undefined,
        nodes: data.nodes,
        stateLoaded: data.nodeNetworkStatesSettled,
        stateError: data.nodeNetworkStatesError,
        collectorEnabled: data.collector.enabled,
        gateLoaded: data.collector.gateLoaded,
        route: searchRoute,
    });

    // --- The tree's state: kept here so it outlives the tree being collapsed.
    const [collapsed, setCollapsed] = React.useState(false);
    const [treeSize, setTreeSize] = React.useState(TREE_DEFAULT_SIZE);
    const [filter, setFilter] = React.useState('');
    const [openGroups, setOpenGroups] = React.useState<ReadonlySet<string>>(() => new Set([NODES_GROUP_ID]));
    const [showAllNetworks, setShowAllNetworks] = React.useState(false);
    const selectedId = selectedItemId(view);

    // A group that holds the selection is open, and stays open once the selection moves.
    React.useEffect(() => {
        const group = view?.scope === 'node' ? NODES_GROUP_ID : view?.scope === 'network' ? NETWORKS_GROUP_ID : null;
        if (group) setOpenGroups((open) => (open.has(group) ? open : new Set([...open, group])));
    }, [view?.scope]);

    const toggleGroup = React.useCallback((groupId: string, open: boolean) => {
        setOpenGroups((current) => {
            if (current.has(groupId) === open) return current;
            const next = new Set(current);
            if (open) next.add(groupId);
            else next.delete(groupId);
            return next;
        });
    }, []);

    const treeNodes = React.useMemo<ExplorerTreeNode[]>(
        () => data.summaries.map((summary) => ({ name: summary.name, role: data.roles.get(summary.name) ?? '' })),
        [data.summaries, data.roles],
    );
    const treeNetworks = React.useMemo<ExplorerTreeNetwork[]>(
        () => data.networkRows.map(({ record }) => (record.namespace === undefined
            ? { kind: record.kind, name: record.name }
            : { kind: record.kind, namespace: record.namespace, name: record.name })),
        [data.networkRows],
    );

    const selectItem = (item: ExplorerTreeItem) => {
        if (item.kind === 'more') {
            setShowAllNetworks(true);
        } else if (item.id !== selectedId) {
            // Selecting what is already selected stays on its tab.
            if (item.kind === 'cluster') navigate(overviewPath());
            else if (item.kind === 'node' && item.node) navigate(nodePhysicalPath(item.node));
            else if (item.kind === 'network' && item.network) navigate(networkPath(item.network));
        }
    };

    // --- Collapse and expand, moving focus to the button that undoes it.
    const container = React.useRef<HTMLDivElement>(null);
    const collapseButton = React.useRef<HTMLButtonElement>(null);
    const expandButton = React.useRef<HTMLButtonElement>(null);
    const toggled = React.useRef(false);
    React.useEffect(() => {
        if (!toggled.current) return;
        toggled.current = false;
        (collapsed ? expandButton : collapseButton).current?.focus();
    }, [collapsed]);
    const setTreeCollapsed = (value: boolean) => {
        toggled.current = true;
        setCollapsed(value);
    };
    const panelWidth = usePanelWidth(container, !collapsed, treeSize);

    const panel = collapsed ? (
        <DrawerPanelContent
            id={TREE_PANEL_ID}
            defaultSize={RAIL_SIZE}
            minSize={RAIL_SIZE}
            maxSize={RAIL_SIZE}
            data-testid="explorer-rail"
        >
            <Flex justifyContent={{ default: 'justifyContentCenter' }} style={{ paddingBlockStart: 'var(--pf-t--global--spacer--sm)' }}>
                <Button
                    ref={expandButton}
                    variant="plain"
                    aria-label="Expand the tree"
                    aria-expanded={false}
                    aria-controls={TREE_PANEL_ID}
                    icon={<AngleDoubleRightIcon />}
                    onClick={() => setTreeCollapsed(false)}
                    data-testid="explorer-tree-expand"
                />
            </Flex>
        </DrawerPanelContent>
    ) : (
        <DrawerPanelContent
            id={TREE_PANEL_ID}
            isResizable
            defaultSize={treeSize}
            minSize={TREE_MIN_SIZE}
            maxSize={TREE_MAX_SIZE}
            resizeAriaLabel="Resize the tree"
            onResize={(_event, width) => setTreeSize(`${Math.round(width)}px`)}
            data-testid="explorer-tree-panel"
        >
            <DrawerPanelBody>
                <ExplorerTree
                    nodes={treeNodes}
                    networks={treeNetworks}
                    selectedId={selectedId}
                    filter={filter}
                    onFilterChange={setFilter}
                    openGroups={openGroups}
                    onGroupToggle={toggleGroup}
                    showAllNetworks={showAllNetworks}
                    onSelectItem={selectItem}
                />
            </DrawerPanelBody>
        </DrawerPanelContent>
    );

    return (
        <div data-testid="ovn-recon-explorer">
            <PageSection
                padding={{ default: 'noPadding' }}
                style={{ padding: 'var(--pf-t--global--spacer--md) var(--pf-t--global--spacer--lg)' }}
                data-testid="explorer-title-row"
            >
                <Flex
                    alignItems={{ default: 'alignItemsCenter' }}
                    spaceItems={{ default: 'spaceItemsLg' }}
                    rowGap={{ default: 'rowGapSm' }}
                >
                    <FlexItem><Title headingLevel="h1">OVN Recon</Title></FlexItem>
                    <FlexItem data-testid="explorer-collector-status">
                        <CollectorStatus collector={data.collector} />
                    </FlexItem>
                    <FlexItem align={{ default: 'alignRight' }} style={{ width: 'min(26rem, 100%)' }} data-testid="explorer-search">
                        <ClusterSearchInput search={search} placeholder="Find an IP, CIDR, MAC or name" />
                    </FlexItem>
                </Flex>
            </PageSection>

            <div ref={container} style={{ position: 'relative' }}>
                {!collapsed && (
                    <Button
                        ref={collapseButton}
                        variant="plain"
                        aria-label="Collapse the tree"
                        aria-expanded
                        aria-controls={TREE_PANEL_ID}
                        icon={<AngleDoubleLeftIcon />}
                        onClick={() => setTreeCollapsed(true)}
                        data-testid="explorer-tree-collapse"
                        style={{
                            position: 'absolute',
                            insetBlockStart: 'var(--pf-t--global--spacer--md)',
                            insetInlineStart: `${panelWidth - TOGGLE_HALF}px`,
                            zIndex: 'var(--pf-t--global--z-index--md)',
                            width: `${TOGGLE_HALF * 2}px`,
                            height: `${TOGGLE_HALF * 2}px`,
                            padding: 0,
                            justifyContent: 'center',
                            borderRadius: '50%',
                            border: '1px solid var(--pf-t--global--border--color--default)',
                            backgroundColor: 'var(--pf-t--global--background--color--primary--default)',
                        }}
                    />
                )}
                <Drawer isExpanded isInline position="start">
                    <DrawerContent panelContent={panel}>
                        {view?.scope === 'cluster' && (
                            <ClusterScopeHeader tab={view.tab} data={data} query={view.params.q} />
                        )}
                        <React.Suspense fallback={<Loading />}>
                            <Routes>
                                <Route index element={<ClusterIndex view={view} data={data} />} />
                                <Route path={SHELL_ROUTES.nodesAlias} element={<ClusterIndex view={view} data={data} />} />
                                <Route path={SHELL_ROUTES.networks} element={<ClusterNetworksTab data={data} />} />
                                <Route path={SHELL_ROUTES.findings} element={<ClusterFindingsTab data={data} />} />
                                <Route path={SHELL_ROUTES.clusterLogical} element={<ClusterLogicalTab />} />
                                <Route path={SHELL_ROUTES.search} element={<ClusterSearchTab search={search} />} />
                                <Route path={SHELL_ROUTES.nodePhysical} element={<NodeNetworkStateDetails />} />
                                <Route path={SHELL_ROUTES.nodeLogical} element={<NodeLogicalTopologyDetails />} />
                                <Route path={SHELL_ROUTES.construct} element={<ConstructDetails />} />
                                <Route path={SHELL_ROUTES.cudn} element={<NetworkDetails />} />
                                <Route path={SHELL_ROUTES.udn} element={<NetworkDetails />} />
                                <Route path={SHELL_ROUTES.nad} element={<NetworkDetails />} />
                                <Route path="*" element={<NotFound />} />
                            </Routes>
                        </React.Suspense>
                    </DrawerContent>
                </Drawer>
            </div>
        </div>
    );
};

export default OvnReconApp;
