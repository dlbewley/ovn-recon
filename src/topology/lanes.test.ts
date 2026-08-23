import fs from 'fs';
import path from 'path';

import { buildGraphContext, GraphContext } from './context';
import { laneOrderingInput, layoutLanes, LaneViewState, PlacedNode } from './lanes';
import { descriptorFor } from './descriptors';
import { ClusterUserDefinedNetwork, NodeNetworkState } from '../types';

const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

const ctx: GraphContext = buildGraphContext({
    nns: fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json'),
    cudns: fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json')
});



const METRICS = { padding: 20, itemHeight: 80, itemGap: 20, colSpacing: 220 };
const VIEW: LaneViewState = { showHiddenColumns: false, showNads: false, showLldp: false };

const layout = (view: Partial<LaneViewState> = {}, on: GraphContext = ctx) =>
    layoutLanes(on, { ...VIEW, ...view }, METRICS, {}, () => null);

const laneIds = (view: Partial<LaneViewState> = {}) =>
    layout(view).lanes.map(({ lane }) => lane.id);

describe('lane visibility', () => {
    it('hides empty lanes and the logical lane by default', () => {
        // The node has no bonds, so that lane is absent; the logical lane is populated
        // but hidden regardless. See ovn-recon-x23.
        expect(laneIds()).toEqual(['eth', 'vlan', 'bridge', 'l3', 'networks', 'attachments']);
    });

    it('shows every lane, empty or not, when nothing is hidden', () => {
        expect(laneIds({ showHiddenColumns: true })).toEqual([
            'eth', 'bond', 'vlan', 'bridge', 'logical', 'l3', 'networks', 'attachments'
        ]);
    });

    it('gates the NAD lane on its toggle rather than on being populated', () => {
        expect(laneIds()).not.toContain('nads');
        expect(laneIds({ showNads: true })).toContain('nads');
    });

    it('keeps the attachments lane even when it is empty', () => {
        // Its header is drawn unconditionally, so the lane must reserve its column.
        const bare = buildGraphContext({ nns: fixture<NodeNetworkState>('nns', 'basic-host.json') });
        const result = layout({}, bare);
        expect(result.lanes.map(({ lane }) => lane.id)).toContain('attachments');
    });
});

describe('lane placement', () => {
    it('spaces visible lanes evenly, with no gap for an absent lane', () => {
        const xs = layout().lanes.map(({ x }) => x);
        expect(xs).toEqual([20, 240, 460, 680, 900, 1120]);
    });

    it('stacks nodes within a lane from the top', () => {
        const eth = layout().lanes.find(({ lane }) => lane.id === 'eth')!;
        const ys = eth.groups[0].nodes.map((n) => n.y);
        expect(ys).toEqual([20, 120, 220, 320]);
    });

    it('writes one position per node, shared with the connectors', () => {
        const result = layout();
        result.lanes.forEach(({ groups }) => groups.forEach(({ nodes }) => nodes.forEach((node) => {
            expect(result.positions[node.id]).toEqual({ x: node.x, y: node.y });
        })));
    });
});

describe('the Layer 3 lane carries two groups', () => {
    it('stacks bridge mappings above VRFs, each under its own sub-header', () => {
        const l3 = layout().lanes.find(({ lane }) => lane.id === 'l3')!;

        expect(l3.groups.map((g) => g.title)).toEqual(['Bridge Mappings', 'VRFs']);
        expect(l3.groups[0].nodes.map((n) => n.id)).toEqual(['ovn:physnet', 'ovn:physnet-vmdata']);
        expect(l3.groups[1].nodes.map((n) => n.id)).toEqual(['vrf:example-p-cudn']);
    });

    it('leaves a gap between the groups for the second sub-header', () => {
        const l3 = layout().lanes.find(({ lane }) => lane.id === 'l3')!;
        const lastMapping = l3.groups[0].nodes.at(-1)!;
        const firstVrf = l3.groups[1].nodes[0];

        // Standard spacing is itemHeight + itemGap; the sub-header adds 40 on top.
        expect(firstVrf.y - lastMapping.y).toBe(80 + 20 + 40);
    });

    it('omits the gap when the first group is empty', () => {
        // A node with a VRF and no bridge mappings should not indent its VRFs.
        const vrfOnly = buildGraphContext({
            nns: fixture<NodeNetworkState>('nns', 'vrf-mixed-routes.json')
        });
        const result = layout({}, vrfOnly);
        const l3 = result.lanes.find(({ lane }) => lane.id === 'l3')!;

        expect(l3.groups[0].nodes).toHaveLength(0);
        expect(l3.groups[1].nodes[0].y).toBe(METRICS.padding);
    });
});

describe('custom layout', () => {
    it('hands placement to the caller for lanes that do not stack', () => {
        const placed: PlacedNode[] = [{
            id: 'lldp:eno1/0', item: {}, descriptor: descriptorFor('lldp-neighbor')!,
            laneId: 'lldp', x: 20, y: 999, height: 80, color: '#2E7D32'
        }];
        const result = layoutLanes(
            ctx, { ...VIEW, showLldp: true }, METRICS, {},
            (laneId, x) => (laneId === 'lldp' ? placed.map((n) => ({ ...n, x })) : null)
        );

        expect(result.positions['lldp:eno1/0'].y).toBe(999);
    });
});

describe('ordering input is derived from the same table', () => {
    it('lists every lane with the ids it holds', () => {
        const { lanes: ordered } = laneOrderingInput(ctx, VIEW);
        const l3 = ordered.find((l) => l.id === 'l3')!;

        expect(l3.nodeIds).toEqual(['ovn:physnet', 'ovn:physnet-vmdata', 'vrf:example-p-cudn']);
    });

    it('assigns a group rank from position within the lane, not by name', () => {
        // VRFs sort below bridge mappings because they are the second group, which used
        // to be expressed as a hand-written rule naming VRFs and UDNs.
        const { groupRankById } = laneOrderingInput(ctx, VIEW);

        expect(groupRankById['vrf:example-p-cudn']).toBe(1);
        expect(groupRankById['ovn:physnet']).toBeUndefined();
    });

    it('reflects the view state, so a hidden lane contributes nothing', () => {
        const hidden = laneOrderingInput(ctx, VIEW).lanes.find((l) => l.id === 'nads')!;
        const shown = laneOrderingInput(ctx, { ...VIEW, showNads: true })
            .lanes.find((l) => l.id === 'nads')!;

        expect(hidden.nodeIds).toEqual([]);
        expect(shown.nodeIds.length).toBe(ctx.nads.length);
    });
});
