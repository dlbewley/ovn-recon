import { ConstructRole, LogicalTier } from './logicalClassification';
import { emptyLadderAggregates, LadderConstruct, LadderEdge, LadderModel } from './logicalLadderModel';
import { layoutLadder } from './logicalLadderLayout';
import {
    EDGE_LABEL_CHAR_WIDTH,
    edgeLabel,
    edgeLabelSegments,
    layoutEdgeLabels,
    shortenName,
    wrapSegments,
} from './logicalLadderLabels';

describe('shortenName', () => {
    const layer2Switch = 'cluster_udn_example.evpn.vni10010_ovn_layer2_switch';
    const transitRouter = 'cluster_udn_example.evpn.vni10010_transit_router';

    it('leaves a name that fits unchanged', () => {
        expect(shortenName('ovn_cluster_router', 30)).toBe('ovn_cluster_router');
        expect(shortenName('join', 30)).toBe('join');
        const exactly30 = 'a'.repeat(30);
        expect(shortenName(exactly30, 30)).toBe(exactly30);
    });

    it('never returns more than the budget', () => {
        for (const name of [layer2Switch, transitRouter, 'x'.repeat(200), 'GR_a_b_c_d_e_f_g_h_i_j_k_l_m_n_o_p_q']) {
            for (const max of [1, 2, 8, 30, 34]) {
                expect(shortenName(name, max).length).toBeLessThanOrEqual(max);
            }
        }
    });

    it('keeps the role-bearing suffix and drops the middle', () => {
        expect(shortenName(layer2Switch, 30)).toBe('cluster_udn_exa…_layer2_switch');
        expect(shortenName(transitRouter, 30)).toBe('cluster_udn_ex…_transit_router');
        expect(shortenName('demo.mirror_example.l3.udn_ovn_cluster_router', 30)).toBe(
            'demo.mirror_ex…_cluster_router',
        );
    });

    it('keeps two names that share a long prefix distinguishable', () => {
        // The regression: cutting the end left both reading as their shared prefix.
        expect(layer2Switch.slice(0, 29)).toBe(transitRouter.slice(0, 29));
        const shortSwitch = shortenName(layer2Switch, 30);
        const shortRouter = shortenName(transitRouter, 30);
        expect(shortSwitch).not.toBe(shortRouter);
        expect(shortSwitch.endsWith('_layer2_switch')).toBe(true);
        expect(shortRouter.endsWith('_transit_router')).toBe(true);
    });

    it('keeps the node of a node-replicated construct', () => {
        const worker1 = shortenName('GR_cluster_udn_example.p.cudn_worker-1', 30);
        const worker2 = shortenName('GR_cluster_udn_example.p.cudn_worker-2', 30);
        expect(worker1).toBe('GR_cluster_udn_examp…_worker-1');
        expect(worker2.endsWith('_worker-2')).toBe(true);
        expect(worker1).not.toBe(worker2);
    });

    it('leaves no separator dangling before the ellipsis', () => {
        // The head would end on the dot after "l3".
        expect(shortenName('demo.mirror_example.l3.udn_worker-1', 30)).toBe('demo.mirror_example…_worker-1');
    });

    it('splits evenly around the ellipsis when there is no underscore boundary', () => {
        expect(shortenName('abcdefghijklmnopqrstuvwxyz', 11)).toBe('abcde…vwxyz');
    });
});

const edge = (overrides: Partial<LadderEdge>): LadderEdge => ({
    id: 'edge',
    source: 'a',
    target: 'b',
    kind: 'router-link',
    role: 'link',
    networks: [],
    ...overrides,
});

