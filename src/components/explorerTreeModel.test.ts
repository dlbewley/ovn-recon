import { viewForLocation } from '../routes';
import {
    buildExplorerTree,
    CLUSTER_ITEM_ID,
    ExplorerTreeInput,
    ExplorerTreeItem,
    flattenTree,
    MORE_NETWORKS_ID,
    NETWORKS_GROUP_ID,
    networkItemId,
    nodeItemId,
    NODES_GROUP_ID,
    selectedItemId,
} from './explorerTreeModel';

const nodes = [
    { name: 'control-0', role: 'control plane' },
    { name: 'worker-1', role: 'worker' },
    { name: 'worker-2', role: '' },
];

const networks = Array.from({ length: 14 }, (_, index) => (index % 2 === 0
    ? { kind: 'cudn' as const, name: `cudn-${index}` }
    : { kind: 'udn' as const, namespace: `team-${index}`, name: `udn-${index}` }));

const input = (overrides: Partial<ExplorerTreeInput> = {}): ExplorerTreeInput => ({
    nodes,
    networks,
    filter: '',
    openGroups: new Set([NODES_GROUP_ID]),
    showAllNetworks: false,
    selectedId: CLUSTER_ITEM_ID,
    limit: 10,
    ...overrides,
});

const group = (items: ExplorerTreeItem[], id: string): ExplorerTreeItem => items.find((item) => item.id === id)!;
const childIds = (items: ExplorerTreeItem[], id: string): string[] =>
    (group(items, id).children ?? []).map((item) => item.id);

describe('explorerTreeModel', () => {
    it('has three roots: Cluster, then Nodes and Networks with their counts', () => {
        const tree = buildExplorerTree(input());
        expect(tree.map((item) => [item.id, item.label, item.count])).toEqual([
            [CLUSTER_ITEM_ID, 'Cluster', undefined],
            [NODES_GROUP_ID, 'Nodes', 3],
            [NETWORKS_GROUP_ID, 'Networks', 14],
        ]);
    });

    it('shows each node with its role and each network with its kind and namespace', () => {
        const tree = buildExplorerTree(input({ showAllNetworks: true }));
        expect(group(tree, NODES_GROUP_ID).children!.map((item) => [item.label, item.detail, item.node])).toEqual([
            ['control-0', 'control plane', 'control-0'],
            ['worker-1', 'worker', 'worker-1'],
            ['worker-2', undefined, 'worker-2'],
        ]);
        const [first, second] = group(tree, NETWORKS_GROUP_ID).children!;
        expect([first.label, first.detail, first.network]).toEqual(['cudn-0', 'CUDN', { kind: 'cudn', name: 'cudn-0' }]);
        expect([second.label, second.detail, second.network]).toEqual([
            'team-1/udn-1', 'UDN', { kind: 'udn', namespace: 'team-1', name: 'udn-1' },
        ]);
    });

    it('keeps the networks in the order handed over, capped with "Show N more"', () => {
        const ids = childIds(buildExplorerTree(input()), NETWORKS_GROUP_ID);
        expect(ids).toHaveLength(11);
        expect(ids.slice(0, 10)).toEqual(networks.slice(0, 10).map(networkItemId));
        const more = group(buildExplorerTree(input()), NETWORKS_GROUP_ID).children![10];
        expect([more.id, more.kind, more.label, more.hidden]).toEqual([MORE_NETWORKS_ID, 'more', 'Show 4 more', 4]);
    });

    it('lists every network once the user asks, and when there are no more than the cap', () => {
        expect(childIds(buildExplorerTree(input({ showAllNetworks: true })), NETWORKS_GROUP_ID))
            .toEqual(networks.map(networkItemId));
        expect(childIds(buildExplorerTree(input({ limit: 14 })), NETWORKS_GROUP_ID))
            .toEqual(networks.map(networkItemId));
    });

    it('always lists the selected network, even past the cap', () => {
        const selectedId = networkItemId(networks[12]);
        const tree = buildExplorerTree(input({ selectedId }));
        const ids = childIds(tree, NETWORKS_GROUP_ID);
        expect(ids.slice(10)).toEqual([selectedId, MORE_NETWORKS_ID]);
        expect(group(tree, NETWORKS_GROUP_ID).children![11].label).toBe('Show 3 more');
        // And the group opens to show it.
        expect(group(tree, NETWORKS_GROUP_ID).expanded).toBe(true);
    });

    it('opens the groups the user opened, and a group holding the selection', () => {
        const tree = buildExplorerTree(input());
        expect(group(tree, NODES_GROUP_ID).expanded).toBe(true);
        expect(group(tree, NETWORKS_GROUP_ID).expanded).toBe(false);

        const closed = buildExplorerTree(input({ openGroups: new Set(), selectedId: nodeItemId('worker-1') }));
        expect(group(closed, NODES_GROUP_ID).expanded).toBe(true);
        expect(group(closed, NETWORKS_GROUP_ID).expanded).toBe(false);
    });

    it('filters node and network names, opens both groups, counts what matched and lifts the cap', () => {
        const tree = buildExplorerTree(input({ filter: '  WORKER ', openGroups: new Set() }));
        expect(childIds(tree, NODES_GROUP_ID)).toEqual([nodeItemId('worker-1'), nodeItemId('worker-2')]);
        expect(group(tree, NODES_GROUP_ID).count).toBe(2);
        expect(childIds(tree, NETWORKS_GROUP_ID)).toEqual([]);
        expect(group(tree, NETWORKS_GROUP_ID).count).toBe(0);
        expect(tree.filter((item) => item.kind === 'group').every((item) => item.expanded)).toBe(true);
        expect(tree[0].id).toBe(CLUSTER_ITEM_ID);

        const byNamespace = buildExplorerTree(input({ filter: 'team-1' }));
        // team-1, team-11 and team-13, uncapped.
        expect(childIds(byNamespace, NETWORKS_GROUP_ID)).toEqual([1, 11, 13].map((index) => networkItemId(networks[index])));
        expect(childIds(buildExplorerTree(input({ filter: '-' })), NETWORKS_GROUP_ID)).toHaveLength(14);
    });

    it('gives every item a unique id', () => {
        const ids = flattenTree(buildExplorerTree(input())).map((item) => item.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    describe('selectedItemId', () => {
        const select = (url: string): string | null => {
            const [pathname, search] = url.split('?');
            return selectedItemId(viewForLocation({ pathname, search: search ? `?${search}` : '' }));
        };

        it('selects Cluster on every cluster tab', () => {
            ['/ovn-recon', '/ovn-recon/networks', '/ovn-recon/findings', '/ovn-recon/ovn', '/ovn-recon/search?q=10.0.0.1']
                .forEach((url) => expect(select(url)).toBe(CLUSTER_ITEM_ID));
        });

        it('selects the node on every node view, the construct page included', () => {
            ['/ovn-recon/node-network-state/worker-1', '/ovn-recon/ovn/worker-1', '/ovn-recon/ovn/worker-1/switch/join']
                .forEach((url) => expect(select(url)).toBe(nodeItemId('worker-1')));
        });

        it('selects the network, matching the ids the tree gives networks', () => {
            expect(select('/ovn-recon/networks/cudn/cudn-0')).toBe(networkItemId(networks[0]));
            expect(select('/ovn-recon/networks/udn/team-1/udn-1')).toBe(networkItemId(networks[1]));
            expect(select('/ovn-recon/networks/nad/default/br-ex')).toBe('network:nad/default/br-ex');
        });

        it('selects nothing on a path OVN Recon does not serve', () => {
            expect(select('/ovn-recon/nope')).toBeNull();
        });
    });
});
