import * as React from 'react';
import { DocumentTitle } from '@openshift-console/dynamic-plugin-sdk';
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

import { LogicalTopologySnapshot } from '../types';
import { useOvnCollectorFeatureGate } from './useOvnCollectorFeatureGate';
import { buildLadderModel, LadderConstruct, LadderModel } from './logicalLadderModel';
import LogicalLadderView, { networkDisplayName, roleLabel } from './LogicalLadderView';
import { freshnessFromAge, parseSnapshotAgeMs, SnapshotFreshnessState } from './snapshotFreshness';

const REFRESH_INTERVAL_MS = 30000;
const COLLECTOR_SNAPSHOT_PROXY_PREFIXES = [
    '/api/plugins/ovn-recon/api/v1/snapshots',
    '/api/plugins/ovn-recon/backend/api/v1/snapshots',
    '/api/proxy/plugin/ovn-recon/backend/api/v1/snapshots',
    '/api/proxy/plugin/ovn-recon/api/v1/snapshots',
];

const fetchCollectorSnapshot = async (nodeName: string): Promise<LogicalTopologySnapshot> => {
    const encodedNodeName = encodeURIComponent(nodeName);
    const attempts: string[] = [];

    for (const prefix of COLLECTOR_SNAPSHOT_PROXY_PREFIXES) {
        const url = `${prefix}/${encodedNodeName}`;
        try {
            const response = await fetch(url, {
                headers: {
                    Accept: 'application/json',
                },
            });

            if (!response.ok) {
                attempts.push(`${url} -> HTTP ${response.status}`);
                continue;
            }

            const payload = await response.json() as LogicalTopologySnapshot;
            return payload;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            attempts.push(`${url} -> ${message}`);
        }
    }

    throw new Error(`Collector request failed. Attempts: ${attempts.join('; ')}`);
};

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

interface ConstructDrawerProps {
    construct: LadderConstruct;
    model: LadderModel;
}

const ConstructDrawerBody: React.FC<ConstructDrawerProps> = ({ construct, model }) => {
    const connections = model.edges
        .filter((edge) => edge.source === construct.uuid || edge.target === construct.uuid)
        .map((edge) => {
            const otherUuid = edge.source === construct.uuid ? edge.target : edge.source;
            const other = model.constructByUuid.get(otherUuid);
            const addresses = [...edge.networks, ...(edge.peerNetworks ?? [])].join(' ');
            return {
                id: edge.id,
                label: other ? `${roleLabel(other.role)} (${other.name})` : otherUuid,
                addresses,
            };
        });

    return (
        <DescriptionList isCompact>
            <DescriptionListGroup>
                <DescriptionListTerm>Role</DescriptionListTerm>
                <DescriptionListDescription>{roleLabel(construct.role)}</DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
                <DescriptionListTerm>Network</DescriptionListTerm>
                <DescriptionListDescription>
                    {networkDisplayName(construct.network)}
                    {construct.topology ? ` (${construct.topology})` : ''}
                </DescriptionListDescription>
            </DescriptionListGroup>
            {construct.node && (
                <DescriptionListGroup>
                    <DescriptionListTerm>Node</DescriptionListTerm>
                    <DescriptionListDescription>{construct.node}</DescriptionListDescription>
                </DescriptionListGroup>
            )}
            <DescriptionListGroup>
                <DescriptionListTerm>OVN name</DescriptionListTerm>
                <DescriptionListDescription><code>{construct.name}</code></DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
                <DescriptionListTerm>UUID</DescriptionListTerm>
                <DescriptionListDescription><code>{construct.uuid}</code></DescriptionListDescription>
            </DescriptionListGroup>
            {construct.subnet && (
                <DescriptionListGroup>
                    <DescriptionListTerm>Subnet</DescriptionListTerm>
                    <DescriptionListDescription>{construct.subnet}</DescriptionListDescription>
                </DescriptionListGroup>
            )}
            {construct.podPortCount > 0 && (
                <DescriptionListGroup>
                    <DescriptionListTerm>Workload ports</DescriptionListTerm>
                    <DescriptionListDescription>{construct.podPortCount}</DescriptionListDescription>
                </DescriptionListGroup>
            )}
            {construct.managementPort && (
                <DescriptionListGroup>
                    <DescriptionListTerm>Management port</DescriptionListTerm>
                    <DescriptionListDescription><code>{construct.managementPort}</code></DescriptionListDescription>
                </DescriptionListGroup>
            )}
            {construct.remotePeers.length > 0 && (
                <DescriptionListGroup>
                    <DescriptionListTerm>Tunnels to</DescriptionListTerm>
                    <DescriptionListDescription>{construct.remotePeers.join(', ')}</DescriptionListDescription>
                </DescriptionListGroup>
            )}
            {construct.localnetPorts.length > 0 && (
                <DescriptionListGroup>
                    <DescriptionListTerm>Localnet ports</DescriptionListTerm>
                    <DescriptionListDescription>
                        {construct.localnetPorts.map((port) => <div key={port}><code>{port}</code></div>)}
                    </DescriptionListDescription>
                </DescriptionListGroup>
            )}
            {construct.natCount > 0 && (
                <DescriptionListGroup>
                    <DescriptionListTerm>NAT rules</DescriptionListTerm>
                    <DescriptionListDescription>{construct.natCount}</DescriptionListDescription>
                </DescriptionListGroup>
            )}
            {construct.staticRouteCount > 0 && (
                <DescriptionListGroup>
                    <DescriptionListTerm>Static routes</DescriptionListTerm>
                    <DescriptionListDescription>{construct.staticRouteCount}</DescriptionListDescription>
                </DescriptionListGroup>
            )}
            {connections.length > 0 && (
                <DescriptionListGroup>
                    <DescriptionListTerm>Connections</DescriptionListTerm>
                    <DescriptionListDescription>
                        {connections.map((connection) => (
                            <div key={connection.id}>
                                {connection.label}
                                {connection.addresses ? <> — <code>{connection.addresses}</code></> : null}
                            </div>
                        ))}
                    </DescriptionListDescription>
                </DescriptionListGroup>
            )}
        </DescriptionList>
    );
};

