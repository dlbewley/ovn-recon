import { LogicalDatabase, LogicalTopologySnapshot } from '../types';
import { ConstructRole, LogicalTier } from './logicalClassification';
import { buildLadderModel, emptyLadderAggregates, LadderConstruct, LadderModel } from './logicalLadderModel';
import {
    layoutLadder,
    networkColorIndex,
    NETWORK_PALETTE_SIZE,
    TIER_ORDER,
} from './logicalLadderLayout';
import { EDGE_LABEL_CHAR_WIDTH, edgeLabel, layoutEdgeLabels } from './logicalLadderLabels';
import { mergeZones } from './logicalClusterModel';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';
import cnv2 from '../../collector/fixtures/snapshots/cnv-2.json';
import ctrl1 from '../../collector/fixtures/snapshots/ctrl-1.json';

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
    ...emptyLadderAggregates(),
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

    it('renders a Localnet network as switch plus its bridge-mapping exit', () => {
        const localnetConstructs = model.constructs.filter(
            (construct) => construct.network === 'cluster_udn_machinenet',
        );
        expect(localnetConstructs.map((construct) => construct.tier).sort()).toEqual([
            'physical',
            'workload-switch',
        ]);
        expect(layout.bands.map((band) => band.network)).toContain('cluster_udn_machinenet');
        // The bridge mapping sits north of the switch.
        expect(layout.tierY['physical']).toBeLessThan(layout.tierY['workload-switch']);
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

describe('band colors under filtering', () => {
    const model = buildLadderModel(database);
    const fullLayout = layoutLadder(model);

    const narrowTo = (network: string): LadderModel => {
        const constructs = model.constructs.filter((construct) => construct.network === network);
        return {
            constructs,
            constructByUuid: new Map(constructs.map((construct) => [construct.uuid, construct])),
            edges: model.edges.filter(
                (edge) =>
                    model.constructByUuid.get(edge.source)?.network === network &&
                    model.constructByUuid.get(edge.target)?.network === network,
            ),
            networks: [network],
        };
    };

    it('keeps a non-default network on its palette slot when it is the only band', () => {
        const nonDefault = fullLayout.bands.filter((band) => band.network !== 'default');
        expect(nonDefault.length).toBeGreaterThan(0);
        for (const band of nonDefault) {
            const filtered = layoutLadder(narrowTo(band.network));
            expect(filtered.bands).toHaveLength(1);
            // The regression: a filtered network used to become "first" and
            // inherit the neutral slot 0, turning the band gray.
            expect(filtered.bands[0].colorIndex).toBe(band.colorIndex);
            expect(filtered.bands[0].colorIndex).not.toBe(0);
        }
    });

    it('keeps the default network on the neutral slot when it is the only band', () => {
        const filtered = layoutLadder(narrowTo('default'));
        expect(filtered.bands).toHaveLength(1);
        expect(filtered.bands[0].colorIndex).toBe(0);
    });
});

describe('edge labels stay inside their network band', () => {
    const zones = { 'cnv-1': cnv1, 'cnv-2': cnv2, 'ctrl-1': ctrl1 } as unknown as Record<string, LogicalTopologySnapshot>;
    // Every model the ladder renders from the captured corpus: each zone on
    // its own (the per-node view) and all of them merged (the cluster view).
    const models: Array<[string, LadderModel]> = [
        ...Object.entries(zones).map(([name, snapshot]): [string, LadderModel] => [
            name,
            buildLadderModel(snapshot.database as LogicalDatabase),
        ]),
        ['merged cluster', mergeZones(Object.values(zones))],
    ];

    // Collapsed role groups hide their edges, so also lay out with every
    // group expanded: the widest bands and the most labels.
    const layoutsOf = (model: LadderModel) => {
        const collapsed = layoutLadder(model);
        const expanded = layoutLadder(model, {
            expandedGroupIds: new Set(collapsed.aggregates.map((aggregate) => aggregate.id)),
        });
        return [collapsed, expanded];
    };

    it.each(models)('%s: no label box crosses its band boundary', (_name, model) => {
        for (const layout of layoutsOf(model)) {
            const boxes = layoutEdgeLabels(model.edges, layout);
            const bandByNetwork = new Map(layout.bands.map((band) => [band.network, band]));
            const placedAndLabelled = model.edges.filter(
                (edge) => layout.positions[edge.source] && layout.positions[edge.target] && edgeLabel(edge) !== '',
            );
            expect(placedAndLabelled.length).toBeGreaterThan(0);

            for (const edge of placedAndLabelled) {
                const box = boxes.get(edge.id);
                expect(box).toBeDefined();
                if (!box) continue;

                // The label belongs to the band of the constructs it joins.
                expect(box.network).toBe(model.constructByUuid.get(edge.source)?.network);
                const band = bandByNetwork.get(box.network);
                expect(band).toBeDefined();
                if (!band) continue;

                expect(box.x).toBeGreaterThanOrEqual(band.x);
                expect(box.x + box.width).toBeLessThanOrEqual(band.x + band.width);
                expect(box.y).toBeGreaterThanOrEqual(0);
                expect(box.y + box.height).toBeLessThanOrEqual(layout.height);

                // The box bounds every line, and wrapping loses nothing.
                for (const line of box.lines) {
                    expect(line.length * EDGE_LABEL_CHAR_WIDTH).toBeLessThanOrEqual(box.width);
                }
                expect(box.lines.join(' ')).toBe(edgeLabel(edge));
            }
        }
    });

    it.each(models)('%s: labels of different bands never overlap', (_name, model) => {
        for (const layout of layoutsOf(model)) {
            const boxes = [...layoutEdgeLabels(model.edges, layout).values()];
            for (const a of boxes) {
                for (const b of boxes) {
                    if (a.network === b.network) continue;
                    const apartX = a.x + a.width <= b.x || b.x + b.width <= a.x;
                    const apartY = a.y + a.height <= b.y || b.y + b.height <= a.y;
                    expect(apartX || apartY).toBe(true);
                }
            }
        }
    });

    it('wraps the interconnect label that used to overrun its band', () => {
        const model = buildLadderModel(database);
        const layout = layoutLadder(model);
        const interconnect = model.edges.find((edge) => edge.role === 'interconnect');
        expect(interconnect).toBeDefined();
        if (!interconnect) return;
        const box = layoutEdgeLabels(model.edges, layout).get(interconnect.id);
        const band = layout.bands.find((candidate) => candidate.network === box?.network);
        expect(box).toBeDefined();
        expect(band).toBeDefined();
        if (!box || !band) return;

        // The regression: on one line the label is wider than the whole band.
        expect(edgeLabel(interconnect).length * EDGE_LABEL_CHAR_WIDTH).toBeGreaterThan(band.width);
        expect(box.lines.length).toBeGreaterThan(1);
        expect(box.width).toBeLessThan(band.width);
    });
});
