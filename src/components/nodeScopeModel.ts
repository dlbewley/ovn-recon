import {
    constructDetailPath,
    ExplorerView,
    nodeFindingsPath,
    nodeLogicalPath,
    nodePhysicalPath,
    nodeRoutesPath,
} from '../routes';
import { constructNameForNode, isDetailKind, isDetailTab } from './constructDetailLinks';
import { parseConstructSelectValue } from './useSelectParam';

/**
 * The explorer's node scope, as data (ovn-recon-gbr.5). Pure: which tabs a node has
 * and where each goes, which one a location shows, and where the node switcher goes
 * when another node is picked.
 */

export type NodeView = Extract<ExplorerView, { scope: 'node' }>;

/** The tabs the node scope draws. The construct page is part of Logical topology. */
export type NodeTabKey = 'physical' | 'logical' | 'routes' | 'findings';

export interface NodeTabLink {
    key: NodeTabKey;
    title: string;
    path: string;
    /** The Findings tab's badge, once known. */
    count?: number;
}

/** The tab a node view shows as active. */
export const activeNodeTab = (view: NodeView): NodeTabKey | null => {
    switch (view.tab) {
        case 'physical':
        case 'routes':
        case 'findings':
            return view.tab;
        case 'logical':
        case 'construct':
            return 'logical';
        default:
            return null;
    }
};

/**
 * A node's tabs, each a link to its own URL. Switching tab keeps the node and drops
 * the graph selection: a physical graph id and a logical KIND:NAME name different
 * things. Logical topology is offered while the collector is on, and always while it
 * is the tab on screen, so its gate state can say why it is empty. Findings is always
 * there (ovn-recon-gbr.7), reading 0 when the node has none; `findings` is undefined
 * while that is not known (the NodeNetworkStates are loading, or could not be read).
 */
export const nodeTabs = (
    node: string,
    showLogical: boolean,
    active: NodeTabKey | null,
    findings?: number,
): NodeTabLink[] => {
    const tabs: NodeTabLink[] = [{ key: 'physical', title: 'Physical topology', path: nodePhysicalPath(node) }];
    if (showLogical || active === 'logical') {
        tabs.push({ key: 'logical', title: 'Logical topology', path: nodeLogicalPath(node) });
    }
    tabs.push({ key: 'routes', title: 'Routes', path: nodeRoutesPath(node) });
    tabs.push({ key: 'findings', title: 'Findings', path: nodeFindingsPath(node), ...(findings === undefined ? {} : { count: findings }) });
    return tabs;
};

/**
 * Where the node switcher goes for another node: the same tab of that node, with
 * the selection carried over where it names the same thing there.
 *
 * - Physical: the graph id (`iface:br-ex`, ...) as it is; ids name interfaces and
 *   networks, which recur from node to node.
 * - Logical: a per-node construct (the node switch, `GR_<node>`, `ext_<node>`) is
 *   renamed for the new node, as the construct page's own node select does; a
 *   cluster-wide one (`join`, `ovn_cluster_router`) keeps its name.
 * - Construct page: the same construct in the new node's zone, on the same tab. The
 *   tab's filter and expanded port belong to the old zone's rows and are dropped.
 */
export const nodeSwitchPath = (view: NodeView, toNode: string): string => {
    const fromNode = view.params.node;
    const { select, kind, name, detailTab } = view.params;
    switch (view.tab) {
        case 'physical':
            return nodePhysicalPath(toNode, select);
        case 'logical': {
            const construct = select ? parseConstructSelectValue(select) : null;
            return nodeLogicalPath(
                toNode,
                construct ? { kind: construct.kind, name: constructNameForNode(construct.name, fromNode, toNode) } : undefined,
            );
        }
        case 'routes':
            return nodeRoutesPath(toNode);
        case 'findings':
            return nodeFindingsPath(toNode);
        case 'construct':
            if (isDetailKind(kind) && name) {
                return constructDetailPath(toNode, kind, constructNameForNode(name, fromNode, toNode), {
                    tab: isDetailTab(detailTab) ? detailTab : undefined,
                });
            }
            return nodeLogicalPath(toNode);
        default:
            return nodePhysicalPath(toNode);
    }
};