interface Point {
    x: number;
    y: number;
}

const NodeLogicalTopologyDetails: React.FC = () => {
    const { name: routeName } = useParams<{ name?: string }>();
    const name = React.useMemo(() => resolveNodeName(routeName), [routeName]);
    const { enabled, loaded: gateLoaded, loadError: gateError } = useOvnCollectorFeatureGate();

    const [snapshot, setSnapshot] = React.useState<LogicalTopologySnapshot | null>(null);
    const [isLoading, setIsLoading] = React.useState<boolean>(false);
    const [snapshotError, setSnapshotError] = React.useState<string>('');
    const [lastLoadedAt, setLastLoadedAt] = React.useState<number>(Date.now());
    const [search, setSearch] = React.useState<string>('');
    const [networkFilter, setNetworkFilter] = React.useState<string>('all');
    const [selectedUuid, setSelectedUuid] = React.useState<string | null>(null);
    const [zoom, setZoom] = React.useState<number>(1);
    const [pan, setPan] = React.useState<Point>({ x: 0, y: 0 });
    const [isDragging, setIsDragging] = React.useState<boolean>(false);
    const [lastPointer, setLastPointer] = React.useState<Point | null>(null);

    const loadSnapshot = React.useCallback(async () => {
        if (!enabled || !name) return;

        setIsLoading(true);
        setSnapshotError('');

        try {
            const payload = await fetchCollectorSnapshot(name);
            setSnapshot(payload);
            setLastLoadedAt(Date.now());
        } catch (error) {
            setSnapshot(null);
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
                    <BreadcrumbItem isActive>Logical OVN: {name}</BreadcrumbItem>
                </Breadcrumb>
                <Title headingLevel="h1" className="pf-u-mt-lg">Logical OVN Topology: {name}</Title>
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
                                                {roleLabel(selectedConstruct.role)}
                                                {selectedConstruct.node ? ` · ${selectedConstruct.node}` : ''}
                                            </Title>
                                            <DrawerActions>
                                                <DrawerCloseButton onClick={() => setSelectedUuid(null)} />
                                            </DrawerActions>
                                        </DrawerHead>
                                        <Card>
                                            <CardBody>
                                                <ConstructDrawerBody construct={selectedConstruct} model={model} />
                                            </CardBody>
                                        </Card>
                                    </>
                                )}
                            </DrawerPanelContent>
                        )}
                    >
                        <Card>
                            <CardTitle>Logical Topology</CardTitle>
                            <CardBody>
                                <AlertGroup isToast={false}>
                                    {isLoading && (
                                        <Alert variant="info" isInline title="Refreshing logical topology snapshot..." />
                                    )}
                                    {snapshotError && (
                                        <Alert variant="warning" isInline title={snapshotError} />
                                    )}
                                    {snapshot && !needsCollectorUpgrade && (
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

                                <Flex className="pf-u-mt-md" spaceItems={{ default: 'spaceItemsMd' }}>
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
                                </Flex>

                                <div
                                    className="pf-u-mt-md"
                                    style={{ height: '680px', border: '1px solid var(--pf-t--global--border--color--default)', overflow: 'hidden', cursor: isDragging ? 'grabbing' : 'grab' }}
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
