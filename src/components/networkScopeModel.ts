import type { ExplorerView } from '../routes';
import {
    findNetwork,
    NetworkAddress,
    NetworkInputs,
    NetworkKind,
    NetworkRecord,
    networkCreationFailure,
} from './networkPageModel';
import type { OverviewNetworkRow } from './overviewModel';

/**
 * The explorer's network scope, as data (ovn-recon-gbr.6). Pure: what a network URL
 * shows (still loading, missing, or the network), what the scope header says about
 * it, and the not-found text. The network page's own body (`NetworkBody`) draws the
 * rest; this module decides nothing it already decides.
 */

export type NetworkView = Extract<ExplorerView, { scope: 'network' }>;

/** The kinds by their API names, as the network page's header labels them. */
export const NETWORK_KIND_TITLE: Record<NetworkKind, string> = {
    cudn: 'ClusterUserDefinedNetwork',
    udn: 'UserDefinedNetwork',
    nad: 'NetworkAttachmentDefinition',
};

/** `namespace/name` for a UDN or NAD, the name alone for a CUDN: as the tree labels it. */
export const networkDisplayName = (address: Pick<NetworkAddress, 'name' | 'namespace'>): string =>
    (address.namespace ? `${address.namespace}/${address.name}` : address.name);

export type NetworkScopeState =
    | { status: 'loading' }
    | { status: 'missing' }
    | { status: 'found'; record: NetworkRecord };

/**
 * What a network URL shows. Loading until every network kind has settled (loaded,
 * failed or not served), then the network or, when none is watched under that
 * address, missing: never "Loading..." for good (ovn-recon-nt4.13). A network that
 * turns up after it was reported missing replaces the not-found state.
 */
export const networkScopeState = (
    address: NetworkAddress,
    inputs: NetworkInputs,
    loaded: boolean,
): NetworkScopeState => {
    const record = findNetwork(address, inputs);
    if (record) return { status: 'found', record };
    return loaded ? { status: 'missing' } : { status: 'loading' };
};

/** The overview's row for a network: its wired count. A generated NAD has none. */
export const networkRowFor = (
    rows: readonly OverviewNetworkRow[],
    address: NetworkAddress,
): OverviewNetworkRow | undefined =>
    rows.find(({ record }) => record.kind === address.kind
        && record.name === address.name
        && (address.kind === 'cudn' || (record.namespace ?? 'default') === (address.namespace ?? 'default')));

/**
 * The short facts after the network's name in the scope header: topology, role and,
 * where the network has a node-local check, on how many nodes it is wired. The
 * summary card below spells everything out; the header is for telling networks apart.
 */
export const networkHeaderFacts = (record: NetworkRecord, row?: OverviewNetworkRow): string[] => {
    const facts = [record.topology];
    if (record.role) facts.push(record.role);
    if (row?.wired) facts.push(`wired on ${row.wired.wired} of ${row.wired.total} nodes`);
    return facts;
};

/** The network was refused by OVN-Kubernetes: said in the header too, before anything else. */
export const networkNotCreated = (record: NetworkRecord): boolean => networkCreationFailure(record) !== undefined;

/** The not-found sentence, naming the kind the URL asked for. */
export const networkNotFoundText = (address: NetworkAddress): string =>
    `No ${NETWORK_KIND_TITLE[address.kind]} named ${networkDisplayName(address)} is visible.`;
