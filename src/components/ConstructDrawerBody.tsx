import * as React from 'react';
import { Link } from 'react-router';
import {
    DescriptionList,
    DescriptionListGroup,
    DescriptionListTerm,
    DescriptionListDescription,
    TextInput,
} from '@patternfly/react-core';

import { NATRow, StaticRouteRow } from '../types';
import { networkResourceRef } from './logicalClassification';
import { LadderConstruct, LadderModel } from './logicalLadderModel';
import { networkDisplayName, roleLabel } from './LogicalLadderView';
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

const ConstructDrawerBody: React.FC<ConstructDrawerBodyProps> = ({
    construct,
    model,
    nodeHref,
    physicalHref,
    fallbackNode,
}) => {
    const networkRef = networkResourceRef(construct.network);
    const seamNode = SEAM_ROLES.has(construct.role) ? construct.node ?? fallbackNode : undefined;

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
            {construct.zones && construct.zones.length > 0 && (
                <DescriptionListGroup>
                    <DescriptionListTerm>Present in zones</DescriptionListTerm>
                    <DescriptionListDescription>
                        {[...construct.zones].sort().join(', ')}
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

export default ConstructDrawerBody;
