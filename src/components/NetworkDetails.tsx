import * as React from 'react';
import { Link, useLocation } from 'react-router';
import {
    Alert,
    Breadcrumb,
    BreadcrumbItem,
    Card,
    CardBody,
    CardTitle,
    EmptyState,
    EmptyStateBody,
    Flex,
    FlexItem,
    Label,
    LabelGroup,
    PageSection,
    Title,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { DocumentTitle, K8sResourceCommon, useK8sModel, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';

import { evaluatePhysical, findingsForNetwork } from '../insights';
import type { ClusterNetworkInputs, Finding } from '../insights';
import { ConsoleLink, LinkOutProvider } from '../linkOut/LinkOut';
import { resourceTarget } from '../linkOut/registry';
import { FactList, ProvenanceLabel } from '../topology/facts';
import {
    ClusterUserDefinedNetwork,
    NetworkAttachmentDefinition,
    NodeNetworkState,
    RouteAdvertisements,
    UserDefinedNetwork,
} from '../types';
import {
    buildPlacement,
    findNetwork,
    listNetworks,
    NETWORKS_PATH,
    networkConditions,
    networkCreationFailure,
    NetworkInputs,
    networkPath,
    NetworkRecord,
    networkSummaryFacts,
    parseNetworkPath,
    Placement,
    PlacementRow,
    PlacementUplink,
    placementSummary,
} from './networkPageModel';
import { useOvnCollectorFeatureGate } from './useOvnCollectorFeatureGate';

/**
 * The network pages (ovn-recon-nfs.1, nfs.2): a list of every CUDN, UDN and NAD-only
 * network at /ovn-recon/networks, and one page per network with its spec summary and
 * a per-node placement matrix. One module serves all four routes and reads which one
 * from the path. Everything shown is worked out in networkPageModel.ts.
 */

const GVK = {
    nns: { group: 'nmstate.io', version: 'v1beta1', kind: 'NodeNetworkState' },
    cudn: { group: 'k8s.ovn.org', version: 'v1', kind: 'ClusterUserDefinedNetwork' },
    udn: { group: 'k8s.ovn.org', version: 'v1', kind: 'UserDefinedNetwork' },
    nad: { group: 'k8s.cni.cncf.io', version: 'v1', kind: 'NetworkAttachmentDefinition' },
    ra: { group: 'k8s.ovn.org', version: 'v1', kind: 'RouteAdvertisements' },
};

type Gvk = (typeof GVK)[keyof typeof GVK];

const EMPTY: unknown[] = [];

const subtle: React.CSSProperties = { color: 'var(--pf-t--global--text--color--subtle)' };

const KIND_LABEL: Record<NetworkRecord['kind'], string> = {
    cudn: 'ClusterUserDefinedNetwork',
    udn: 'UserDefinedNetwork',
    nad: 'NetworkAttachmentDefinition',
};

const KIND_SHORT: Record<NetworkRecord['kind'], string> = { cudn: 'CUDN', udn: 'UDN', nad: 'NAD' };

/** The Summary's term column: wide enough for its longest term on one line. */
const SUMMARY_TERM_WIDTH = '16rem';

export interface Watched<T> {
    data: T[];
    loaded: boolean;
    /** False when the cluster does not serve the kind. */
    available: boolean;
    error?: string;
}

/**
 * A list watch gated on its model: a kind the cluster does not serve (nmstate not
 * installed, an OVN-Kubernetes without UDNs) is not watched at all, and reads as empty
 * and loaded once the model lookup settles.
 */
const useGatedList = <T extends K8sResourceCommon>(gvk: Gvk): Watched<T> => {
    const [model, inFlight] = useK8sModel(gvk);
    const resource = React.useMemo(
        () => (model ? { groupVersionKind: gvk, isList: true } : null),
        [model, gvk],
    );
    const [data, loaded, error] = useK8sWatchResource<T[]>(resource);
    const available = Boolean(model);
    const settled = !inFlight && (!model || loaded || Boolean(error));
    const message = error ? ((error as Error).message || String(error)) : undefined;
    // One object per change, so the memoised findings and placement below are not
    // recomputed on every render.
    return React.useMemo(() => ({
        data: data ?? (EMPTY as T[]),
        loaded: settled,
        available,
        error: message,
    }), [data, settled, available, message]);
};

const StatusConditions: React.FC<{ record: NetworkRecord }> = ({ record }) => {
    const conditions = networkConditions(record);
    if (conditions.length === 0) return null;
    return (
        <Table aria-label="Status conditions" variant="compact" data-testid="network-conditions">
            <Thead>
                <Tr>
                    <Th>Condition</Th>
                    <Th>Status</Th>
                    <Th>Reason</Th>
                    <Th>Message</Th>
                </Tr>
            </Thead>
            <Tbody>
                {conditions.map((condition) => (
                    <Tr key={condition.type}>
                        <Td dataLabel="Condition">{condition.type}</Td>
                        <Td dataLabel="Status">{condition.status}</Td>
                        <Td dataLabel="Reason">{condition.reason ?? ''}</Td>
                        <Td dataLabel="Message">{condition.message ?? ''}</Td>
                    </Tr>
                ))}
            </Tbody>
        </Table>
    );
};

/**
 * A network-scope finding, as the findings engine wrote it. A plain rendering until the
 * shared finding component of ovn-recon-7i6.1 exists.
 */
const NetworkFinding: React.FC<{ finding: Finding }> = ({ finding }) => (
    <Alert
        variant={finding.severity === 'warning' ? 'warning' : 'info'}
        isInline
        title={finding.summary}
        data-testid={`network-finding-${finding.ruleId}`}
        className="pf-v6-u-mb-sm"
    >
        <ul className="pf-v6-c-list">
            {finding.evidence.map((evidence) => (
                <li key={evidence.fact}>
                    {evidence.fact}
                    {evidence.inferred && <ProvenanceLabel provenance="inferred" hint={evidence.inferred} />}
                </li>
            ))}
        </ul>
        <p className="pf-v6-u-mt-sm">{finding.remedy.text}</p>
    </Alert>
);

/**
 * A network OVN-Kubernetes did not create, said first: until NetworkCreated turns True
 * the rest of the page describes a spec, not a network.
 */
const CreationFailure: React.FC<{ record: NetworkRecord }> = ({ record }) => {
    const failure = networkCreationFailure(record);
    if (!failure) return null;
    return (
        <Alert
            variant="danger"
            isInline
            title={`This network was not created${failure.reason ? `: ${failure.reason}` : ''}`}
            data-testid="network-not-created"
            className="pf-v6-u-mb-sm"
        >
            <p>{failure.message || 'The NetworkCreated condition is False and gives no message.'}</p>
        </Alert>
    );
};

const uplinkText = (uplink: PlacementUplink): string =>
    [
        `${uplink.name} (${uplink.type})`,
        uplink.state,
        uplink.mtu ? `MTU ${uplink.mtu}` : undefined,
    ].filter(Boolean).join(', ');

const Uplinks: React.FC<{ uplinks: PlacementUplink[] }> = ({ uplinks }) => {
    if (uplinks.length === 0) return <span style={subtle}>-</span>;
    return (
        <>
            {uplinks.map((uplink) => (
                <div key={uplink.name}>
                    {uplinkText(uplink)}
                    {uplink.lldp && (
                        <div style={subtle}>LLDP: {uplink.lldp.join('; ')}</div>
                    )}
                </div>
            ))}
        </>
    );
};

const StatusCell: React.FC<{ row: PlacementRow }> = ({ row }) => (
    <>
        <Label isCompact color={row.status === 'wired' ? 'green' : 'grey'}>
            {row.status === 'wired' ? 'Wired' : 'Not wired'}
        </Label>
        <div style={subtle}>{row.reason}</div>
    </>
);

const ViewLinks: React.FC<{ row: PlacementRow; showLogical: boolean }> = ({ row, showLogical }) => (
    <>
        <Link to={row.physicalPath}>Physical</Link>
        {showLogical && (
            <>
                {' · '}
                <Link to={row.logicalPath}>Logical</Link>
            </>
        )}
    </>
);

interface Column {
    title: string;
    render: (row: PlacementRow) => React.ReactNode;
}

const placementColumns = (placement: Placement, vlan: string | undefined, showLogical: boolean): Column[] => {
    const node: Column = { title: 'Node', render: (row) => row.node };
    const status: Column = { title: 'Status', render: (row) => <StatusCell row={row} /> };
    const views: Column = { title: 'Views', render: (row) => <ViewLinks row={row} showLogical={showLogical} /> };
    const bridge: Column = {
        title: 'Bridge',
        render: (row) => (row.bridge ? row.bridge.name : <span style={subtle}>-</span>),
    };
    const uplinks: Column = { title: 'Uplinks', render: (row) => <Uplinks uplinks={row.uplinks} /> };
    switch (placement.mode) {
        case 'localnet':
            return [
                node, status, bridge, uplinks,
                { title: 'VLAN', render: () => vlan ?? <span style={subtle}>none</span> },
                views,
            ];
        case 'primary':
            return [
                node, status,
                {
                    title: 'VRF',
                    render: (row) => (row.vrf
                        ? (
                            <>
                                <span title={row.vrf.hint}>{row.vrf.name}</span>
                                {row.vrf.state && <span style={subtle}> ({row.vrf.state})</span>}
                                <ProvenanceLabel provenance={row.vrf.provenance} hint={row.vrf.hint} />
                            </>
                        )
                        : <span style={subtle}>-</span>),
                },
                {
                    title: 'Management port',
                    render: (row) => (row.vrf && row.vrf.managementPorts.length > 0
                        ? (
                            <>
                                {row.vrf.managementPorts.map((port) => port.name).join(', ')}
                                <ProvenanceLabel
                                    provenance="inferred"
                                    hint="The VRF's ports that are also ports of br-int and named ovn-k8s-mp*, in NodeNetworkState."
                                />
                            </>
                        )
                        : <span style={subtle}>-</span>),
                },
                views,
            ];
        case 'bridge':
            return [node, status, bridge, uplinks, views];
        default:
            return [node, views];
    }
};

const noPlacementText = (record: NetworkRecord): string =>
    `This page checks nothing node-local for ${record.clusterDefault
        ? 'the cluster default network'
        : `a ${[record.role, record.topology].filter(Boolean).join(' ')} network`}; `
    + 'the links open each node\'s views.';

const PlacementCard: React.FC<{
    record: NetworkRecord;
    inputs: NetworkInputs;
    nns: Watched<NodeNetworkState>;
    vlan: string | undefined;
    showLogical: boolean;
}> = ({ record, inputs, nns, vlan, showLogical }) => {
    const placement = React.useMemo(
        () => buildPlacement(record, nns.data, inputs),
        [record, nns.data, inputs],
    );
    let body: React.ReactNode;
    if (!nns.available) {
        body = (
            <p data-testid="placement-unavailable">
                This cluster does not serve NodeNetworkState (it comes with the Kubernetes NMState
                Operator), so where this network is wired cannot be shown.
            </p>
        );
    } else if (!nns.loaded) {
        body = <p>Loading NodeNetworkStates...</p>;
    } else if (nns.error) {
        body = <p>Error loading NodeNetworkStates: {nns.error}</p>;
    } else if (placement.rows.length === 0) {
        body = <p data-testid="placement-unavailable">No node reports a NodeNetworkState.</p>;
    } else {
        const columns = placementColumns(placement, vlan, showLogical);
        const summary = placementSummary(placement);
        body = (
            <>
                <p data-testid="placement-summary">
                    {summary ? `${summary}.` : noPlacementText(record)}
                </p>
                <Table aria-label="Placement by node" variant="compact">
                    <Thead>
                        <Tr>{columns.map((column) => <Th key={column.title}>{column.title}</Th>)}</Tr>
                    </Thead>
                    <Tbody>
                        {placement.rows.map((row) => (
                            <Tr key={row.node} data-testid={`placement-${row.node}`}>
                                {columns.map((column) => (
                                    <Td key={column.title} dataLabel={column.title}>{column.render(row)}</Td>
                                ))}
                            </Tr>
                        ))}
                    </Tbody>
                </Table>
            </>
        );
    }
    return (
        <Card data-testid="network-placement">
            <CardTitle>Placement by node</CardTitle>
            <CardBody>{body}</CardBody>
        </Card>
    );
};

const displayName = (record: { name: string; namespace?: string }): string =>
    (record.namespace ? `${record.namespace}/${record.name}` : record.name);

const Breadcrumbs: React.FC<{ current?: string }> = ({ current }) => (
    <Breadcrumb>
        <BreadcrumbItem>
            <Link to="/ovn-recon">OVN Recon</Link>
        </BreadcrumbItem>
        {/* Direct children only: Breadcrumb gives each item after the first its
            separator, and does not look inside a fragment. */}
        {current && <BreadcrumbItem><Link to={NETWORKS_PATH}>Networks</Link></BreadcrumbItem>}
        <BreadcrumbItem isActive>{current ?? 'Networks'}</BreadcrumbItem>
    </Breadcrumb>
);

const NetworkList: React.FC<{
    inputs: NetworkInputs;
    loaded: boolean;
    nns: Watched<NodeNetworkState>;
}> = ({ inputs, loaded, nns }) => {
    const rows = React.useMemo(() => listNetworks(inputs), [inputs]);
    const placements = React.useMemo(
        () => new Map(rows.map((record) => [record, buildPlacement(record, nns.data, inputs)])),
        [rows, nns.data, inputs],
    );
    const showPlacement = nns.available && nns.loaded && !nns.error && nns.data.length > 0;
    const columns = ['Name', 'Kind', 'Namespace', 'Topology', 'Role', 'Physical network or subnets', 'Nodes wired'];
    return (
        <>
            <DocumentTitle>OVN Recon - Networks</DocumentTitle>
            <PageSection>
                <Breadcrumbs />
                <Title headingLevel="h1" className="pf-v6-u-mt-md">Networks</Title>
                <p style={subtle}>
                    Every ClusterUserDefinedNetwork, UserDefinedNetwork, and NetworkAttachmentDefinition that
                    neither of them generated.
                </p>
            </PageSection>
            <PageSection isFilled>
                <Card>
                    <CardBody>
                        <Table aria-label="Networks" variant="compact">
                            <Thead>
                                <Tr>{columns.map((column) => <Th key={column}>{column}</Th>)}</Tr>
                            </Thead>
                            <Tbody>
                                {loaded && rows.map((record) => {
                                    const placement = placements.get(record);
                                    const summary = placement && showPlacement
                                        ? placementSummary(placement)
                                        : undefined;
                                    const carries = record.physicalNetworkName ?? record.bridge
                                        ?? networkSummaryFacts(record, inputs).find((f) => f.label === 'Subnets')?.value;
                                    return (
                                        <Tr key={`${record.kind}/${displayName(record)}`} data-testid={`network-row-${record.kind}-${record.name}`}>
                                            <Td dataLabel="Name">
                                                <Link to={networkPath(record)}>{record.name}</Link>
                                                {networkCreationFailure(record) && (
                                                    <Label
                                                        isCompact
                                                        status="danger"
                                                        style={{ marginInlineStart: 'var(--pf-t--global--spacer--sm)' }}
                                                        data-testid="network-row-not-created"
                                                    >
                                                        Not created
                                                    </Label>
                                                )}
                                            </Td>
                                            <Td dataLabel="Kind">{KIND_SHORT[record.kind]}</Td>
                                            <Td dataLabel="Namespace">{record.namespace ?? ''}</Td>
                                            <Td dataLabel="Topology">{record.topology}</Td>
                                            <Td dataLabel="Role">{record.role ?? ''}</Td>
                                            <Td dataLabel="Physical network or subnets">{typeof carries === 'string' ? carries : ''}</Td>
                                            <Td dataLabel="Nodes wired">
                                                {summary && placement ? `${placement.wired} of ${placement.total}` : '-'}
                                            </Td>
                                        </Tr>
                                    );
                                })}
                                {!loaded && <Tr><Td colSpan={columns.length}>Loading...</Td></Tr>}
                                {loaded && rows.length === 0 && (
                                    <Tr><Td colSpan={columns.length}>No networks found.</Td></Tr>
                                )}
                            </Tbody>
                        </Table>
                    </CardBody>
                </Card>
            </PageSection>
        </>
    );
};

const NotFound: React.FC<{ what: string }> = ({ what }) => (
    <>
        <DocumentTitle>OVN Recon - Networks</DocumentTitle>
        <PageSection>
            <Breadcrumbs current={what} />
            <EmptyState data-testid="network-not-found">
                <Title headingLevel="h4" size="lg">Network not found</Title>
                <EmptyStateBody>
                    No network named {what} is visible. <Link to={NETWORKS_PATH}>See every network</Link>.
                </EmptyStateBody>
            </EmptyState>
        </PageSection>
    </>
);

/** The "Generated by" line of a NAD or UDN that a CUDN or UDN produced. */
const NetworkOwner: React.FC<{ record: NetworkRecord }> = ({ record }) => (record.owner ? (
    <p className="pf-v6-u-mt-sm" data-testid="network-owner">
        Generated by {KIND_LABEL[record.owner.kind]}{' '}
        <Link to={networkPath(record.owner)}>{displayName(record.owner)}</Link>
        {record.owner.inferred && <ProvenanceLabel provenance="inferred" hint={record.owner.inferred} />}
    </p>
) : null);

export interface NetworkBodyProps {
    record: NetworkRecord;
    inputs: NetworkInputs;
    nns: Watched<NodeNetworkState>;
    showLogical: boolean;
}

/**
 * One network's findings, summary and placement by node: everything on a network page
 * below its header. The routed page (NetworkPage) and the console's CUDN, UDN and NAD
 * details tabs (NetworkOvnReconTab, ovn-recon-zdt.1) both render this; there is no
 * second copy.
 */
export const NetworkBody: React.FC<NetworkBodyProps> = ({ record, inputs, nns, showLogical }) => {
    const facts = React.useMemo(() => networkSummaryFacts(record, inputs), [record, inputs]);
    const vlan = facts.find((fact) => fact.label === 'VLAN')?.value;

    // Network-scope findings about this network. NodeNetworkStates are handed over only
    // once loaded: until then localnet-unmapped stays quiet rather than guessing.
    const cluster = React.useMemo<ClusterNetworkInputs>(() => ({
        cudns: inputs.cudns,
        udns: inputs.udns,
        nads: inputs.nads,
        nodeNetworkStates: nns.available && nns.loaded && !nns.error ? nns.data : undefined,
    }), [inputs, nns]);
    const findings = React.useMemo(
        () => findingsForNetwork(evaluatePhysical.network(cluster), record.ref),
        [cluster, record.ref],
    );

    const notCreated = Boolean(networkCreationFailure(record));

    return (
        <>
            {(notCreated || findings.length > 0) && (
                <PageSection>
                    <CreationFailure record={record} />
                    {findings.length > 0 && (
                        <div data-testid="network-findings">
                            {findings.map((finding) => <NetworkFinding key={finding.key} finding={finding} />)}
                        </div>
                    )}
                </PageSection>
            )}
            <PageSection>
                <Card data-testid="network-summary">
                    <CardTitle>Summary</CardTitle>
                    <CardBody>
                        <FactList facts={facts} termWidth={SUMMARY_TERM_WIDTH} />
                        <div className="pf-v6-u-mt-md"><StatusConditions record={record} /></div>
                    </CardBody>
                </Card>
            </PageSection>
            <PageSection isFilled>
                <PlacementCard
                    record={record}
                    inputs={inputs}
                    nns={nns}
                    vlan={typeof vlan === 'string' ? vlan : undefined}
                    showLogical={showLogical}
                />
            </PageSection>
        </>
    );
};

const NetworkPage: React.FC<NetworkBodyProps> = ({ record, inputs, nns, showLogical }) => {
    const name = displayName(record);
    return (
        <>
            <DocumentTitle>{`OVN Recon - ${name}`}</DocumentTitle>
            <PageSection>
                <Breadcrumbs current={name} />
                <Title headingLevel="h1" className="pf-v6-u-mt-md">{name}</Title>
                <Flex className="pf-v6-u-mt-sm" alignItems={{ default: 'alignItemsCenter' }}>
                    <FlexItem>
                        <LabelGroup>
                            <Label isCompact color="blue">{KIND_LABEL[record.kind]}</Label>
                            <Label isCompact>{record.topology}</Label>
                            {record.role && <Label isCompact>{record.role}</Label>}
                        </LabelGroup>
                    </FlexItem>
                    <FlexItem>
                        <ConsoleLink target={resourceTarget(record.resourceRef)} hideWhenAbsent data-testid="network-console-link">
                            View {KIND_SHORT[record.kind]} in the console
                        </ConsoleLink>
                    </FlexItem>
                </Flex>
                <NetworkOwner record={record} />
            </PageSection>
            <NetworkBody record={record} inputs={inputs} nns={nns} showLogical={showLogical} />
        </>
    );
};

/**
 * The tab's header: the link to the full network page, and the owner of a generated
 * network. The host page already shows the name, kind and the console's own fields.
 */
export const NetworkTabHeader: React.FC<{ record: NetworkRecord }> = ({ record }) => (
    <PageSection>
        <Link to={networkPath(record)} data-testid="ovn-recon-tab-network-link">
            Open this network in OVN Recon
        </Link>
        <NetworkOwner record={record} />
    </PageSection>
);

export interface NetworkData {
    inputs: NetworkInputs;
    /** True once every network kind has loaded or is known to be absent. */
    loaded: boolean;
    nns: Watched<NodeNetworkState>;
    showLogical: boolean;
}

/** The watches every network view reads, each gated on the cluster serving its kind. */
export const useNetworkData = (): NetworkData => {
    const { enabled: collectorEnabled, loaded: gateLoaded } = useOvnCollectorFeatureGate();

    const nns = useGatedList<NodeNetworkState>(GVK.nns);
    const cudns = useGatedList<ClusterUserDefinedNetwork>(GVK.cudn);
    const udns = useGatedList<UserDefinedNetwork>(GVK.udn);
    const nads = useGatedList<NetworkAttachmentDefinition>(GVK.nad);
    const ras = useGatedList<RouteAdvertisements>(GVK.ra);

    const inputs = React.useMemo<NetworkInputs>(() => ({
        cudns: cudns.data,
        udns: udns.data,
        nads: nads.data,
        routeAdvertisements: ras.data,
    }), [cudns.data, udns.data, nads.data, ras.data]);
    const loaded = cudns.loaded && udns.loaded && nads.loaded && ras.loaded;
    const showLogical = gateLoaded && collectorEnabled;
    return { inputs, loaded, nns, showLogical };
};

const NetworkPages: React.FC = () => {
    const location = useLocation();
    const target = React.useMemo(() => parseNetworkPath(location.pathname), [location.pathname]);
    const { inputs, loaded, nns, showLogical } = useNetworkData();

    const record = React.useMemo(
        () => (target && !('list' in target) ? findNetwork(target, inputs) : undefined),
        [target, inputs],
    );

    if (target && 'list' in target) {
        return <NetworkList inputs={inputs} loaded={loaded} nns={nns} />;
    }
    if (!target) {
        return <NotFound what={location.pathname.slice(NETWORKS_PATH.length + 1) || 'unknown'} />;
    }
    if (!loaded) {
        return <PageSection><Title headingLevel="h1">Loading...</Title></PageSection>;
    }
    if (!record) {
        return <NotFound what={displayName(target)} />;
    }
    return <NetworkPage record={record} inputs={inputs} nns={nns} showLogical={showLogical} />;
};

/** Reads what the console has loaded once, for every console link on the page. */
const NetworkDetails: React.FC = () => (
    <LinkOutProvider>
        <NetworkPages />
    </LinkOutProvider>
);

export default NetworkDetails;
