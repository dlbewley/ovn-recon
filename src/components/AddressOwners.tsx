import * as React from 'react';
import { Button, Popover } from '@patternfly/react-core';

import { ConsoleLink } from '../linkOut/LinkOut';
import { AddressOwner, AddressOwnerKind, addressOwnerTarget } from './addressBook';
import { DEFAULT_NETWORK } from './logicalClassification';
import { networkDisplayName } from './LogicalLadderView';
import { isUdnMasqueradeRole, MASQUERADE_ROLE_LABELS } from './masqueradeIps';

const SUBTLE: React.CSSProperties = { color: 'var(--pf-t--global--text--color--subtle)' };

const KIND_LABELS: Record<AddressOwnerKind, string> = {
    masquerade: 'Masquerade',
    pod: 'Pod',
    'router-port': 'Router port',
    'switch-port': 'Switch port',
    service: 'Service',
    nat: 'NAT on',
    node: 'Node',
    interface: 'Interface',
};

export interface AddressOwnersProps {
    /** The address the owners were resolved from, to name it in the list. */
    address: string;
    owners: readonly AddressOwner[];
    /** Draw an owner the caller has its own link for; undefined keeps the default. */
    renderOwner?: (owner: AddressOwner) => React.ReactNode | undefined;
}

const BASIS_TEXT = {
    observed: 'observed in OVN or on a host',
    derived: 'derived from the masquerade offsets',
    both: 'observed, and as the masquerade offsets place it',
} as const;

/** How a masquerade owner was established, in words. */
const masqueradeBasisText = (owner: AddressOwner): string | undefined =>
    owner.masquerade && `Masquerade subnet ${owner.masquerade.subnet} · ${BASIS_TEXT[owner.masquerade.basis]}`;

/**
 * A masquerade address: its role, and for a network's pair the network,
 * linked to its page, or its ID when no single network claims it.
 */
const MasqueradeOwnerText: React.FC<{ owner: AddressOwner }> = ({ owner }) => {
    const detail = owner.masquerade;
    if (!detail) return <>{owner.label}</>;
    const role = MASQUERADE_ROLE_LABELS[detail.role];
    if (!isUdnMasqueradeRole(detail.role)) return <>{role}</>;
    if (owner.network) {
        return (
            <>
                {role} of{' '}
                <ConsoleLink target={addressOwnerTarget(owner)}>{networkDisplayName(owner.network)}</ConsoleLink>
            </>
        );
    }
    return (
        <>
            {role} of network ID {detail.networkId}
            {detail.ambiguous && <> (claimed by {detail.ambiguous.join(' and ')})</>}
        </>
    );
};

const OwnerLink: React.FC<{ owner: AddressOwner; renderOwner: AddressOwnersProps['renderOwner'] }> = ({ owner, renderOwner }) =>
    <>
        {renderOwner?.(owner) ?? (owner.kind === 'masquerade' ? <MasqueradeOwnerText owner={owner} /> : (
            <>
                {KIND_LABELS[owner.kind]} <ConsoleLink target={addressOwnerTarget(owner)}>{owner.label}</ConsoleLink>
            </>
        ))}
    </>;

/**
 * Who holds an address, as a subtle line under it; the address itself stays
 * where it is. One owner is named outright. Several are a count that opens the
 * whole list, each tagged with its network: overlapping networks make that a
 * real answer, and naming any one of them here would be a guess.
 */
export const AddressOwners: React.FC<AddressOwnersProps> = ({ address, owners, renderOwner }) => {
    if (owners.length === 0) return null;
    if (owners.length === 1) {
        const [owner] = owners;
        return (
            <span style={{ ...SUBTLE, display: 'block' }} data-testid="address-owner">
                <OwnerLink owner={owner} renderOwner={renderOwner} />
                {owner.kind !== 'masquerade' && owner.network && owner.network !== DEFAULT_NETWORK
                    && <> ({networkDisplayName(owner.network)})</>}
            </span>
        );
    }
    return (
        <span style={{ ...SUBTLE, display: 'block' }} data-testid="address-owners">
            <Popover
                aria-label={`Possible owners of ${address}`}
                headerContent={`Possible owners of ${address}`}
                bodyContent={
                    <ul data-testid="address-owner-list">
                        {owners.map((owner) => (
                            <li key={`${owner.kind}|${owner.label}|${owner.network ?? ''}|${owner.node ?? ''}`}>
                                <OwnerLink owner={owner} renderOwner={renderOwner} />
                                <div style={SUBTLE}>
                                    {[
                                        owner.kind === 'masquerade'
                                            ? masqueradeBasisText(owner)
                                            : owner.network ? networkDisplayName(owner.network) : 'Host network',
                                        ...new Set(owner.provenance.map((entry) => `${entry.source} ${entry.record}`)),
                                    ].join(' · ')}
                                </div>
                            </li>
                        ))}
                    </ul>
                }
            >
                <Button variant="link" isInline>{owners.length} possible owners</Button>
            </Popover>
        </span>
    );
};

export default AddressOwners;
