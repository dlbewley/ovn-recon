import * as React from 'react';
import { SearchInput, TreeView, TreeViewDataItem } from '@patternfly/react-core';

import {
    buildExplorerTree,
    ExplorerTreeItem,
    ExplorerTreeNetwork,
    ExplorerTreeNode,
    flattenTree,
} from './explorerTreeModel';

/**
 * The explorer's tree (ovn-recon-gbr.4): a name filter over a PatternFly TreeView of
 * Cluster, Nodes and Networks. Draws `explorerTreeModel`; what selecting an item
 * does, and which groups are open, are the shell's, so they survive the tree being
 * collapsed to its rail and drawn again.
 */

const subtle: React.CSSProperties = {
    color: 'var(--pf-t--global--text--color--subtle)',
    marginInlineStart: 'var(--pf-t--global--spacer--sm)',
    fontSize: 'var(--pf-t--global--font--size--sm)',
};

export interface ExplorerTreeProps {
    nodes: ExplorerTreeNode[];
    networks: ExplorerTreeNetwork[];
    /** The selected item's id, from the URL. */
    selectedId: string | null;
    filter: string;
    onFilterChange: (filter: string) => void;
    openGroups: ReadonlySet<string>;
    onGroupToggle: (groupId: string, open: boolean) => void;
    showAllNetworks: boolean;
    /** A leaf was chosen: Cluster, a node, a network, or "Show N more". */
    onSelectItem: (item: ExplorerTreeItem) => void;
}

/** The model's item as TreeView data; `id` carries everything back to the model. */
const toTreeData = (item: ExplorerTreeItem): TreeViewDataItem => ({
    id: item.id,
    name: (
        // One line per item: a role or kind wrapping under the name doubles the row.
        <span data-testid={`explorer-tree-${item.id}`} style={{ whiteSpace: 'nowrap' }}>
            {item.kind === 'more' ? <em>{item.label}</em> : item.label}
            {item.detail && <span style={subtle}>{item.detail}</span>}
        </span>
    ),
    ...(item.children ? {
        children: item.children.map(toTreeData),
        defaultExpanded: item.expanded,
        hasBadge: true,
        customBadgeContent: item.count,
    } : {}),
});

const ExplorerTree: React.FC<ExplorerTreeProps> = ({
    nodes,
    networks,
    selectedId,
    filter,
    onFilterChange,
    openGroups,
    onGroupToggle,
    showAllNetworks,
    onSelectItem,
}) => {
    const items = React.useMemo(
        () => buildExplorerTree({ nodes, networks, filter, openGroups, showAllNetworks, selectedId }),
        [nodes, networks, filter, openGroups, showAllNetworks, selectedId],
    );
    const byId = React.useMemo(() => new Map(flattenTree(items).map((item) => [item.id, item])), [items]);
    const data = React.useMemo(() => items.map(toTreeData), [items]);
    const active = React.useMemo(
        () => (selectedId && byId.has(selectedId) ? [{ id: selectedId, name: '' }] : []),
        [selectedId, byId],
    );

    return (
        <div data-testid="explorer-tree">
            <SearchInput
                aria-label="Filter the tree by name"
                placeholder="Filter by name"
                value={filter}
                onChange={(_event, value) => onFilterChange(value)}
                onClear={() => onFilterChange('')}
            />
            <TreeView
                aria-label="Cluster, nodes and networks"
                data={data}
                activeItems={active}
                variant="default"
                onSelect={(_event, treeItem) => {
                    const item = byId.get(String(treeItem.id));
                    // A group opens and closes; it is not a place to go.
                    if (item && item.kind !== 'group') onSelectItem(item);
                }}
                onExpand={(_event, treeItem) => onGroupToggle(String(treeItem.id), true)}
                onCollapse={(_event, treeItem) => onGroupToggle(String(treeItem.id), false)}
            />
        </div>
    );
};

export default ExplorerTree;