describe('edgeLabel', () => {
    it('annotates each interconnect address and marks the far end', () => {
        const interconnect = edge({
            kind: 'router-peer',
            role: 'interconnect',
            networks: ['198.51.100.5/24', '192.0.2.11/31'],
            peerNetworks: ['192.0.2.10/31'],
        });
        expect(edgeLabelSegments(interconnect)).toEqual([
            'interconnect ·',
            'router 198.51.100.5/24',
            'p2p 192.0.2.11/31',
            '⇄ p2p 192.0.2.10/31',
        ]);
        expect(edgeLabel(interconnect)).toBe(
            'interconnect · router 198.51.100.5/24 p2p 192.0.2.11/31 ⇄ p2p 192.0.2.10/31',
        );
    });

    it('labels a router link with its role and addresses', () => {
        expect(edgeLabel(edge({ role: 'gateway', networks: ['192.0.2.1/24', '2001:db8::1/64'] }))).toBe(
            'gateway · 192.0.2.1/24 2001:db8::1/64',
        );
    });

    it('shows a bare role, bare addresses, or nothing', () => {
        expect(edgeLabel(edge({ kind: 'localnet-link', role: 'localnet' }))).toBe('localnet');
        expect(edgeLabel(edge({ kind: 'localnet-link', role: 'localnet', networks: ['VLAN 100'] }))).toBe(
            'localnet · VLAN 100',
        );
        expect(edgeLabel(edge({ networks: ['192.0.2.1/24'] }))).toBe('192.0.2.1/24');
        expect(edgeLabel(edge({}))).toBe('');
        expect(edgeLabelSegments(edge({}))).toEqual([]);
    });

    it('does not mark a far end that stands alone', () => {
        expect(edgeLabel(edge({ kind: 'router-peer', role: 'interconnect', peerNetworks: ['192.0.2.10/31'] }))).toBe(
            'interconnect · p2p 192.0.2.10/31',
        );
    });
});

describe('wrapSegments', () => {
    const segments = ['interconnect ·', 'router 198.51.100.5/24', 'p2p 192.0.2.11/31', '⇄ p2p 192.0.2.10/31'];

    it('keeps a label that fits on one line', () => {
        expect(wrapSegments(segments, 80)).toEqual([segments.join(' ')]);
    });

    it('breaks only between segments', () => {
        expect(wrapSegments(segments, 45)).toEqual([
            'interconnect · router 198.51.100.5/24',
            'p2p 192.0.2.11/31 ⇄ p2p 192.0.2.10/31',
        ]);
        expect(wrapSegments(segments, 22)).toEqual(segments);
    });

    it('shortens a segment longer than a line, so no line exceeds the limit', () => {
        const fullLength = 'router 2001:0db8:0000:0000:0000:0000:0000:0001/64';
        const lines = wrapSegments(['interconnect ·', fullLength], 30);
        expect(lines).toHaveLength(2);
        expect(lines[1]).toContain('…');
        expect(lines[1].endsWith('/64')).toBe(true);
        for (const line of lines) {
            expect(line.length).toBeLessThanOrEqual(30);
        }
    });

    it('wraps nothing into nothing', () => {
        expect(wrapSegments([], 45)).toEqual([]);
    });
});

const makeConstruct = (
    uuid: string,
    role: ConstructRole,
    tier: LogicalTier,
    network: string,
    node?: string,
): LadderConstruct => ({
    uuid,
    name: uuid,
    kind: role.includes('router') ? 'router' : 'switch',
    role,
    tier,
    network,
    node,
    ...emptyLadderAggregates(),
});

const modelOf = (constructs: LadderConstruct[], edges: LadderEdge[]): LadderModel => ({
    constructs,
    constructByUuid: new Map(constructs.map((construct) => [construct.uuid, construct])),
    edges,
    networks: [...new Set(['default', ...constructs.map((construct) => construct.network)])],
});

