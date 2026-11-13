import type { ExplorerView } from '../routes';
import type { NetworkAddress } from './networkPageModel';
import { NETWORK_KIND_LABEL } from './overviewModel';

/**
 * The explorer's tree, as data (ovn-recon-gbr.4). Pure: the shell hands it the nodes
 * and networks it already watches, the name filter, which groups are open and what
 * the URL selects, and draws what comes back with a PatternFly TreeView.
 *
 * Three roots: Cluster, Nodes and Networks. Nodes show their role and networks their
 * kind. Networks come in the order they are handed over (the overview's: findings
 * first), flat, and are capped with a "Show N more" item until the user asks for the
 * rest; a filter lifts the cap, and the selected network is always listed. Finding
 * badges and the findings-only and matches-only switches are ovn-recon-gbr.7 and
 * ovn-recon-gbr.8.
 */

/** How many networks the tree lists before "Show N more". */
export const TREE_NETWORK_LIMIT = 10;

export const CLUSTER_ITEM_ID = 'cluster';
export const NODES_GROUP_ID = 'nodes';
export const NETWORKS_GROUP_ID = 'networks';
export const MORE_NETWORKS_ID = 'networks:more';

export type ExplorerTreeItemKind = 'cluster' | 'group' | 'node' | 'network' | 'more';

export interface ExplorerTreeItem {
    /** Unique in the tree, and stable across renders: what selection and open groups key on. */
    id: string;
    kind: ExplorerTreeItemKind;
    /** What the item is called: the node name, or `namespace/name` for a namespaced network. */
    label: string;
    /** Drawn after the label, quieter: a node's role, a network's kind. */
    detail?: string;
    /** A node's name, for a node item. */
    node?: string;
    /** A network's address, for a network item. */
    network?: NetworkAddress;
    /** A group's members, after the filter and the cap. */
    children?: ExplorerTreeItem[];
    /** A group's badge: how many members match the filter, before the cap. */
    count?: number;
    /** A group is open: the user opened it, the filter is on, or it holds the selection. */
    expanded?: boolean;
    /** The "Show N more" item: how many networks it stands for. */
    hidden?: number;
}

export interface ExplorerTreeNode {
    name: string;
    /** From the node's role labels; empty when it has none. */
    role: string;
}

/** A network as the tree needs it: its address. */
export type ExplorerTreeNetwork = NetworkAddress;

export interface ExplorerTreeInput {
    nodes: ExplorerTreeNode[];
    /** In the order to list them. */
    networks: ExplorerTreeNetwork[];
    /** The name filter, as typed. */
    filter: string;
    /** Group ids the user has open. */
    openGroups: ReadonlySet<string>;
    /** The user asked for every network ("Show N more"). */
    showAllNetworks: boolean;
    /** The selected item's id (`selectedItemId`), or null. */
    selectedId: string | null;
    limit?: number;
}

export const nodeItemId = (node: string): string => `node:${node}`;

/** Keyed as the overview's network rows are: kind, namespace and name. */
export const networkItemId = (network: Pick<ExplorerTreeNetwork, 'kind' | 'name' | 'namespace'>): string =>
    `network:${network.kind}/${network.namespace ?? ''}/${network.name}`;

/** What a location selects in the tree: Cluster for every cluster tab, else the node or network. */
export const selectedItemId = (view: ExplorerView | null): string | null => {
    if (!view) return null;
    if (view.scope === 'cluster') return CLUSTER_ITEM_ID;
    if (view.scope === 'node') return nodeItemId(view.params.node);
    return networkItemId(view.params.network);
};

const networkLabel = (network: ExplorerTreeNetwork): string =>
    (network.namespace ? `${network.namespace}/${network.name}` : network.name);

/** Case-insensitive substring match; an empty filter keeps everything. */
const matcher = (filter: string): ((label: string) => boolean) => {
    const needle = filter.trim().toLowerCase();
    return needle === '' ? () => true : (label) => label.toLowerCase().includes(needle);
};

/**
 * The tree's items. With a filter, each group lists only the members whose name
 * holds it, opens, and badges the count that matched; Cluster always stays.
 */
export const buildExplorerTree = ({
    nodes,
    networks,
    filter,
    openGroups,
    showAllNetworks,
    selectedId,
    limit = TREE_NETWORK_LIMIT,
}: ExplorerTreeInput): ExplorerTreeItem[] => {
    const matches = matcher(filter);
    const filtering = filter.trim() !== '';

    const nodeItems = nodes
        .filter((node) => matches(node.name))
        .map((node): ExplorerTreeItem => ({
            id: nodeItemId(node.name),
            kind: 'node',
            label: node.name,
            detail: node.role || undefined,
            node: node.name,
        }));

    const networkItems = networks
        .map((network): ExplorerTreeItem => ({
            id: networkItemId(network),
            kind: 'network',
            label: networkLabel(network),
            detail: NETWORK_KIND_LABEL[network.kind],
            network: network.namespace === undefined
                ? { kind: network.kind, name: network.name }
                : { kind: network.kind, namespace: network.namespace, name: network.name },
        }))
        .filter((item) => matches(item.label));

    let shownNetworks = networkItems;
    let hidden = 0;
    if (!filtering && !showAllNetworks && networkItems.length > limit) {
        shownNetworks = networkItems.slice(0, limit);
        // The selected network is always listed, after the capped ones.
        const selected = networkItems.slice(limit).find((item) => item.id === selectedId);
        if (selected) shownNetworks = [...shownNetworks, selected];
        hidden = networkItems.length - shownNetworks.length;
    }
    const networkChildren: ExplorerTreeItem[] = hidden > 0
        ? [...shownNetworks, { id: MORE_NETWORKS_ID, kind: 'more', label: `Show ${hidden} more`, hidden }]
        : shownNetworks;

    const holds = (items: ExplorerTreeItem[]): boolean => items.some((item) => item.id === selectedId);

    return [
        { id: CLUSTER_ITEM_ID, kind: 'cluster', label: 'Cluster' },
        {
            id: NODES_GROUP_ID,
            kind: 'group',
            label: 'Nodes',
            children: nodeItems,
            count: nodeItems.length,
            expanded: filtering || openGroups.has(NODES_GROUP_ID) || holds(nodeItems),
        },
        {
            id: NETWORKS_GROUP_ID,
            kind: 'group',
            label: 'Networks',
            children: networkChildren,
            count: networkItems.length,
            expanded: filtering || openGroups.has(NETWORKS_GROUP_ID) || holds(shownNetworks),
        },
    ];
};

/** Every item, depth first: for finding one by id. */
export const flattenTree = (items: ExplorerTreeItem[]): ExplorerTreeItem[] =>
    items.flatMap((item) => [item, ...flattenTree(item.children ?? [])]);
