import * as React from 'react';
import { SearchInput, Switch, TreeView, TreeViewDataItem } from '@patternfly/react-core';

import type { SeverityCounts } from '../insights/selectors';
import { describeCounts, SeverityIcon } from '../insights/ui/FindingsViews';
import {
    buildExplorerTree,
    ExplorerTreeItem,
    ExplorerTreeNetwork,
    ExplorerTreeNode,
    flattenTree,
    treeHasFindings,
} from './explorerTreeModel';

/**
 * The explorer's tree (ovn-recon-gbr.4): a name filter over a PatternFly TreeView of
 * Cluster, Nodes and Networks. Draws `explorerTreeModel`; what selecting an item
 * does, and which groups are open, are the shell's, so they survive the tree being
 * collapsed to its rail and drawn again.
 *
 * Findings (ovn-recon-gbr.7): an item with findings ends in its worst severity's icon
 * and how many it has; "With findings only" is offered while anything has findings.
 */

/** Shrinks to an ellipsis rather than pushing the badge out of the row. */
const shrinkable: React.CSSProperties = {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
};

const subtle: React.CSSProperties = {
    ...shrinkable,
    color: 'var(--pf-t--global--text--color--subtle)',
    marginInlineStart: 'var(--pf-t--global--spacer--sm)',
    fontSize: 'var(--pf-t--global--font--size--sm)',
    // The role or kind gives way well before the name.
    flex: '0 100 auto',
};

/**
 * One line per item, at any tree width: the row's text box may shrink (PatternFly
 * sizes it to its content), so a long name or role ends in an ellipsis and a
 * findings badge stays in view. At the default 240 px "ctrl-1 control plane" alone
 * fills the row.
 */
const TREE_ROW_STYLE = '[data-testid="explorer-tree"] .pf-v6-c-tree-view__node-text { min-width: 0; overflow: hidden; }';

/**
 * An item's findings: the worst severity's icon and the total, read out in full. Kept
 * to an icon and a number so it fits beside a name and its role at the tree's width.
 */
const FindingsBadge: React.FC<{ id: string; counts: SeverityCounts }> = ({ id, counts }) => {
    const label = describeCounts(counts);
    return (
        <span
            data-testid={`explorer-tree-findings-${id}`}
            title={label}
            style={{
                flex: 'none',
                marginInlineStart: 'var(--pf-t--global--spacer--sm)',
                fontSize: 'var(--pf-t--global--font--size--sm)',
                ...(counts.warning > 0 ? {} : { color: 'var(--pf-t--global--text--color--subtle)' }),
            }}
        >
            <SeverityIcon severity={counts.warning > 0 ? 'warning' : 'info'} />
            <span aria-hidden> {counts.total}</span>
            <span className="pf-v6-screen-reader">{`, ${label}`}</span>
        </span>
    );
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
    /** "With findings only" is on. */
    findingsOnly: boolean;
    onFindingsOnlyChange: (on: boolean) => void;
    /** A leaf was chosen: Cluster, a node, a network, or "Show N more". */
    onSelectItem: (item: ExplorerTreeItem) => void;
}

/** The model's item as TreeView data; `id` carries everything back to the model. */
const toTreeData = (item: ExplorerTreeItem): TreeViewDataItem => ({
    id: item.id,
    name: (
        // One line per item: a role or kind wrapping under the name doubles the row.
        <span
            data-testid={`explorer-tree-${item.id}`}
            title={item.detail ? `${item.label} (${item.detail})` : item.label}
            style={{ display: 'flex', alignItems: 'baseline', minWidth: 0, whiteSpace: 'nowrap' }}
        >
            <span style={{ ...shrinkable, flex: '0 1 auto' }}>
                {item.kind === 'more' ? <em>{item.label}</em> : item.label}
            </span>
            {item.detail && <span style={subtle}>{item.detail}</span>}
            {item.findings && <FindingsBadge id={item.id} counts={item.findings} />}
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
    findingsOnly,
    onFindingsOnlyChange,
    onSelectItem,
}) => {
    const items = React.useMemo(
        () => buildExplorerTree({ nodes, networks, filter, openGroups, showAllNetworks, selectedId, findingsOnly }),
        [nodes, networks, filter, openGroups, showAllNetworks, selectedId, findingsOnly],
    );
    const offerFindingsOnly = React.useMemo(() => treeHasFindings(nodes, networks), [nodes, networks]);
    const byId = React.useMemo(() => new Map(flattenTree(items).map((item) => [item.id, item])), [items]);
    const data = React.useMemo(() => items.map(toTreeData), [items]);
    const active = React.useMemo(
        () => (selectedId && byId.has(selectedId) ? [{ id: selectedId, name: '' }] : []),
        [selectedId, byId],
    );

    return (
        <div data-testid="explorer-tree">
            <style>{TREE_ROW_STYLE}</style>
            <SearchInput
                aria-label="Filter the tree by name"
                placeholder="Filter by name"
                value={filter}
                onChange={(_event, value) => onFilterChange(value)}
                onClear={() => onFilterChange('')}
            />
            {offerFindingsOnly && (
                <div style={{ marginBlockStart: 'var(--pf-t--global--spacer--sm)' }}>
                    <Switch
                        id="explorer-tree-findings-only"
                        label="With findings only"
                        isChecked={findingsOnly}
                        onChange={(_event, checked) => onFindingsOnlyChange(checked)}
                    />
                </div>
            )}
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