describe('layoutEdgeLabels', () => {
    // Two single-column bands side by side, each with a long interconnect
    // label on the same row: the collision the wrapping exists to prevent.
    const networks = ['blue_net', 'green_net'];
    const constructs = [
        makeConstruct('default-router', 'cluster-router', 'cluster-routing', 'default'),
        ...networks.flatMap((network) => [
            makeConstruct(`${network}-gr`, 'gateway-router', 'gateway', network, 'worker-1'),
            makeConstruct(`${network}-tr`, 'transit-router', 'cluster-routing', network),
        ]),
    ];
    const edges = networks.map((network, index) =>
        edge({
            id: `peer:${network}`,
            source: `${network}-gr`,
            target: `${network}-tr`,
            kind: 'router-peer',
            role: 'interconnect',
            networks: [`198.51.100.${index + 5}/24`, `192.0.2.${index * 2 + 11}/31`],
            peerNetworks: [`192.0.2.${index * 2 + 10}/31`],
        }),
    );
    const model = modelOf(constructs, edges);
    const layout = layoutLadder(model);
    const boxes = layoutEdgeLabels(model.edges, layout);
    const bandOf = (network: string) => layout.bands.find((band) => band.network === network)!;

    it('wraps a label wider than its band and keeps the box inside', () => {
        for (const network of networks) {
            const box = boxes.get(`peer:${network}`)!;
            const band = bandOf(network);
            expect(box.network).toBe(network);
            // One line would overrun the band on both sides.
            expect(edgeLabel(edges[networks.indexOf(network)]).length * EDGE_LABEL_CHAR_WIDTH).toBeGreaterThan(
                band.width,
            );
            expect(box.lines.length).toBeGreaterThan(1);
            expect(box.x).toBeGreaterThanOrEqual(band.x);
            expect(box.x + box.width).toBeLessThanOrEqual(band.x + band.width);
        }
    });

    it('keeps labels of neighbouring bands apart', () => {
        const [blue, green] = networks.map((network) => boxes.get(`peer:${network}`)!);
        // Same row...
        expect(blue.y).toBe(green.y);
        // ...so only horizontal separation keeps them from running together.
        expect(blue.x + blue.width).toBeLessThan(green.x);
    });

    it('centers a label that fits on its edge midpoint, where a one-line label has always sat', () => {
        const short = edge({ id: 'short', source: 'blue_net-gr', target: 'blue_net-tr', role: 'join', networks: ['192.0.2.1/24'] });
        const box = layoutEdgeLabels([short], layout).get('short')!;
        const source = layout.positions['blue_net-gr'];
        const target = layout.positions['blue_net-tr'];
        expect(box.lines).toEqual(['join · 192.0.2.1/24']);
        expect(box.x + box.width / 2).toBe((source.x + target.x) / 2);
        expect(box.firstBaseline).toBe((source.y + target.y) / 2 - 4);
    });

    it('slides a label inward when its edge runs close to the band border', () => {
        // A wide band whose leftmost column carries a long one-line label.
        const fleet = ['worker-1', 'worker-2'].flatMap((node) => [
            makeConstruct(`ext-${node}`, 'external-switch', 'external', 'default', node),
            makeConstruct(`gr-${node}`, 'gateway-router', 'gateway', 'default', node),
        ]);
        const long = edge({
            id: 'long',
            source: 'ext-worker-1',
            target: 'gr-worker-1',
            role: 'external',
            networks: ['192.0.2.10/24', '198.51.100.10/24', '203.0.113.10/24', '2001:db8::10/64'],
        });
        const wideLayout = layoutLadder(modelOf(fleet, [long]));
        const band = wideLayout.bands[0];
        const box = layoutEdgeLabels([long], wideLayout).get('long')!;
        const midX = wideLayout.positions['ext-worker-1'].x;

        expect(box.lines).toHaveLength(1);
        // Centered on the edge it would start left of the band.
        expect(midX - box.width / 2).toBeLessThan(band.x);
        expect(box.x).toBeGreaterThanOrEqual(band.x);
        expect(box.x + box.width).toBeLessThanOrEqual(band.x + band.width);
    });

    it('gives no box to an unlabelled edge or one with an unplaced endpoint', () => {
        const unlabelled = edge({ id: 'unlabelled', source: 'blue_net-gr', target: 'blue_net-tr' });
        const dangling = edge({ id: 'dangling', source: 'blue_net-gr', target: 'missing', role: 'join' });
        expect(layoutEdgeLabels([unlabelled, dangling], layout).size).toBe(0);
    });
});
