import * as React from 'react';
import { Link } from 'react-router';
import {
    Button,
    DescriptionList,
    DescriptionListGroup,
    DescriptionListTerm,
    DescriptionListDescription,
    DrawerPanelBody,
    FormSelect,
    FormSelectOption,
    Label,
    Spinner,
    TextInput,
    Toolbar,
    ToolbarContent,
    ToolbarItem,
} from '@patternfly/react-core';
import { ExpandableRowContent, Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { CodeEditor, Language } from '@patternfly/react-code-editor';

import {
    ACLRow,
    LogicalDatabase,
    LogicalSwitchPortRow,
    NATRow,
    PortGroupRow,
    SnapshotSection,
    StaticRouteRow,
} from '../types';
import { networkResourceRef } from './logicalClassification';
import {
    GatewayPortPlacement,
    LadderConstruct,
    LadderModel,
    LadderPort,
    switchPortTypeLabel,
} from './logicalLadderModel';
import { edgeLabel, networkDisplayName, roleLabel } from './LogicalLadderView';
import { configPayloadFor, ovnKindFor } from './ovnKindRegistry';
import {
    describeOwner,
    networkOfController,
    networkRoleResolverFor,
    NetworkRoleResolver,
    OvnOwner,
    ownerOf,
    ownerText,
} from './ovnOwner';
import {
    hasPolicySection,
    PolicyIndex,
    policyForPort,
    policyIndexFor,
    resolveMatchRefs,
    summarizeSwitchAcls,
    switchAclSummaryText,
    zoneRowFor,
} from './policyIndex';
import {
    attachmentSummaryText,
    hasServicesSection,
    LoadBalancerAttachment,
    loadBalancersFor,
    serviceLabel,
    ServiceVipRow,
    serviceVipRowMatches,
    serviceVipRows,
    summarizeAttachment,
} from './serviceIndex';
import { useIsDarkTheme } from './useIsDarkTheme';
import { useOptionalSections } from './useOptionalSections';
import { getResourcePath } from '../topology/links';
import DrawerTabStrip from './DrawerTabStrip';

const MAX_LISTED_RULES = 10;
const MAX_LISTED_PORTS = 15;
/** Services tab render cap: unlike ports per switch, Services per node are
 * unbounded (hundreds on a lab, thousands on a large cluster). */
export const MAX_SERVICE_ROWS = 200;
/** ACLs listed for one port before a more-note: a pod under many
 * NetworkPolicies collects one ACL per policy rule, protocol and peer block. */
export const MAX_PORT_ACLS = 50;

export interface ConstructDrawerBodyProps {
    construct: LadderConstruct & { zones?: string[] };
    model: LadderModel;
    /** When set, node-bound constructs link to that node's logical view. */
    nodeHref?: (node: string) => string;
    /**
     * When set, seam constructs (external and localnet switches — the points
     * where the logical network meets br-ex / bridge mappings) link across to
     * the node's physical view.
     */
    physicalHref?: (node: string) => string;
    /** Node to use for seam links on constructs without a node of their own
     * (e.g. a Localnet switch viewed from a node's zone). */
    fallbackNode?: string;
    /**
     * Cluster view: how many node databases were merged. Lets the drawer say
     * "All nodes" for cluster-wide constructs instead of enumerating them.
     */
    totalNodes?: number;
    /** Move the ladder selection — makes Relationships entries navigable. */
    onSelectConstruct?: (uuid: string) => void;
    /**
     * One representative node's database, for the Config tab's raw NB rows.
     * Cluster view: the first zone the construct appears in.
     */
    database?: LogicalDatabase | null;
    /** The node `database` came from, shown as the Config tab's caption. */
    databaseNode?: string;
    /**
     * Resolve an SB chassis name (as NB rows carry it: a UUID string) to the
     * node it belongs to, from the Node annotation k8s.ovn.org/node-chassis-id.
     * Unresolved chassis render as their id.
     */
    nodeForChassis?: (chassisName: string) => string | undefined;
    /**
     * Changes when `database` is replaced by a newer collection (the
     * snapshot's generatedAt): the optional sections the drawer loads from
     * `databaseNode` are refetched in step with it.
     */
    sectionsRefreshKey?: string | number;
}

/**
 * The service plane as the drawer sees it for the selected construct:
 * `none` when the construct attaches no load balancer, `loading` while the
 * services section is on its way, `absent` when the collector did not
 * deliver it (an older collector, a failed table, a failed request), and
 * `ready` with the construct's load balancers resolved.
 */
type ServicesState =
    | { status: 'none' }
    | { status: 'loading' }
    | { status: 'absent'; error?: string }
    | { status: 'ready'; attachment: LoadBalancerAttachment; database: LogicalDatabase };

/**
 * The policy plane as the drawer sees it for the selected construct: `none`
 * for anything but a switch (ACLs apply to switch ports), `loading` while the
 * policy section is on its way, `absent` when the collector did not deliver
 * it, and `ready` with the zone's indexes. `switchUuid` is the switch's uuid
 * in that zone's database, undefined when the zone does not hold the switch.
 */
type PolicyState =
    | { status: 'none' }
    | { status: 'loading' }
    | { status: 'absent'; error?: string }
    | { status: 'ready'; index: PolicyIndex; database: LogicalDatabase; switchUuid?: string };

type DrawerBodyProps = ConstructDrawerBodyProps & { services: ServicesState; policy: PolicyState };

const SEAM_ROLES = new Set(['external-switch', 'localnet-switch']);

/** `gatewayPortName` resolves NAT.gateway_port (an LRP uuid) to the port's name. */
export const natRuleText = (nat: NATRow, gatewayPortName?: (uuid: string) => string | undefined): string => {
    const target = nat.logicalPort ? `${nat.logicalIp} (${nat.logicalPort})` : nat.logicalIp ?? '';
    const parts = [`${nat.type} ${nat.externalIp ?? ''} ⇄ ${target}`];
    if (nat.match) parts.push(`match ${nat.match}`);
    if (nat.priority) parts.push(`priority ${nat.priority}`);
    if (nat.gatewayPort) parts.push(`on ${gatewayPortName?.(nat.gatewayPort) ?? nat.gatewayPort}`);
    return parts.join(', ');
};

export const staticRouteText = (route: StaticRouteRow): string => {
    const parts = [`${route.ipPrefix} → ${route.nexthop ?? ''}`];
    if (route.policy) parts.push(`policy ${route.policy}`);
    if (route.outputPort) parts.push(`via ${route.outputPort}`);
    if (route.routeTable) parts.push(`table ${route.routeTable}`);
    if (route.bfd) parts.push('bfd');
    if (route.selectionFields && route.selectionFields.length > 0) {
        parts.push(`ecmp(${route.selectionFields.join(' ')})`);
    }
    return parts.join(', ');
};

/** Short form of a chassis id for display when no Node claims it. */
const shortChassis = (chassisName: string): string =>
    chassisName.length > 12 ? `${chassisName.slice(0, 8)}…` : chassisName;

const ChassisName: React.FC<{
    chassisName: string;
    nodeForChassis?: (chassisName: string) => string | undefined;
    nodeHref?: (node: string) => string;
}> = ({ chassisName, nodeForChassis, nodeHref }) => {
    const node = nodeForChassis?.(chassisName);
    if (!node) {
        return <code title={chassisName}>{shortChassis(chassisName)}</code>;
    }
    return nodeHref ? (
        <Link to={nodeHref(node)} title={chassisName}>{node}</Link>
    ) : (
        <span title={chassisName}>{node}</span>
    );
};

/**
 * Where a distributed gateway port lives: the chassis northd reports as
 * hosting it, and the Gateway_Chassis candidates when there is more than
 * one or the hosting chassis is not the preferred candidate.
 */
const GatewayPortList: React.FC<{
    placements: GatewayPortPlacement[];
    nodeForChassis?: (chassisName: string) => string | undefined;
    nodeHref?: (node: string) => string;
}> = ({ placements, nodeForChassis, nodeHref }) => (
    <>
        {placements.map((placement) => {
            const preferred = placement.candidates[0]?.chassisName;
            const showCandidates =
                placement.candidates.length > 1 ||
                (placement.hostingChassis != null && preferred != null && preferred !== placement.hostingChassis);
            return (
                <div key={placement.port} className="pf-u-mb-xs">
                    <code>{placement.port}</code>{' '}
                    {placement.hostingChassis ? (
                        <>
                            hosted on{' '}
                            <ChassisName
                                chassisName={placement.hostingChassis}
                                nodeForChassis={nodeForChassis}
                                nodeHref={nodeHref}
                            />
                        </>
                    ) : (
                        <Label isCompact color="yellow">Not hosted</Label>
                    )}
                    {showCandidates && (
                        <div style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
                            candidates:{' '}
                            {placement.candidates.map((candidate, index) => (
                                <React.Fragment key={candidate.chassisName}>
                                    {index > 0 ? ', ' : ''}
                                    <ChassisName
                                        chassisName={candidate.chassisName}
                                        nodeForChassis={nodeForChassis}
                                        nodeHref={nodeHref}
                                    />
                                    {` (priority ${candidate.priority})`}
                                </React.Fragment>
                            ))}
                        </div>
                    )}
                </div>
            );
        })}
    </>
);

const NOT_COLLECTED = 'rows not collected yet';

/** "22 direct · 2 groups" for load balancer references on a router or switch. */
const loadBalancerSummary = (direct: number, groups: number): string => {
    const parts: string[] = [];
    if (direct > 0) parts.push(`${direct} direct`);
    if (groups > 0) parts.push(`${groups} group${groups === 1 ? '' : 's'}`);
    return parts.join(' · ');
};

const RuleList: React.FC<{ items: string[] }> = ({ items }) => {
    const shown = items.slice(0, MAX_LISTED_RULES);
    return (
        <>
            {shown.map((item, index) => <div key={`${index}:${item}`}><code>{item}</code></div>)}
            {items.length > shown.length && (
                <div>… and {items.length - shown.length} more</div>
            )}
        </>
    );
};

const WorkloadPortList: React.FC<{ construct: LadderConstruct }> = ({ construct }) => {
    const [filter, setFilter] = React.useState('');
    const query = filter.trim().toLowerCase();
    const matches = query === ''
        ? construct.podPorts
        : construct.podPorts.filter((port) => port.name.toLowerCase().includes(query));
    const shown = matches.slice(0, MAX_LISTED_PORTS);

    return (
        <>
            {construct.podPorts.length > MAX_LISTED_PORTS && (
                <TextInput
                    aria-label="Filter workload ports"
                    type="search"
                    placeholder={`Filter ${construct.podPorts.length} ports`}
                    value={filter}
                    onChange={(_event, value) => setFilter(value)}
                    className="pf-u-mb-sm"
                />
            )}
            {shown.map((port) => (
                <div key={port.name}>
                    {port.namespace && port.pod ? (
                        <Link
                            to={getResourcePath({
                                apiVersion: 'v1',
                                kind: 'Pod',
                                namespace: port.namespace,
                                name: port.pod,
                            })}
                        >
                            {port.namespace}/{port.pod}
                        </Link>
                    ) : (
                        <code>{port.name}</code>
                    )}
                </div>
            ))}
            {matches.length > shown.length && (
                <div>… and {matches.length - shown.length} more match</div>
            )}
            {matches.length === 0 && <div>No ports match.</div>}
        </>
    );
};

const SUBTLE_TEXT: React.CSSProperties = { color: 'var(--pf-t--global--text--color--subtle)' };

/**
 * The Overview's "Load balancers" value. With the services section at hand
 * the references resolve to direct and per-group counts, plus the VIPs whose
 * Service has no endpoints; without it the bare reference counts remain.
 */
const LoadBalancerOverview: React.FC<{ construct: LadderConstruct; services: ServicesState }> = ({
    construct,
    services,
}) => {
    if (services.status !== 'ready') {
        return (
            <>
                {loadBalancerSummary(construct.loadBalancerCount, construct.loadBalancerGroupCount)}{' '}
                <span style={SUBTLE_TEXT} title={services.status === 'absent' ? services.error : undefined}>
                    ({services.status === 'loading' ? 'loading…' : NOT_COLLECTED})
                </span>
            </>
        );
    }
    const summary = summarizeAttachment(services.attachment);
    return (
        <>
            <div>{attachmentSummaryText(summary)}</div>
            {summary.vipsWithoutEndpoints > 0 && (
                <div style={SUBTLE_TEXT}>
                    {summary.vipsWithoutEndpoints} VIP{summary.vipsWithoutEndpoints === 1 ? '' : 's'} without endpoints
                </div>
            )}
        </>
    );
};

/**
 * The Overview's "ACLs" value on a switch. With the policy section at hand:
 * the ACLs set on the switch itself and the ones that reach its ports through
 * port groups. Without it the bare reference count of the switch's own acls
 * column remains, with a spinner while the section loads and the error when
 * the request failed.
 */
const AclOverview: React.FC<{ construct: LadderConstruct; policy: PolicyState }> = ({ construct, policy }) => {
    // Ready without a switchUuid: the zone at hand does not hold this switch,
    // so only the reference count is known.
    if (policy.status === 'ready' && policy.switchUuid) {
        const summary = summarizeSwitchAcls(policy.index.aclsBySwitch.get(policy.switchUuid));
        return <>{switchAclSummaryText(summary)}</>;
    }
    return (
        <>
            {construct.aclCount}{' '}
            <span style={SUBTLE_TEXT}>({NOT_COLLECTED})</span>
            {policy.status === 'loading' && <> <Spinner size="sm" aria-label="Loading ACLs" /></>}
            {policy.status === 'absent' && policy.error && (
                <div style={SUBTLE_TEXT} data-testid="policy-error">Policy rows failed to load: {policy.error}</div>
            )}
        </>
    );
};

/** Whether the Overview shows an ACLs line: the switch has ACLs of its own,
 * or its ports collect some through port groups. */
const hasAclLine = (construct: LadderConstruct, policy: PolicyState): boolean => {
    if (construct.aclCount > 0) return true;
    if (policy.status !== 'ready' || !policy.switchUuid) return false;
    return (policy.index.aclsBySwitch.get(policy.switchUuid)?.all.length ?? 0) > 0;
};

const OverviewBody: React.FC<DrawerBodyProps> = ({
    construct,
    nodeHref,
    physicalHref,
    fallbackNode,
    totalNodes,
    database,
    nodeForChassis,
    services,
    policy,
}) => {
    const networkRef = networkResourceRef(construct.network);
    const seamNode = SEAM_ROLES.has(construct.role) ? construct.node ?? fallbackNode : undefined;
    const routerPortNameByUuid = React.useMemo(
        () => new Map((database?.logicalRouterPorts ?? []).map((port) => [port.uuid, port.name])),
        [database],
    );
    const gatewayPortName = (uuid: string) => routerPortNameByUuid.get(uuid);
    const hasLoadBalancers = construct.loadBalancerCount > 0 || construct.loadBalancerGroupCount > 0;

    return (
        <DescriptionList isCompact>
            <DescriptionListGroup>
                <DescriptionListTerm>Role</DescriptionListTerm>
                <DescriptionListDescription>{roleLabel(construct.role)}</DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
                <DescriptionListTerm>Network</DescriptionListTerm>
                <DescriptionListDescription>
                    {networkRef ? (
                        <Link to={getResourcePath(networkRef)}>{networkDisplayName(construct.network)}</Link>
                    ) : (
                        networkDisplayName(construct.network)
                    )}
                    {construct.topology ? ` (${construct.topology})` : ''}
                </DescriptionListDescription>
            </DescriptionListGroup>
            {construct.node && (
                <DescriptionListGroup>
                    <DescriptionListTerm>Node</DescriptionListTerm>
                    <DescriptionListDescription>
                        {nodeHref
                            ? <Link to={nodeHref(construct.node)}>{construct.node}</Link>
                            : construct.node}
                    </DescriptionListDescription>
                </DescriptionListGroup>
            )}
            {physicalHref && seamNode && (
                <DescriptionListGroup>
                    <DescriptionListTerm>Physical topology</DescriptionListTerm>
                    <DescriptionListDescription>
                        <Link to={physicalHref(seamNode)}>
                            {construct.role === 'localnet-switch'
                                ? `Bridge mapping on ${seamNode}`
                                : `br-ex on ${seamNode}`}
                        </Link>
                    </DescriptionListDescription>
                </DescriptionListGroup>
            )}
            {construct.zones && construct.zones.length > 0 && (totalNodes ?? 0) > 1 && (
                <DescriptionListGroup>
                    <DescriptionListTerm>Present on nodes</DescriptionListTerm>
                    <DescriptionListDescription>
                        {construct.zones.length === totalNodes
                            ? `All nodes (${totalNodes})`
                            : [...construct.zones].sort().join(', ')}
                    </DescriptionListDescription>
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
            {construct.enabled !== undefined && (
                <DescriptionListGroup>
                    <DescriptionListTerm>Admin state</DescriptionListTerm>
                    <DescriptionListDescription>
                        {construct.enabled
                            ? <Label isCompact color="green">Enabled</Label>
                            : <Label isCompact color="red">Disabled</Label>}
                    </DescriptionListDescription>
                </DescriptionListGroup>
            )}
            {construct.gatewayPorts.length > 0 && (
                <DescriptionListGroup>
                    <DescriptionListTerm>Gateway ports</DescriptionListTerm>
                    <DescriptionListDescription>
                        <GatewayPortList
                            placements={construct.gatewayPorts}
                            nodeForChassis={nodeForChassis}
                            nodeHref={nodeHref}
                        />
                    </DescriptionListDescription>
                </DescriptionListGroup>
            )}
            {construct.bridge && (
                <DescriptionListGroup>
                    <DescriptionListTerm>OVS bridge</DescriptionListTerm>
                    <DescriptionListDescription><code>{construct.bridge}</code></DescriptionListDescription>
                </DescriptionListGroup>
            )}
            {construct.subnet && (
                <DescriptionListGroup>
                    <DescriptionListTerm>Subnet</DescriptionListTerm>
                    <DescriptionListDescription>{construct.subnet}</DescriptionListDescription>
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
            {construct.podPortCount > 0 && (
                <DescriptionListGroup>
                    <DescriptionListTerm>Workload ports ({construct.podPortCount})</DescriptionListTerm>
                    <DescriptionListDescription>
                        <WorkloadPortList construct={construct} />
                    </DescriptionListDescription>
                </DescriptionListGroup>
            )}
            {construct.natRules.length > 0 && (
                <DescriptionListGroup>
                    <DescriptionListTerm>NAT rules ({construct.natRules.length})</DescriptionListTerm>
                    <DescriptionListDescription>
                        <RuleList items={construct.natRules.map((nat) => natRuleText(nat, gatewayPortName))} />
                    </DescriptionListDescription>
                </DescriptionListGroup>
            )}
            {construct.staticRouteRules.length > 0 && (
                <DescriptionListGroup>
                    <DescriptionListTerm>Static routes ({construct.staticRouteRules.length})</DescriptionListTerm>
                    <DescriptionListDescription>
                        <RuleList items={construct.staticRouteRules.map(staticRouteText)} />
                    </DescriptionListDescription>
                </DescriptionListGroup>
            )}
            {construct.policyCount > 0 && (
                <DescriptionListGroup>
                    <DescriptionListTerm>Routing policies</DescriptionListTerm>
                    <DescriptionListDescription>
                        {construct.policyCount}{' '}
                        <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>({NOT_COLLECTED})</span>
                    </DescriptionListDescription>
                </DescriptionListGroup>
            )}
            {hasAclLine(construct, policy) && (
                <DescriptionListGroup>
                    <DescriptionListTerm>ACLs</DescriptionListTerm>
                    <DescriptionListDescription>
                        <AclOverview construct={construct} policy={policy} />
                    </DescriptionListDescription>
                </DescriptionListGroup>
            )}
            {hasLoadBalancers && (
                <DescriptionListGroup>
                    <DescriptionListTerm>Load balancers</DescriptionListTerm>
                    <DescriptionListDescription>
                        <LoadBalancerOverview construct={construct} services={services} />
                    </DescriptionListDescription>
                </DescriptionListGroup>
            )}
            {construct.qosRuleCount > 0 && (
                <DescriptionListGroup>
                    <DescriptionListTerm>QoS rules</DescriptionListTerm>
                    <DescriptionListDescription>
                        {construct.qosRuleCount}{' '}
                        <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>({NOT_COLLECTED})</span>
                    </DescriptionListDescription>
                </DescriptionListGroup>
            )}
        </DescriptionList>
    );
};

const EDGE_ROLE_TITLES: Record<string, string> = {
    join: 'Join',
    external: 'External',
    gateway: 'Gateway',
    tunnel: 'Tunnel',
    interconnect: 'Interconnect',
    localnet: 'Localnet',
    link: 'Link',
};

/**
 * The construct's connections as navigation, mirroring the physical drawer's
 * Relationships tab: each peer is a link that moves the ladder selection,
 * annotated with the edge's role and addresses.
 */
const RelationshipsBody: React.FC<ConstructDrawerBodyProps> = ({ construct, model, onSelectConstruct }) => {
    const connections = model.edges
        .filter((edge) => edge.source === construct.uuid || edge.target === construct.uuid)
        .map((edge) => {
            const otherUuid = edge.source === construct.uuid ? edge.target : edge.source;
            const other = model.constructByUuid.get(otherUuid);
            return {
                id: edge.id,
                otherUuid,
                label: other ? `${roleLabel(other.role)} (${other.name})` : otherUuid,
                role: EDGE_ROLE_TITLES[edge.role] ?? edge.role,
                addresses: edgeLabel(edge),
                navigable: Boolean(other),
            };
        });

    if (connections.length === 0) {
        return <div>No connections recorded for this construct.</div>;
    }
    return (
        <ul className="pf-v6-c-list" style={{ listStyle: 'none', paddingLeft: 0 }}>
            {connections.map((connection) => (
                <li key={connection.id} className="pf-u-mb-sm">
                    {connection.navigable && onSelectConstruct ? (
                        <Button
                            variant="link"
                            isInline
                            onClick={() => onSelectConstruct(connection.otherUuid)}
                        >
                            {connection.label}
                        </Button>
                    ) : (
                        connection.label
                    )}
                    <div style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
                        {connection.role}
                        {connection.addresses ? <> — <code>{connection.addresses}</code></> : null}
                    </div>
                </li>
            ))}
        </ul>
    );
};

/**
 * The construct's raw northbound rows, assembled by the OVN kind registry —
 * the logical equivalent of the physical drawer's Config (YAML) tab. When no
 * database is at hand the model's own view of the construct is shown instead,
 * labeled as derived.
 */
const ConfigBody: React.FC<DrawerBodyProps> = ({ construct, database, databaseNode, services, policy }) => {
    const isDarkTheme = useIsDarkTheme();
    // The same node's database with the optional sections, once they have
    // arrived, so the raw rows include the load balancer and ACL rows the
    // construct references.
    const configDatabase =
        services.status === 'ready'
            ? services.database
            : policy.status === 'ready'
                ? policy.database
                : database ?? null;
    const { source, payload } = configPayloadFor(construct, configDatabase);
    const caption =
        source === 'nb-rows'
            ? `${ovnKindFor(construct).table} rows${databaseNode ? ` from node ${databaseNode}` : ''}`
            : 'As modeled by OVN Recon (raw rows unavailable)';
    return (
        <>
            <div className="pf-u-mb-sm" style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
                {caption}
            </div>
            <CodeEditor
                isDarkTheme={isDarkTheme}
                isReadOnly
                isDownloadEnabled
                code={JSON.stringify(payload, null, 2)}
                language={Language.json}
                height="400px"
            />
        </>
    );
};

const ALL_PORT_TYPES = 'all';

const ACTION_COLORS: Record<string, 'green' | 'red' | 'grey'> = {
    allow: 'green',
    'allow-related': 'green',
    'allow-stateless': 'green',
    drop: 'red',
    reject: 'red',
};

const DIRECTION_HINTS: Record<string, string> = {
    'from-lport': 'Traffic leaving the port (egress from the workload)',
    'to-lport': 'Traffic towards the port (ingress to the workload)',
};

/** The network a row's controller serves, linked to its UDN/CUDN when it has one. */
const OwnerNetwork: React.FC<{ owner?: OvnOwner }> = ({ owner }) => {
    const network = networkOfController(owner?.controller);
    if (network === undefined) {
        return owner?.controller ? <code>{owner.controller}</code> : <span style={SUBTLE_TEXT}>—</span>;
    }
    const ref = networkResourceRef(network);
    return ref ? (
        <Link to={getResourcePath(ref)}>{networkDisplayName(network)}</Link>
    ) : (
        <>{networkDisplayName(network)}</>
    );
};

/**
 * The owner of a port group or ACL: its name as a link when it stands for a
 * Kubernetes object, as text otherwise. A NetworkPolicy-typed owner on a
 * network whose role is unknown in this zone is named without a link, since
 * it may be a MultiNetworkPolicy.
 */
const OwnerName: React.FC<{ owner?: OvnOwner; roleOf: NetworkRoleResolver }> = ({ owner, roleOf }) => {
    const description = describeOwner(owner, roleOf);
    if (!description.name) return <span style={SUBTLE_TEXT}>—</span>;
    if (description.target) return <Link to={description.target.path}>{description.name}</Link>;
    return (
        <span title={description.kindUnresolved ? 'NetworkPolicy or MultiNetworkPolicy: the network role is unknown in this zone' : undefined}>
            {description.name}
        </span>
    );
};

/** The per-type external_ids worth a glance next to an owner: the policy
 * direction and the rule kind (defaultDeny, arpAllow, AllowInterNode, ...). */
const ownerQualifiers = (owner?: OvnOwner): string =>
    [owner?.extra.direction, owner?.extra.type].filter(Boolean).join(' · ');

/** What an `@name` or `$name` in a match stands for, one line per reference. */
const MatchReferences: React.FC<{ acl: ACLRow; index: PolicyIndex; roleOf: NetworkRoleResolver }> = ({
    acl,
    index,
    roleOf,
}) => {
    const refs = resolveMatchRefs(index, acl);
    if (refs.portGroups.length === 0 && refs.addressSets.length === 0) return null;
    const label = (row: { externalIds?: Record<string, string> }) =>
        ownerText(describeOwner(ownerOf(row.externalIds), roleOf));
    return (
        <div style={SUBTLE_TEXT}>
            {refs.portGroups.map((ref) => (
                <div key={`@${ref.name}`}>
                    <code>@{ref.name}</code> {ref.row ? label(ref.row) : 'unresolved port group'}
                </div>
            ))}
            {refs.addressSets.map((ref) => (
                <div key={`$${ref.name}`}>
                    <code>${ref.name}</code>{' '}
                    {ref.row
                        ? `${label(ref.row)} (${ref.row.addresses.length} address${ref.row.addresses.length === 1 ? '' : 'es'})`
                        : 'unresolved address set'}
                </div>
            ))}
        </div>
    );
};

const PortGroupTable: React.FC<{ groups: PortGroupRow[]; index: PolicyIndex; roleOf: NetworkRoleResolver }> = ({
    groups,
    index,
    roleOf,
}) => (
    <Table aria-label="Port groups" variant="compact" borders={false}>
        <Thead>
            <Tr>
                <Th>Owner type</Th>
                <Th>Owner</Th>
                <Th>Network</Th>
                <Th>ACLs</Th>
            </Tr>
        </Thead>
        <Tbody>
            {groups.map((group) => {
                const owner = ownerOf(group.externalIds);
                const qualifiers = ownerQualifiers(owner);
                return (
                    <Tr key={group.uuid} data-testid={`port-group-${group.uuid}`}>
                        <Td dataLabel="Owner type">{describeOwner(owner, roleOf).kind}</Td>
                        <Td dataLabel="Owner">
                            <span title={`@${group.name}`}><OwnerName owner={owner} roleOf={roleOf} /></span>
                            {qualifiers && <span style={SUBTLE_TEXT}> ({qualifiers})</span>}
                        </Td>
                        <Td dataLabel="Network"><OwnerNetwork owner={owner} /></Td>
                        <Td dataLabel="ACLs">{index.aclsByPortGroup.get(group.uuid)?.length ?? 0}</Td>
                    </Tr>
                );
            })}
        </Tbody>
    </Table>
);

/**
 * The policy on one port, in the Ports tab's expanded row: the port groups it
 * is a member of and the ACLs that apply to it (those of its groups plus the
 * ones set on the switch), in evaluation order per direction. Bounded by the
 * port, not by the cluster; the full tables belong to the construct detail
 * page.
 */
const PortPolicy: React.FC<{ port: LadderPort; policy: PolicyState; databaseNode?: string }> = ({
    port,
    policy,
    databaseNode,
}) => {
    if (policy.status === 'none') return null;
    if (policy.status !== 'ready') {
        return (
            <div className="pf-u-mt-sm" data-testid="port-policy">
                <strong>Port groups:</strong>{' '}
                <span style={SUBTLE_TEXT}>not collected yet</span>
                {policy.status === 'loading' && <> <Spinner size="sm" aria-label="Loading port groups" /></>}
                {policy.status === 'absent' && policy.error && (
                    <div style={SUBTLE_TEXT}>Policy rows failed to load: {policy.error}</div>
                )}
            </div>
        );
    }

    const { index, database } = policy;
    const zonePort = zoneRowFor(database.logicalSwitchPorts, port);
    if (!zonePort) {
        // Cluster view: the port lives in another node's zone, and a zone's
        // port groups list only its own ports.
        return (
            <div className="pf-u-mt-sm" data-testid="port-policy">
                <strong>Port groups:</strong>{' '}
                <span style={SUBTLE_TEXT}>
                    this port is not in {databaseNode ? `node ${databaseNode}'s` : 'this'} zone; open its
                    node's view to see its port groups and ACLs
                </span>
            </div>
        );
    }

    const roleOf = networkRoleResolverFor(database);
    const { groups, acls } = policyForPort(index, zonePort.uuid);
    const shown = acls.slice(0, MAX_PORT_ACLS);
    const showTier = new Set(acls.map((applied) => applied.acl.tier)).size > 1;

    return (
        <div className="pf-u-mt-sm" data-testid="port-policy">
            <div><strong>Port groups ({groups.length})</strong></div>
            {groups.length === 0 ? (
                <div style={SUBTLE_TEXT}>This port is in no port group.</div>
            ) : (
                <PortGroupTable groups={groups} index={index} roleOf={roleOf} />
            )}
            <div className="pf-u-mt-sm"><strong>ACLs that apply ({acls.length})</strong></div>
            {acls.length === 0 ? (
                <div style={SUBTLE_TEXT}>No ACL applies to this port.</div>
            ) : (
                <Table aria-label="ACLs that apply to the port" variant="compact" borders={false}>
                    <Thead>
                        <Tr>
                            <Th>Priority</Th>
                            <Th>Direction</Th>
                            <Th>Action</Th>
                            <Th>Owner</Th>
                            <Th>Match</Th>
                        </Tr>
                    </Thead>
                    <Tbody>
                        {shown.map(({ acl, group }) => {
                            const owner = ownerOf(acl.externalIds);
                            const description = describeOwner(owner, roleOf);
                            const qualifiers = ownerQualifiers(owner);
                            return (
                                <Tr key={acl.uuid} data-testid={`port-acl-${acl.uuid}`}>
                                    <Td dataLabel="Priority">
                                        {acl.priority}
                                        {showTier && <div style={SUBTLE_TEXT}>tier {acl.tier}</div>}
                                    </Td>
                                    <Td dataLabel="Direction">
                                        <span title={DIRECTION_HINTS[acl.direction]}>{acl.direction}</span>
                                    </Td>
                                    <Td dataLabel="Action">
                                        <Label isCompact color={ACTION_COLORS[acl.action] ?? 'grey'}>{acl.action}</Label>
                                    </Td>
                                    <Td dataLabel="Owner">
                                        <span title={acl.name}>
                                            {description.kind} <OwnerName owner={owner} roleOf={roleOf} />
                                        </span>
                                        {qualifiers && <div style={SUBTLE_TEXT}>{qualifiers}</div>}
                                        {!group && <div style={SUBTLE_TEXT}>set on the switch</div>}
                                    </Td>
                                    <Td dataLabel="Match">
                                        <code style={{ overflowWrap: 'anywhere' }}>{acl.match}</code>
                                        <MatchReferences acl={acl} index={index} roleOf={roleOf} />
                                    </Td>
                                </Tr>
                            );
                        })}
                    </Tbody>
                </Table>
            )}
            {acls.length > shown.length && (
                <div data-testid="port-acl-cap">… and {acls.length - shown.length} more</div>
            )}
        </div>
    );
};

/** One `<code>` entry per line, or a dash when the set is empty. */
const CodeLines: React.FC<{ items?: string[] }> = ({ items }) =>
    items && items.length > 0 ? (
        <>
            {items.map((item, index) => <div key={`${index}:${item}`}><code>{item}</code></div>)}
        </>
    ) : (
        <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>—</span>
    );

const PortName: React.FC<{ port: LadderPort }> = ({ port }) =>
    port.namespace && port.pod ? (
        <Link
            to={getResourcePath({ apiVersion: 'v1', kind: 'Pod', namespace: port.namespace, name: port.pod })}
            title={port.name}
        >
            {port.namespace}/{port.pod}
        </Link>
    ) : (
        <code>{port.name}</code>
    );

/** northd's binding state plus an explicit administrative disable. */
const PortState: React.FC<{ row: LogicalSwitchPortRow }> = ({ row }) => (
    <>
        {row.up === true && <Label isCompact color="green">Up</Label>}
        {row.up === false && <Label isCompact color="grey">Down</Label>}
        {row.up === undefined && <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>—</span>}
        {row.enabled === false && <> <Label isCompact color="red">Disabled</Label></>}
    </>
);

const portMatches = (port: LadderPort, query: string): boolean => {
    if (port.name.toLowerCase().includes(query)) return true;
    if (port.namespace && port.pod && `${port.namespace}/${port.pod}`.toLowerCase().includes(query)) return true;
    return (port.row.addresses ?? []).some((address) => address.toLowerCase().includes(query));
};

/**
 * Every Logical_Switch_Port on a switch as a filterable table, each row
 * expandable to the port's raw NB row. Ports stay in the drawer: they are
 * not ladder constructs and do not move the ladder selection (e2b.4 decision
 * 3). Keyed by construct uuid from the parent so expansion and filters reset
 * when a different construct is selected.
 */
const PortsBody: React.FC<DrawerBodyProps> = ({
    construct,
    database,
    databaseNode,
    nodeForChassis,
    nodeHref,
    policy,
}) => {
    const isDarkTheme = useIsDarkTheme();
    const [filter, setFilter] = React.useState('');
    const [typeFilter, setTypeFilter] = React.useState(ALL_PORT_TYPES);
    const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set());

    const typeCounts = React.useMemo(() => {
        const counts = new Map<string, number>();
        for (const port of construct.ports) {
            const type = switchPortTypeLabel(port.row);
            counts.set(type, (counts.get(type) ?? 0) + 1);
        }
        return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
    }, [construct.ports]);

    // Raw rows come from the representative node's database (cluster view:
    // the first zone the construct appears in, the Config tab's rule), falling
    // back to the row the model carried for ports that zone does not hold.
    const rawRowFor = React.useMemo(() => {
        const byUuid = new Map((database?.logicalSwitchPorts ?? []).map((row) => [row.uuid, row]));
        const byName = new Map((database?.logicalSwitchPorts ?? []).map((row) => [row.name, row]));
        return (port: LadderPort): LogicalSwitchPortRow =>
            byUuid.get(port.uuid) ?? byName.get(port.name) ?? port.row;
    }, [database]);

    const query = filter.trim().toLowerCase();
    const rows = construct.ports.filter(
        (port) =>
            (typeFilter === ALL_PORT_TYPES || switchPortTypeLabel(port.row) === typeFilter) &&
            (query === '' || portMatches(port, query)),
    );

    const toggle = (uuid: string) =>
        setExpanded((current) => {
            const next = new Set(current);
            if (next.has(uuid)) next.delete(uuid);
            else next.add(uuid);
            return next;
        });

    const columns = ['Name', 'Type', 'Addresses', 'Port security', 'Up', 'Requested chassis'];

    return (
        <>
            <Toolbar inset={{ default: 'insetNone' }} className="pf-u-pb-sm">
                <ToolbarContent>
                    <ToolbarItem>
                        <TextInput
                            aria-label="Filter ports"
                            type="search"
                            placeholder={`Filter ${construct.ports.length} ports`}
                            value={filter}
                            onChange={(_event, value) => setFilter(value)}
                        />
                    </ToolbarItem>
                    <ToolbarItem>
                        <FormSelect
                            aria-label="Filter by port type"
                            value={typeFilter}
                            onChange={(_event, value) => setTypeFilter(value)}
                        >
                            <FormSelectOption value={ALL_PORT_TYPES} label={`All types (${construct.ports.length})`} />
                            {typeCounts.map(([type, count]) => (
                                <FormSelectOption key={type} value={type} label={`${type} (${count})`} />
                            ))}
                        </FormSelect>
                    </ToolbarItem>
                </ToolbarContent>
            </Toolbar>
            {databaseNode && (
                <div className="pf-u-mb-sm" style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
                    Logical_Switch_Port rows from node {databaseNode}
                </div>
            )}
            <Table aria-label="Switch ports" variant="compact" isExpandable>
                <Thead>
                    <Tr>
                        <Th screenReaderText="Row expansion" />
                        {columns.map((column) => <Th key={column}>{column}</Th>)}
                    </Tr>
                </Thead>
                {rows.map((port, rowIndex) => {
                    const isExpanded = expanded.has(port.uuid);
                    const row = port.row;
                    const requestedChassis = row.options?.['requested-chassis'];
                    const rawRow = rawRowFor(port);
                    const rawJson = JSON.stringify(rawRow, null, 2);
                    const editorHeight = `${Math.min(400, 24 + rawJson.split('\n').length * 19)}px`;
                    return (
                        <Tbody key={port.uuid} isExpanded={isExpanded}>
                            <Tr data-testid={`port-row-${port.uuid}`}>
                                <Td
                                    expand={{
                                        rowIndex,
                                        isExpanded,
                                        onToggle: () => toggle(port.uuid),
                                        expandId: `port-${port.uuid}`,
                                    }}
                                />
                                <Td dataLabel="Name"><PortName port={port} /></Td>
                                <Td dataLabel="Type">{switchPortTypeLabel(row)}</Td>
                                <Td dataLabel="Addresses"><CodeLines items={row.addresses} /></Td>
                                <Td dataLabel="Port security"><CodeLines items={row.portSecurity} /></Td>
                                <Td dataLabel="Up"><PortState row={row} /></Td>
                                <Td dataLabel="Requested chassis">
                                    {requestedChassis ? (
                                        <ChassisName
                                            chassisName={requestedChassis}
                                            nodeForChassis={nodeForChassis}
                                            nodeHref={nodeHref}
                                        />
                                    ) : (
                                        <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>—</span>
                                    )}
                                </Td>
                            </Tr>
                            <Tr isExpanded={isExpanded}>
                                <Td />
                                <Td dataLabel="Details" colSpan={columns.length}>
                                    <ExpandableRowContent>
                                        {isExpanded && (
                                            <CodeEditor
                                                isDarkTheme={isDarkTheme}
                                                isReadOnly
                                                code={rawJson}
                                                language={Language.json}
                                                height={editorHeight}
                                            />
                                        )}
                                        {isExpanded && (
                                            <PortPolicy port={port} policy={policy} databaseNode={databaseNode} />
                                        )}
                                    </ExpandableRowContent>
                                </Td>
                            </Tr>
                        </Tbody>
                    );
                })}
                {rows.length === 0 && (
                    <Tbody>
                        <Tr>
                            <Td colSpan={columns.length + 1}>
                                {construct.ports.length === 0 ? 'No ports on this switch.' : 'No ports match.'}
                            </Td>
                        </Tr>
                    </Tbody>
                )}
            </Table>
        </>
    );
};

/** "cluster", or "node-local" with the exact scope and node as a tooltip. */
const ScopeCell: React.FC<{ row: ServiceVipRow }> = ({ row }) => {
    if (row.scope === 'cluster' || row.scope === 'unknown') return <>{row.scope}</>;
    return <span title={`${row.scope}${row.node ? ` on ${row.node}` : ''}`}>node-local</span>;
};

const ServiceName: React.FC<{ row: ServiceVipRow }> = ({ row }) =>
    row.service && row.service.kind === 'Service' ? (
        <Link
            to={getResourcePath({
                apiVersion: 'v1',
                kind: 'Service',
                namespace: row.service.namespace,
                name: row.service.name,
            })}
            title={row.loadBalancer.name}
        >
            {serviceLabel(row)}
        </Link>
    ) : (
        <code>{serviceLabel(row)}</code>
    );

/**
 * The Service VIPs a switch or router sees: its direct load balancers plus
 * the members of every load balancer group it attaches, one row per VIP.
 * Rendering is capped after filtering because the row count follows the
 * cluster's Service count, not the node's size. Keyed by construct uuid from
 * the parent so expansion and the filter reset on a different construct.
 */
const ServicesBody: React.FC<DrawerBodyProps> = ({ services, databaseNode }) => {
    const [filter, setFilter] = React.useState('');
    const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set());
    const attachment = services.status === 'ready' ? services.attachment : undefined;
    const allRows = React.useMemo(() => (attachment ? serviceVipRows(attachment) : []), [attachment]);

    if (!attachment) {
        return services.status === 'loading' ? (
            <div><Spinner size="md" aria-label="Loading services" /> Loading services…</div>
        ) : (
            <div style={SUBTLE_TEXT}>Load balancer rows were not collected for this node.</div>
        );
    }

    const summary = summarizeAttachment(attachment);
    if (allRows.length === 0) {
        return (
            <>
                <div data-testid="services-empty">{attachmentSummaryText(summary)}.</div>
                <div className="pf-u-mt-sm" style={SUBTLE_TEXT}>
                    No Service VIP is programmed here, so workloads behind this construct do not reach
                    ClusterIP Services through it.
                </div>
            </>
        );
    }

    const query = filter.trim().toLowerCase();
    const matches = query === '' ? allRows : allRows.filter((row) => serviceVipRowMatches(row, query));
    const rows = matches.slice(0, MAX_SERVICE_ROWS);

    const toggle = (key: string) =>
        setExpanded((current) => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });

    const columns = ['Service', 'Protocol', 'VIP', 'Backends', 'Scope', 'Source'];

    return (
        <>
            <Toolbar inset={{ default: 'insetNone' }} className="pf-u-pb-sm">
                <ToolbarContent>
                    <ToolbarItem>
                        <TextInput
                            aria-label="Filter services"
                            type="search"
                            placeholder={`Filter ${allRows.length} VIPs`}
                            value={filter}
                            onChange={(_event, value) => setFilter(value)}
                        />
                    </ToolbarItem>
                </ToolbarContent>
            </Toolbar>
            <div className="pf-u-mb-sm" style={SUBTLE_TEXT}>
                {attachmentSummaryText(summary)}
                {databaseNode ? ` · Load_Balancer rows from node ${databaseNode}` : ''}
            </div>
            {matches.length > rows.length && (
                <div className="pf-u-mb-sm" data-testid="services-cap">
                    Showing {rows.length} of {matches.length} VIPs; narrow the filter to see the rest.
                </div>
            )}
            <Table aria-label="Service load balancers" variant="compact" isExpandable>
                <Thead>
                    <Tr>
                        <Th screenReaderText="Row expansion" />
                        {columns.map((column) => <Th key={column}>{column}</Th>)}
                    </Tr>
                </Thead>
                {rows.map((row, rowIndex) => {
                    const isExpanded = expanded.has(row.key);
                    const options = row.loadBalancer.options ?? {};
                    const noEndpoints = row.vip !== '' && row.backends.length === 0;
                    return (
                        <Tbody key={row.key} isExpanded={isExpanded}>
                            <Tr data-testid={`service-row-${row.key}`}>
                                <Td
                                    expand={{
                                        rowIndex,
                                        isExpanded,
                                        onToggle: () => toggle(row.key),
                                        expandId: `service-${rowIndex}`,
                                    }}
                                />
                                <Td dataLabel="Service"><ServiceName row={row} /></Td>
                                <Td dataLabel="Protocol">{row.protocol}</Td>
                                <Td dataLabel="VIP">
                                    {row.vip ? <code>{row.vip}</code> : <span style={SUBTLE_TEXT}>—</span>}
                                </Td>
                                <Td dataLabel="Backends">
                                    {noEndpoints
                                        ? <Label isCompact color="yellow">No endpoints</Label>
                                        : row.backends.length}
                                </Td>
                                <Td dataLabel="Scope"><ScopeCell row={row} /></Td>
                                <Td dataLabel="Source">{row.sources.join(', ')}</Td>
                            </Tr>
                            <Tr isExpanded={isExpanded}>
                                <Td />
                                <Td dataLabel="Details" colSpan={columns.length}>
                                    <ExpandableRowContent>
                                        {isExpanded && (
                                            <>
                                                <div><strong>Backends</strong></div>
                                                {noEndpoints ? (
                                                    <div style={SUBTLE_TEXT}>
                                                        None: the Service has no ready endpoints
                                                        {options.reject === 'true'
                                                            ? ', and OVN rejects connections to this VIP.'
                                                            : '.'}
                                                    </div>
                                                ) : (
                                                    <CodeLines items={row.backends} />
                                                )}
                                                <div className="pf-u-mt-sm">
                                                    <strong>Load balancer</strong>{' '}
                                                    <code>{row.loadBalancer.name}</code>
                                                </div>
                                                {options.affinity_timeout && (
                                                    <div>
                                                        <strong>Session affinity</strong>{' '}
                                                        {options.affinity_timeout}s
                                                    </div>
                                                )}
                                            </>
                                        )}
                                    </ExpandableRowContent>
                                </Td>
                            </Tr>
                        </Tbody>
                    );
                })}
                {rows.length === 0 && (
                    <Tbody>
                        <Tr>
                            <Td colSpan={columns.length + 1}>No services match.</Td>
                        </Tr>
                    </Tbody>
                )}
            </Table>
        </>
    );
};

type ConstructTabId = 'overview' | 'relationships' | 'ports' | 'services' | 'config';

const CONSTRUCT_TABS: ReadonlyArray<{ id: ConstructTabId; title: string }> = [
    { id: 'overview', title: 'Overview' },
    { id: 'relationships', title: 'Relationships' },
    { id: 'ports', title: 'Ports' },
    { id: 'services', title: 'Services' },
    { id: 'config', title: 'Config' },
];

/** Only switches carry Logical_Switch_Ports; routers keep three tabs (LRPs
 * are out of scope for the Ports tab). */
export const hasPortsTab = (construct: LadderConstruct): boolean =>
    ovnKindFor(construct).table === 'Logical_Switch';

/** A switch or router that attaches a load balancer or a load balancer
 * group, even an empty one: the constructs the Services tab is about. */
export const hasLoadBalancerAttachment = (construct: LadderConstruct): boolean =>
    (construct.kind === 'router' || construct.kind === 'switch') &&
    construct.loadBalancerCount + construct.loadBalancerGroupCount > 0;

/** A switch: the construct whose ports port groups and ACLs apply to. */
export const hasPolicyAttachment = (construct: LadderConstruct): boolean => hasPortsTab(construct);

/** The optional snapshot sections the drawer renders. They travel in one
 * request, so hopping between a switch and a router refetches nothing. */
const DRAWER_SECTIONS: readonly SnapshotSection[] = ['policy', 'services'];
const NO_SECTIONS: readonly SnapshotSection[] = [];

/**
 * Resolve the construct's load balancers from the services section and the
 * zone's policy indexes from the policy section. The ladder pages fetch
 * without sections, so they normally arrive through a second request to the
 * node `database` came from (the representative zone on the cluster view),
 * issued when a construct that needs one is selected; a database that already
 * carries a section is used as is.
 */
const useDrawerSections = ({
    construct,
    database,
    databaseNode,
    sectionsRefreshKey,
}: ConstructDrawerBodyProps): { services: ServicesState; policy: PolicyState } => {
    const wantsServices = hasLoadBalancerAttachment(construct);
    const wantsPolicy = hasPolicyAttachment(construct);
    const carriedServices = hasServicesSection(database) ? database : undefined;
    const carriedPolicy = hasPolicySection(database) ? database : undefined;
    const needsFetch = (wantsServices && !carriedServices) || (wantsPolicy && !carriedPolicy);
    const fetched = useOptionalSections(
        needsFetch ? databaseNode : undefined,
        needsFetch ? DRAWER_SECTIONS : NO_SECTIONS,
        sectionsRefreshKey,
    );
    const servicesDatabase = carriedServices ?? fetched.database;
    const policyDatabase = carriedPolicy ?? fetched.database;

    const services = React.useMemo<ServicesState>(() => {
        if (!wantsServices) return { status: 'none' };
        const attachment = loadBalancersFor(construct, servicesDatabase);
        if (attachment && servicesDatabase) return { status: 'ready', attachment, database: servicesDatabase };
        if (fetched.loading) return { status: 'loading' };
        return { status: 'absent', error: fetched.error };
    }, [wantsServices, construct, servicesDatabase, fetched.loading, fetched.error]);

    const policy = React.useMemo<PolicyState>(() => {
        if (!wantsPolicy) return { status: 'none' };
        if (hasPolicySection(policyDatabase)) {
            return {
                status: 'ready',
                index: policyIndexFor(policyDatabase),
                database: policyDatabase,
                switchUuid: zoneRowFor(policyDatabase.logicalSwitches, construct)?.uuid,
            };
        }
        if (fetched.loading) return { status: 'loading' };
        return { status: 'absent', error: fetched.error };
    }, [wantsPolicy, construct, policyDatabase, fetched.loading, fetched.error]);

    return { services, policy };
};

/**
 * Rendered directly under the page's DrawerHead. The tab strip sits flush
 * against the panel edges and only the tab content is padded, the same
 * structure as the physical drawer (ovn-recon-mow); wrapping the whole thing
 * in a padded body inset the strip and made the two drawers read differently.
 */
const ConstructDrawerBody: React.FC<ConstructDrawerBodyProps> = (props) => {
    // The active tab survives selection changes — hopping between constructs
    // via the Relationships tab must keep you on Relationships, matching the
    // physical drawer. A freshly opened drawer starts at Overview because the
    // component mounts anew (the pages unmount it when nothing is selected).
    const [activeTab, setActiveTab] = React.useState<ConstructTabId>('overview');
    const { services, policy } = useDrawerSections(props);
    // Hopping from a switch's Ports tab to a router (via Relationships) lands
    // on Overview; the stored choice is kept so a hop back to a switch returns
    // to Ports. The Services tab follows the same rule: it shows on a switch
    // or router that attaches load balancers, once the services section is
    // loading or loaded, and not at all when the collector did not deliver it.
    const showPorts = hasPortsTab(props.construct);
    const showServices = services.status === 'ready' || services.status === 'loading';
    const tabs = CONSTRUCT_TABS.filter(
        (tab) => (tab.id !== 'ports' || showPorts) && (tab.id !== 'services' || showServices),
    );
    const effectiveTab: ConstructTabId =
        (activeTab === 'ports' && !showPorts) || (activeTab === 'services' && !showServices) ? 'overview' : activeTab;
    const bodyProps: DrawerBodyProps = { ...props, services, policy };

    return (
        <>
            <DrawerTabStrip<ConstructTabId>
                tabs={tabs}
                activeKey={effectiveTab}
                onSelect={setActiveTab}
                aria-label="Construct details"
            />
            <DrawerPanelBody>
                {effectiveTab === 'overview' && <OverviewBody {...bodyProps} />}
                {effectiveTab === 'relationships' && <RelationshipsBody {...props} />}
                {effectiveTab === 'ports' && <PortsBody key={props.construct.uuid} {...bodyProps} />}
                {effectiveTab === 'services' && <ServicesBody key={props.construct.uuid} {...bodyProps} />}
                {effectiveTab === 'config' && <ConfigBody {...bodyProps} />}
            </DrawerPanelBody>
        </>
    );
};

export default ConstructDrawerBody;
