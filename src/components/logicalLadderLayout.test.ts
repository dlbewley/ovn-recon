import { LogicalDatabase, LogicalTopologySnapshot } from '../types';
import { ConstructRole, LogicalTier } from './logicalClassification';
import { buildLadderModel, LadderConstruct, LadderModel } from './logicalLadderModel';
import {
    layoutLadder,
    networkColorIndex,
    NETWORK_PALETTE_SIZE,
    TIER_ORDER,
} from './logicalLadderLayout';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';

const database = (cnv1 as unknown as LogicalTopologySnapshot).database as LogicalDatabase;

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
    podPortCount: 0,
    podPorts: [],
    localnetPorts: [],
    remotePeers: [],
    natCount: 0,
    staticRouteCount: 0,
    natRules: [],
    staticRouteRules: [],
});

const syntheticModel = (constructs: LadderConstruct[]): LadderModel => ({
    constructs,
    constructByUuid: new Map(constructs.map((construct) => [construct.uuid, construct])),
    edges: [],
    networks: [...new Set(['default', ...constructs.map((construct) => construct.network)])],
});

describe('layoutLadder on the captured cnv-1 zone', () => {
    const model = buildLadderModel(database);
    const layout = layoutLadder(model);

    it('orders tiers north to south', () => {
        for (let i = 1; i < TIER_ORDER.length; i += 1) {
            expect(layout.tierY[TIER_ORDER[i]]).toBeGreaterThan(layout.tierY[TIER_ORDER[i - 1]]);
        }
    });

    it('puts the default network band first and leftmost', () => {
        expect(layout.bands[0].network).toBe('default');
        expect(layout.bands[0].colorIndex).toBe(0);
        for (let i = 1; i < layout.bands.length; i += 1) {
            expect(layout.bands[i].x).toBeGreaterThan(layout.bands[i - 1].x + layout.bands[i - 1].width);
        }
    });

    it('places every construct inside its network band at its tier row', () => {
        expect(layout.aggregates).toHaveLength(0);
        const bandByNetwork = new Map(layout.bands.map((band) => [band.network, band]));
        for (const construct of model.constructs) {
            const position = layout.positions[construct.uuid];
            expect(position).toBeDefined();
            expect(position.y).toBe(layout.tierY[construct.tier]);
            const band = bandByNetwork.get(construct.network);
            expect(band).toBeDefined();
            if (!band) continue;
            expect(position.x).toBeGreaterThan(band.x);
            expect(position.x).toBeLessThan(band.x + band.width);
        }
    });

    it('renders a Localnet network as a single-rung band', () => {
        const localnetConstructs = model.constructs.filter(
            (construct) => construct.network === 'cluster_udn_machinenet',
        );
        expect(localnetConstructs).toHaveLength(1);
        expect(localnetConstructs[0].tier).toBe('workload-switch');
        expect(layout.bands.map((band) => band.network)).toContain('cluster_udn_machinenet');
    });

    it('is deterministic', () => {
        expect(layoutLadder(model)).toEqual(layout);
    });
});

describe('aggregation threshold', () => {
    const gatewayFleet = [
        ...['n1', 'n2', 'n3', 'n4', 'n5', 'n6'].map((node) =>
            makeConstruct(`gr-${node}`, 'gateway-router', 'gateway', 'default', node),
        ),
        makeConstruct('join', 'join-switch', 'waist', 'default'),
    ];

    it('collapses a role group past the threshold into one aggregate chip', () => {
        const layout = layoutLadder(syntheticModel(gatewayFleet));
        expect(layout.aggregates).toHaveLength(1);
        expect(layout.aggregates[0]).toMatchObject({
            role: 'gateway-router',
            network: 'default',
            tier: 'gateway',
            count: 6,
        });
        for (const member of layout.aggregates[0].memberUuids) {
            expect(layout.positions[member]).toBeUndefined();
        }
        expect(layout.positions['join']).toBeDefined();
    });

    it('expands a collapsed group on demand', () => {
        const collapsed = layoutLadder(syntheticModel(gatewayFleet));
        expect(collapsed.aggregates).toHaveLength(1);
        const expanded = layoutLadder(syntheticModel(gatewayFleet), {
            expandedGroupIds: new Set([collapsed.aggregates[0].id]),
        });
        expect(expanded.aggregates).toHaveLength(0);
        for (const member of collapsed.aggregates[0].memberUuids) {
            expect(expanded.positions[member]).toBeDefined();
        }
    });

    it('keeps individual placement under a raised threshold', () => {
        const layout = layoutLadder(syntheticModel(gatewayFleet), { aggregateThreshold: 10 });
        expect(layout.aggregates).toHaveLength(0);
        const xs = gatewayFleet
            .filter((construct) => construct.role === 'gateway-router')
            .map((construct) => layout.positions[construct.uuid].x);
        expect(new Set(xs).size).toBe(6);
        expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    });
});

describe('networkColorIndex', () => {
    it('reserves slot 0 for the default network', () => {
        expect(networkColorIndex('default', true)).toBe(0);
    });

    it('assigns stable non-default slots within the palette', () => {
        const index = networkColorIndex('cluster_udn_example-p-cudn', false);
        expect(index).toBe(networkColorIndex('cluster_udn_example-p-cudn', false));
        expect(index).toBeGreaterThanOrEqual(1);
        expect(index).toBeLessThan(NETWORK_PALETTE_SIZE);
    });
});
