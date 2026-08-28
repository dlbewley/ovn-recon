import * as React from 'react';
import { Link } from 'react-router';
import {
    DescriptionList,
    DescriptionListGroup,
    DescriptionListTerm,
    DescriptionListDescription,
} from '@patternfly/react-core';

import { LadderConstruct, LadderModel } from './logicalLadderModel';
import { networkDisplayName, roleLabel } from './LogicalLadderView';

export interface ConstructDrawerBodyProps {
    construct: LadderConstruct & { zones?: string[] };
    model: LadderModel;
    /** When set, node-bound constructs link to that node's logical view. */
    nodeHref?: (node: string) => string;
}

const ConstructDrawerBody: React.FC<ConstructDrawerBodyProps> = ({ construct, model, nodeHref }) => {
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
                    <DescriptionListDescription>
                        {nodeHref
                            ? <Link to={nodeHref(construct.node)}>{construct.node}</Link>
                            : construct.node}
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

export default ConstructDrawerBody;
