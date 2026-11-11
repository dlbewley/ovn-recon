import type { DrawerIdentityProps, Identifier } from './drawerKit';
import { DEFAULT_NETWORK, networkResourceRef } from './logicalClassification';
import { LadderConstruct } from './logicalLadderModel';
import { networkDisplayName, roleLabel } from './LogicalLadderView';
import { resourceTarget } from '../linkOut/registry';

/**
 * The logical drawer's identity header and Identifiers as data
 * (ovn-recon-dp7.1), the counterpart of src/topology/drawerIdentity.ts.
 */

/**
 * The OVN name without its network's prefix, when it carries one: a CUDN's
 * rows are named `cluster_udn_<name with dots>_<construct>`, so the display
 * name is the construct part and the network is the header's chip. A name
 * that does not start with its network's prefix is shown as it is.
 */
export const constructDisplayName = (construct: Pick<LadderConstruct, 'name' | 'network'>): string => {
    const { name, network } = construct;
    if (!network || network === DEFAULT_NETWORK) return name;
    const prefixes = [`${network}_`, `${network.replace(/-/g, '.')}_`];
    const prefix = prefixes.find((candidate) => name.startsWith(candidate) && name.length > candidate.length);
    return prefix ? name.slice(prefix.length) : name;
};

export const constructIdentity = (
    construct: LadderConstruct,
    nodeHref?: (node: string) => string,
): Omit<DrawerIdentityProps, 'icon'> => {
    const networkRef = networkResourceRef(construct.network);
    return {
        name: constructDisplayName(construct),
        kind: roleLabel(construct.role),
        // Routers only: an unset column is enabled, as OVN treats it.
        state: construct.enabled === undefined
            ? undefined
            : construct.enabled
                ? { text: 'Enabled', status: 'success' }
                : { text: 'Disabled', status: 'danger' },
        chips: [
            ...(construct.node
                ? [{ kind: 'Node', value: construct.node, to: nodeHref?.(construct.node) }]
                : []),
            {
                kind: 'Network',
                value: `${networkDisplayName(construct.network)}${construct.topology ? ` (${construct.topology})` : ''}`,
                target: networkRef ? resourceTarget(networkRef) : undefined,
            },
        ],
    };
};

/** The UUID, and the OVN name when the header shows a shorter one. */
export const constructIdentifiers = (construct: Pick<LadderConstruct, 'name' | 'network' | 'uuid'>): Identifier[] => [
    ...(constructDisplayName(construct) !== construct.name ? [{ label: 'OVN name', value: construct.name }] : []),
    { label: 'UUID', value: construct.uuid },
];
