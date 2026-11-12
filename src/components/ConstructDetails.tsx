import * as React from 'react';
import { DocumentTitle, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import {
    Alert,
    Breadcrumb,
    BreadcrumbItem,
    Button,
    EmptyState,
    EmptyStateBody,
    EmptyStateFooter,
    Flex,
    FlexItem,
    FormSelect,
    FormSelectOption,
    PageSection,
    Spinner,
    Tab,
    Tabs,
    TabTitleText,
    TextInput,
    Title,
    ToggleGroup,
    ToggleGroupItem,
    ToolbarItem,
} from '@patternfly/react-core';

import { NodeNetworkState, SnapshotSection } from '../types';
import {
    ConfigBody,
    DrawerBodyProps,
    hasLoadBalancerAttachment,
    hasPortsTab,
    OverviewBody,
    PortsBody,
    RelationshipsBody,
    ServicesBody,
    useDrawerFindings,
    useSectionStates,
} from './ConstructDrawerBody';
import {
    clusterLadderPath,
    ConstructDetailTab,
    constructDetailPath,
    constructNameForNode,
    DetailKind,
    detailHrefFor,
    isDetailKind,
    isDetailTab,
    nodeLadderPath,
    sectionsForTab,
    withSearchParams,
} from './constructDetailLinks';
import { networkResourceRef } from './logicalClassification';
import { buildLadderModel, LadderConstruct } from './logicalLadderModel';
import { networkDisplayName, roleIcon, roleLabel } from './LogicalLadderView';
import { NatRuleTable, StaticRouteTable } from './RouterRuleTables';
import PolicyBody from './PolicyTables';
import SnapshotStatusLine, { summarizeOvnZones } from './SnapshotStatusLine';
import { freshnessFromAge, parseSnapshotAgeMs } from './snapshotFreshness';
import { useChassisNodeNames } from './useChassisNodeNames';
import { useConstructDetailData } from './useConstructDetailData';
import { useOvnCollectorFeatureGate } from './useOvnCollectorFeatureGate';
import { LinkOutProvider } from '../linkOut/LinkOut';
import { FindingsSection } from '../insights/ui/FindingsViews';
import { useHideInfoFindings } from '../insights/ui/useFindings';
import { useLogicalFindings } from '../insights/ui/useLogicalFindings';
import { useNodePods } from '../insights/ui/useLogicalInputs';
import { getResourcePath } from '../topology/links';

const SUBTLE: React.CSSProperties = { color: 'var(--pf-t--global--text--color--subtle)' };
const PAGE_ROWS = 50;
const PAGE_ROW_CHOICES = [20, 50, 100];

const TABLE_FOR_KIND: Record<DetailKind, string> = {
    switch: 'Logical_Switch',
    router: 'Logical_Router',
};

const TAB_TITLES: Record<ConstructDetailTab, string> = {
    overview: 'Overview',
    relationships: 'Relationships',
    ports: 'Ports',
    policy: 'Policy',
    services: 'Services',
    routes: 'Routes and NAT',
    config: 'Config',
};

/**
 * The tabs a construct has. Ports for switches; Services for a switch or
 * router that attaches load balancers (the tab says "not collected" when the
 * section is missing); Routes and NAT for routers. Policy for switches: ACLs
 * attach to switches and port groups, not routers.
 */
export const detailTabsFor = (construct: LadderConstruct): ConstructDetailTab[] => [
    'overview',
    'relationships',
    ...(hasPortsTab(construct) ? (['ports', 'policy'] as const) : []),
    ...(hasLoadBalancerAttachment(construct) ? (['services'] as const) : []),
    ...(construct.kind === 'router' ? (['routes'] as const) : []),
    'config',
];

/**
 * Before the snapshot has arrived the construct's tabs are unknown; a tab
 * that fits the kind in the URL may still start its section request at once.
 */
const tabFitsKind = (tab: ConstructDetailTab, kind: DetailKind): boolean => {
    if (tab === 'ports' || tab === 'policy') return kind === 'switch';
    if (tab === 'routes') return kind === 'router';
    return true;
};

const NO_SECTIONS: readonly SnapshotSection[] = [];

/** Routes and NAT: every static route and NAT rule, paginated, one filter for both. */
const RoutesBody: React.FC<{
    construct: LadderConstruct;
    database: DrawerBodyProps['database'];
    nodeHref: (node: string) => string;
    query: string;
    onQueryChange: (value: string) => void;
}> = ({ construct, database, nodeHref, query, onQueryChange }) => {
    const [grouped, setGrouped] = React.useState(true);
    const routerPortName = React.useMemo(
        () => new Map((database?.logicalRouterPorts ?? []).map((port) => [port.uuid, port.name])),
        [database],
    );
    const gatewayPortName = React.useCallback((uuid: string) => routerPortName.get(uuid), [routerPortName]);

    return (
        <>
            <TextInput
                aria-label="Filter routes and NAT"
                type="search"
                placeholder={`Filter ${construct.staticRouteRules.length} routes and ${construct.natRules.length} NAT rules`}
                value={query}
                onChange={(_event, value) => onQueryChange(value)}
                className="pf-u-mb-md"
                style={{ maxWidth: '40rem' }}
            />
            <Title headingLevel="h2" size="lg" className="pf-u-mb-sm">
                Static routes ({construct.staticRouteRules.length})
            </Title>
            {construct.staticRouteRules.length === 0 ? (
                <div style={SUBTLE} className="pf-u-mb-lg">No static routes on this router.</div>
            ) : (
                <div className="pf-u-mb-lg">
                    <StaticRouteTable
                        routes={construct.staticRouteRules}
                        routerName={construct.name}
                        database={database}
                        nodeHref={nodeHref}
                        query={query}
                        pageSize={PAGE_ROWS}
                        perPageOptions={PAGE_ROW_CHOICES}
                    />
                </div>
            )}
            <Title headingLevel="h2" size="lg" className="pf-u-mb-sm">
                NAT rules ({construct.natRules.length})
            </Title>
            {construct.natRules.length === 0 ? (
                <div style={SUBTLE} className="pf-u-mb-lg">No NAT rules on this router.</div>
            ) : (
                <div className="pf-u-mb-lg">
                    <NatRuleTable
                        nats={construct.natRules}
                        database={database}
                        gatewayPortName={gatewayPortName}
                        grouped={grouped}
                        query={query}
                        pageSize={PAGE_ROWS}
                        perPageOptions={PAGE_ROW_CHOICES}
                        toolbarItems={
                            <ToolbarItem>
                                <ToggleGroup aria-label="NAT rule view" isCompact>
                                    <ToggleGroupItem
                                        text="Grouped by intent"
                                        buttonId="nat-view-grouped"
                                        isSelected={grouped}
                                        onChange={() => setGrouped(true)}
                                    />
                                    <ToggleGroupItem
                                        text="One row per rule"
                                        buttonId="nat-view-rules"
                                        isSelected={!grouped}
                                        onChange={() => setGrouped(false)}
                                    />
                                </ToggleGroup>
                            </ToolbarItem>
                        }
                    />
                </div>
            )}
            {construct.policyCount > 0 && (
                <div style={SUBTLE} data-testid="router-policies-not-collected">
                    Routing policies: {construct.policyCount} (rows not collected yet)
                </div>
            )}
        </>
    );
};

const PageMessage: React.FC<{ title: string; children?: React.ReactNode; footer?: React.ReactNode }> = ({
    title,
    children,
    footer,
}) => (
    <PageSection>
        <EmptyState>
            <Title headingLevel="h2" size="lg">{title}</Title>
            {children && <EmptyStateBody>{children}</EmptyStateBody>}
            {footer && <EmptyStateFooter>{footer}</EmptyStateFooter>}
        </EmptyState>
    </PageSection>
);

/**
 * The construct detail page (ovn-recon-e2b.8): one logical switch or router
 * from one node's northbound database, full width and tabbed, for the row
 * sets the ladder drawer can only summarise. The URL carries the zone, the
 * construct, the tab, the active tab's filter and one port, so the page can
 * be linked to and reloaded.
 */
const ConstructDetails: React.FC = () => {
    const params = useParams<{ node?: string; kind?: string; name?: string }>();
    const node = params.node ?? '';
    const kindParam = params.kind ?? '';
    const name = params.name ?? '';
    const kind = isDetailKind(kindParam) ? kindParam : undefined;

    const location = useLocation();
    const navigate = useNavigate();
    const search = React.useMemo(() => new URLSearchParams(location.search), [location.search]);
    const tabParam = search.get('tab');
    const requestedTab: ConstructDetailTab = isDetailTab(tabParam) ? tabParam : 'overview';
    const query = search.get('q') ?? '';
    const port = search.get('port') ?? undefined;

    const { enabled, loaded: gateLoaded, loadError: gateError } = useOvnCollectorFeatureGate();
    const [nodeNetworkStates] = useK8sWatchResource<NodeNetworkState[]>({
        groupVersionKind: { group: 'nmstate.io', version: 'v1beta1', kind: 'NodeNetworkState' },
        isList: true,
    });
    const nodeNames = React.useMemo(() => {
        const names = new Set((nodeNetworkStates ?? []).map((nns) => nns.metadata?.name || '').filter(Boolean));
        if (node) names.add(node);
        return [...names].sort((a, b) => a.localeCompare(b));
    }, [nodeNetworkStates, node]);
    const nodeForChassis = useChassisNodeNames();

    // The tab decides the sections; before the construct is known, a tab
    // that fits the kind requests its section straight away.
    const [knownTabs, setKnownTabs] = React.useState<ConstructDetailTab[] | null>(null);
    const sectionTab: ConstructDetailTab = knownTabs
        ? knownTabs.includes(requestedTab)
            ? requestedTab
            : 'overview'
        : kind && tabFitsKind(requestedTab, kind)
            ? requestedTab
            : 'overview';
    const data = useConstructDetailData(
        node,
        sectionTab === 'overview' ? NO_SECTIONS : sectionsForTab(sectionTab),
        gateLoaded && enabled && Boolean(kind),
    );
    const { snapshot } = data;

    const model = React.useMemo(() => (snapshot?.database ? buildLadderModel(snapshot.database) : null), [snapshot]);
    const construct = React.useMemo(
        () => (model && kind ? model.constructs.find((c) => c.kind === kind && c.name === name) ?? null : null),
        [model, kind, name],
    );
    const tabs = React.useMemo(() => (construct ? detailTabsFor(construct) : null), [construct]);
    const tabsKey = tabs?.join(',') ?? '';
    React.useEffect(() => {
        setKnownTabs(tabs);
        // tabsKey stands for tabs, which is rebuilt with every snapshot.
    }, [tabsKey]);
    const activeTab: ConstructDetailTab = tabs && tabs.includes(requestedTab) ? requestedTab : 'overview';

    // A section is wanted once a tab that renders it has been opened; until
    // then its state is 'none', which reads as "not collected yet".
    const sectionStates = useSectionStates(
        construct ?? EMPTY_CONSTRUCT,
        snapshot?.database,
        data.sections,
        {
            services: Boolean(construct && hasLoadBalancerAttachment(construct) && data.requested.includes('services')),
            policy: Boolean(construct && hasPortsTab(construct) && data.requested.includes('policy')),
        },
    );

    const replaceSearch = React.useCallback(
        (updates: Record<string, string | null | undefined>) =>
            navigate(
                { pathname: location.pathname, search: withSearchParams(location.search, updates), hash: location.hash },
                { replace: true },
            ),
        [navigate, location.pathname, location.search, location.hash],
    );

    const selectTab = (next: ConstructDetailTab) =>
        replaceSearch({
            tab: next === 'overview' ? null : next,
            q: null,
            port: next === 'ports' || next === 'policy' ? port : null,
        });

    const nodeHref = React.useCallback((target: string) => nodeLadderPath(target), []);
    const physicalHref = React.useCallback(
        (target: string) => `/ovn-recon/node-network-state/${encodeURIComponent(target)}`,
        [],
    );

    // Findings on this construct (ovn-recon-7i6.3): the node's logical rules over
    // the page's snapshot and the node's pods, plus the section rules over a section
    // the page has loaded for a tab. Findings about the zone as a whole are listed on
    // the node's ladder page, not here.
    const pods = useNodePods(gateLoaded && enabled && kind === 'switch' ? node : undefined);
    const allFindings = useLogicalFindings({ nodeName: node, snapshot, pods });
    const [hideInfo] = useHideInfoFindings();
    const findings = useDrawerFindings(
        { findings: allFindings, hideInfo, construct: construct ?? EMPTY_CONSTRUCT, databaseNode: node },
        sectionStates.policy,
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
            <PageMessage title="Logical OVN view is disabled">
                Enable the <code>ovn-collector</code> feature gate in OvnRecon to access this view.
            </PageMessage>
        );
    }
    if (!kind) {
        return (
            <PageMessage
                title="No detail page for this kind"
                footer={<Link to={nodeLadderPath(node)}>View the logical topology of node {node}</Link>}
            >
                OVN Recon has detail pages for logical switches and routers; <code>{kindParam}</code> is neither.
            </PageMessage>
        );
    }

    const selectValue = { kind, name };
    const ageMs = snapshot?.metadata?.generatedAt ? parseSnapshotAgeMs(snapshot.metadata.generatedAt) : null;
    const networkRef = construct ? networkResourceRef(construct.network) : undefined;

    const onSelectConstruct = (uuid: string) => {
        const peer = model?.constructByUuid.get(uuid);
        if (!peer) return;
        if (isDetailKind(peer.kind)) {
            navigate(constructDetailPath(node, peer.kind, peer.name, { tab: 'relationships' }));
        } else {
            navigate(nodeLadderPath(node, peer));
        }
    };

    const header = (
        <PageSection>
            <Breadcrumb>
                <BreadcrumbItem>
                    <Link to="/ovn-recon">OVN Recon</Link>
                </BreadcrumbItem>
                <BreadcrumbItem>
                    <Link to={clusterLadderPath(selectValue)}>Cluster logical topology</Link>
                </BreadcrumbItem>
                <BreadcrumbItem>
                    <Link to={nodeLadderPath(node, selectValue)}>Logical OVN: {node}</Link>
                </BreadcrumbItem>
                <BreadcrumbItem isActive>{name}</BreadcrumbItem>
            </Breadcrumb>
            <Title headingLevel="h1" className="pf-u-mt-lg">
                {construct ? (
                    <>
                        {roleIcon(construct.role)} {roleLabel(construct.role)}: <code>{name}</code>
                    </>
                ) : (
                    <code>{name}</code>
                )}
            </Title>
            <Flex className="pf-u-mt-md" spaceItems={{ default: 'spaceItemsMd' }} alignItems={{ default: 'alignItemsCenter' }}>
                {construct && (
                    <FlexItem data-testid="detail-network">
                        Network:{' '}
                        {networkRef ? (
                            <Link to={getResourcePath(networkRef)}>{networkDisplayName(construct.network)}</Link>
                        ) : (
                            networkDisplayName(construct.network)
                        )}
                    </FlexItem>
                )}
                <FlexItem>
                    <FormSelect
                        aria-label="Node database"
                        value={node}
                        onChange={(_event, value) => {
                            if (value && value !== node) {
                                navigate(
                                    constructDetailPath(value, kind, constructNameForNode(name, node, value), {
                                        tab: requestedTab,
                                    }),
                                );
                            }
                        }}
                    >
                        {nodeNames.map((nodeName) => (
                            <FormSelectOption key={nodeName} value={nodeName} label={`Node ${nodeName}`} />
                        ))}
                    </FormSelect>
                </FlexItem>
                <FlexItem>
                    <Button variant="tertiary" onClick={data.refresh} isDisabled={data.loading}>
                        Refresh
                    </Button>
                </FlexItem>
                {snapshot && snapshot.database && (
                    <FlexItem align={{ default: 'alignRight' }}>
                        <SnapshotStatusLine
                            freshness={freshnessFromAge(ageMs)}
                            ageMs={ageMs}
                            sourceHealth={snapshot.metadata.sourceHealth}
                            ovn={summarizeOvnZones([snapshot.database.nbGlobal])}
                            isLoading={data.loading || data.sections.loading}
                        />
                    </FlexItem>
                )}
            </Flex>
            {data.error && (
                <Alert variant="warning" isInline className="pf-u-mt-md" title={data.error}>
                    {snapshot ? 'Showing the last loaded snapshot.' : null}
                </Alert>
            )}
            {snapshot && snapshot.warnings.length > 0 && (
                <Alert
                    variant="warning"
                    isInline
                    isExpandable
                    className="pf-u-mt-md"
                    title={`${snapshot.warnings.length} collector warning${snapshot.warnings.length === 1 ? '' : 's'}`}
                >
                    {snapshot.warnings.map((warning) => (
                        <div key={`${warning.code}:${warning.message}`}>
                            {warning.code}: {warning.message}
                        </div>
                    ))}
                </Alert>
            )}
        </PageSection>
    );

    let body: React.ReactNode;
    if (!snapshot) {
        body = data.loading ? (
            <PageSection>
                <Spinner size="lg" aria-label="Loading snapshot" /> Loading the northbound database of node {node}…
            </PageSection>
        ) : null;
    } else if (!snapshot.database || !model) {
        body = (
            <PageMessage title={`Snapshot schema "${snapshot.metadata?.schemaVersion}" is not supported`}>
                This page requires snapshot contract v2. Upgrade the ovn-collector image so snapshots include
                the logical database payload.
            </PageMessage>
        );
    } else if (!construct || !tabs) {
        body = (
            <PageMessage
                title={`No ${TABLE_FOR_KIND[kind]} named ${name}`}
                footer={
                    <Flex spaceItems={{ default: 'spaceItemsMd' }}>
                        <FlexItem>
                            <Link to={nodeLadderPath(node)}>View the logical topology of node {node}</Link>
                        </FlexItem>
                        <FlexItem>
                            <Button variant="link" isInline onClick={() => navigate(-1)}>
                                Back
                            </Button>
                        </FlexItem>
                    </Flex>
                }
            >
                <span data-testid="construct-not-in-zone">
                    The northbound database of node {node} holds no {TABLE_FOR_KIND[kind]} row named{' '}
                    <code>{name}</code>. Under OVN interconnect each node has its own database, and not every
                    construct exists in every zone.
                </span>
            </PageMessage>
        );
    } else {
        const bodyProps: DrawerBodyProps = {
            construct,
            model,
            database: snapshot.database,
            databaseNode: node,
            fallbackNode: node,
            nodeHref,
            physicalHref,
            nodeForChassis,
            onSelectConstruct,
            detailHref: detailHrefFor(node, construct),
            surface: 'page',
            query,
            onQueryChange: (value) => replaceSearch({ q: value }),
            focusPort: port,
            onPortToggle: (portName, expanded) => {
                if (expanded) replaceSearch({ port: portName });
                else if (portName === port) replaceSearch({ port: null });
            },
            services: sectionStates.services,
            policy: sectionStates.policy,
        };
        const sectionError = data.sections.error && sectionsForTab(activeTab).length > 0 ? (
            <Alert variant="warning" isInline className="pf-u-mb-md" title="Section rows failed to load">
                {data.sections.error}
            </Alert>
        ) : null;
        body = (
            <PageSection isFilled>
                {findings && findings.length > 0 && (
                    <div className="pf-u-mb-md" data-testid="construct-findings">
                        <FindingsSection findings={findings} />
                    </div>
                )}
                <Tabs
                    activeKey={activeTab}
                    onSelect={(_event, key) => {
                        if (typeof key === 'string' && isDetailTab(key)) selectTab(key);
                    }}
                    aria-label="Construct detail tabs"
                    mountOnEnter
                    unmountOnExit
                >
                    {tabs.map((tab) => (
                        <Tab key={tab} eventKey={tab} title={<TabTitleText>{TAB_TITLES[tab]}</TabTitleText>} />
                    ))}
                </Tabs>
                <div className="pf-u-mt-md" data-testid={`detail-tab-${activeTab}`}>
                    <LinkOutProvider>
                    {sectionError}
                    {activeTab === 'overview' && <OverviewBody {...bodyProps} />}
                    {activeTab === 'relationships' && <RelationshipsBody {...bodyProps} />}
                    {activeTab === 'ports' && <PortsBody key={construct.uuid} {...bodyProps} />}
                    {activeTab === 'policy' && (
                        <PolicyBody key={construct.uuid} {...bodyProps} onClearPort={() => replaceSearch({ port: null })} />
                    )}
                    {activeTab === 'services' && <ServicesBody key={construct.uuid} {...bodyProps} />}
                    {activeTab === 'routes' && (
                        <RoutesBody
                            construct={construct}
                            database={snapshot.database}
                            nodeHref={nodeHref}
                            query={query}
                            onQueryChange={(value) => replaceSearch({ q: value })}
                        />
                    )}
                    {activeTab === 'config' && <ConfigBody {...bodyProps} />}
                    </LinkOutProvider>
                </div>
            </PageSection>
        );
    }

    return (
        <>
            <DocumentTitle>{`OVN Recon - ${name} (${node})`}</DocumentTitle>
            {header}
            {body}
        </>
    );
};

/** Stands in for the construct while none is loaded; its section states are
 * never shown. */
const EMPTY_CONSTRUCT = {
    uuid: '',
    name: '',
    kind: 'switch',
} as unknown as LadderConstruct;

export default ConstructDetails;
