import * as React from 'react';
import { Link } from 'react-router';
import {
    Button,
    DescriptionList,
    DescriptionListGroup,
    DescriptionListTerm,
    DescriptionListDescription,
    Tab,
    Tabs,
    TabTitleText,
    TextInput,
} from '@patternfly/react-core';
import { CodeEditor, Language } from '@patternfly/react-code-editor';

import { LogicalDatabase, NATRow, StaticRouteRow } from '../types';
import { networkResourceRef } from './logicalClassification';
import { LadderConstruct, LadderModel } from './logicalLadderModel';
import { edgeLabel, networkDisplayName, roleLabel } from './LogicalLadderView';
import { configPayloadFor, ovnKindFor } from './ovnKindRegistry';
import { useIsDarkTheme } from './useIsDarkTheme';
import { getResourcePath } from '../topology/links';

const MAX_LISTED_RULES = 10;
const MAX_LISTED_PORTS = 15;

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
}

const SEAM_ROLES = new Set(['external-switch', 'localnet-switch']);

const natRuleText = (nat: NATRow): string => {
    const target = nat.logicalPort ? `${nat.logicalIp} (${nat.logicalPort})` : nat.logicalIp ?? '';
    return `${nat.type} ${nat.externalIp ?? ''} ⇄ ${target}`;
};

const staticRouteText = (route: StaticRouteRow): string => {
    const parts = [`${route.ipPrefix} → ${route.nexthop ?? ''}`];
    if (route.policy) parts.push(`policy ${route.policy}`);
    if (route.outputPort) parts.push(`via ${route.outputPort}`);
    return parts.join(', ');
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

const OverviewBody: React.FC<ConstructDrawerBodyProps> = ({
    construct,
    nodeHref,
    physicalHref,
    fallbackNode,
    totalNodes,
}) => {
    const networkRef = networkResourceRef(construct.network);
    const seamNode = SEAM_ROLES.has(construct.role) ? construct.node ?? fallbackNode : undefined;

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
                        <RuleList items={construct.natRules.map(natRuleText)} />
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
const ConfigBody: React.FC<ConstructDrawerBodyProps> = ({ construct, database, databaseNode }) => {
    const isDarkTheme = useIsDarkTheme();
    const { source, payload } = configPayloadFor(construct, database ?? null);
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

const ConstructDrawerBody: React.FC<ConstructDrawerBodyProps> = (props) => {
    // The active tab survives selection changes — hopping between constructs
    // via the Relationships tab must keep you on Relationships, matching the
    // physical drawer. A freshly opened drawer starts at Overview because the
    // component mounts anew (the pages unmount it when nothing is selected).
    const [activeTab, setActiveTab] = React.useState<string | number>('overview');

    return (
        <Tabs
            activeKey={activeTab}
            onSelect={(_event, key) => setActiveTab(key)}
            aria-label="Construct details"
        >
            <Tab eventKey="overview" title={<TabTitleText>Overview</TabTitleText>}>
                <div className="pf-u-pt-md">
                    <OverviewBody {...props} />
                </div>
            </Tab>
            <Tab eventKey="relationships" title={<TabTitleText>Relationships</TabTitleText>}>
                <div className="pf-u-pt-md">
                    <RelationshipsBody {...props} />
                </div>
            </Tab>
            <Tab eventKey="config" title={<TabTitleText>Config</TabTitleText>}>
                <div className="pf-u-pt-md">
                    <ConfigBody {...props} />
                </div>
            </Tab>
        </Tabs>
    );
};

export default ConstructDrawerBody;
