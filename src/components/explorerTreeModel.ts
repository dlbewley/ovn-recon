import type { SeverityCounts } from '../insights/selectors';
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
 * rest; a filter lifts the cap, and the selected network is always listed.
 *
 * Findings (ovn-recon-gbr.7): a node or network with findings carries their counts as
 * a badge, and so does a closed group with such a member. The counts are the shell's
 * one evaluation (the node table's and the networks table's own), never worked out
 * here. "With findings only" narrows both groups to those members. The matches-only
 * switch is ovn-recon-gbr.8.
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
    /**
     * Findings to badge: a node's or network's own, or, on a closed group, its members'
     * (after the filter, before the cap). Unset when there are none to show.
     */
    findings?: SeverityCounts;
}

export interface ExplorerTreeNode {
    name: string;
    /** From the node's role labels; empty when it has none. */
    role: string;
    /** The node's findings, as the node table counts them. */
    findings?: SeverityCounts;
}

/** A network as the tree needs it: its address, and its findings as the networks table counts them. */
export type ExplorerTreeNetwork = NetworkAddress & { findings?: SeverityCounts };

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
    /**
     * "With findings only": list only the nodes and networks with findings (and the
     * selection). Ignored while nothing has findings, so a switch the tree no longer
     * offers cannot leave it empty.
     */
    findingsOnly?: boolean;
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

const hasFindings = (counts: SeverityCounts | undefined): counts is SeverityCounts =>
    counts !== undefined && counts.total > 0;

/** Some node or network has findings: the tree offers "With findings only". */
export const treeHasFindings = (nodes: ExplorerTreeNode[], networks: ExplorerTreeNetwork[]): boolean =>
    nodes.some((node) => hasFindings(node.findings)) || networks.some((network) => hasFindings(network.findings));

/** Members' counts added up; undefined when none has findings. */
const sumFindings = (items: ExplorerTreeItem[]): SeverityCounts | undefined => {
    const total = items.reduce<SeverityCounts>((sum, item) => ({
        warning: sum.warning + (item.findings?.warning ?? 0),
        info: sum.info + (item.findings?.info ?? 0),
        total: sum.total + (item.findings?.total ?? 0),
    }), { warning: 0, info: 0, total: 0 });
    return total.total > 0 ? total : undefined;
};

/** Case-insensitive substring match; an empty filter keeps everything. */
const matcher = (filter: string): ((label: string) => boolean) => {
    const needle = filter.trim().toLowerCase();
    return needle === '' ? () => true : (label) => label.toLowerCase().includes(needle);
};

/**
 * The tree's items. With a filter, each group lists only the members whose name
 * holds it, opens, and badges the count that matched; Cluster always stays. With
 * "With findings only" on, likewise for the members with findings, the selected
 * item kept listed so the selection never vanishes from the tree.
 */
export const buildExplorerTree = ({
    nodes,
    networks,
    filter,
    openGroups,
    showAllNetworks,
    selectedId,
    findingsOnly = false,
    limit = TREE_NETWORK_LIMIT,
}: ExplorerTreeInput): ExplorerTreeItem[] => {
    const matches = matcher(filter);
    const onlyFindings = findingsOnly && treeHasFindings(nodes, networks);
    const filtering = filter.trim() !== '' || onlyFindings;
    const kept = (item: ExplorerTreeItem): boolean =>
        matches(item.label) && (!onlyFindings || item.findings !== undefined || item.id === selectedId);

    const nodeItems = nodes
        .map((node): ExplorerTreeItem => ({
            id: nodeItemId(node.name),
            kind: 'node',
            label: node.name,
            detail: node.role || undefined,
            node: node.name,
            ...(hasFindings(node.findings) ? { findings: node.findings } : {}),
        }))
        .filter(kept);

    const networkItems = networks
        .map((network): ExplorerTreeItem => ({
            id: networkItemId(network),
            kind: 'network',
            label: networkLabel(network),
            detail: NETWORK_KIND_LABEL[network.kind],
            network: network.namespace === undefined
                ? { kind: network.kind, name: network.name }
                : { kind: network.kind, namespace: network.namespace, name: network.name },
            ...(hasFindings(network.findings) ? { findings: network.findings } : {}),
        }))
        .filter(kept);

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
    // An open group shows its members' badges; a closed one carries them.
    const group = (id: string, label: string, members: ExplorerTreeItem[], children: ExplorerTreeItem[], open: boolean): ExplorerTreeItem => {
        const findings = open ? undefined : sumFindings(members);
        return {
            id,
            kind: 'group',
            label,
            children,
            count: members.length,
            expanded: open,
            ...(findings ? { findings } : {}),
        };
    };

    return [
        { id: CLUSTER_ITEM_ID, kind: 'cluster', label: 'Cluster' },
        group(NODES_GROUP_ID, 'Nodes', nodeItems, nodeItems,
            filtering || openGroups.has(NODES_GROUP_ID) || holds(nodeItems)),
        group(NETWORKS_GROUP_ID, 'Networks', networkItems, networkChildren,
            filtering || openGroups.has(NETWORKS_GROUP_ID) || holds(shownNetworks)),
    ];
};

/** Every item, depth first: for finding one by id. */
export const flattenTree = (items: ExplorerTreeItem[]): ExplorerTreeItem[] =>
    items.flatMap((item) => [item, ...flattenTree(item.children ?? [])]);
