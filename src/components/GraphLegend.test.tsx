import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { buildGraphContext } from '../topology/context';
import { NODE_TYPES } from '../topology/descriptors';
import { EDGE_KIND_STYLES, PROVENANCE_STYLES } from '../topology/edgeStyles';
import { STATUS_STYLE } from '../topology/palette';
import { ClusterUserDefinedNetwork, LogicalDatabase, LogicalTopologySnapshot, NodeNetworkState } from '../types';
import { LegendButton, LogicalLegend, PhysicalLegend } from './GraphLegend';
import { buildLadderModel } from './logicalLadderModel';
import { LADDER_EDGE_STYLES, ROLE_DESCRIPTIONS } from './LogicalLadderView';
import { buildTopologyEdges } from './nodeVisualizationModel';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';

/**
 * The legends are generated from the registries the canvas draws from
 * (ovn-recon-nt4.2). These hold them to it: every registered kind has its row, and
 * every kind the models actually produce from real captures is registered.
 */
const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

const ALL_LANES = { showHiddenColumns: true, showNads: true, showLldp: true };

describe('graph legends', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const entries = () => Array.from(container.querySelectorAll('[data-legend-entry]'))
        .map((element) => element.getAttribute('data-legend-entry'));

    describe('physical', () => {
        beforeEach(() => act(() => root.render(<PhysicalLegend />)));

        it('has a row for every node kind in the descriptor table, with its accent and icon', () => {
            NODE_TYPES.forEach((descriptor) => {
                const row = container.querySelector(`[data-legend-entry="node:${descriptor.type}"]`);
                expect(row).not.toBeNull();
                expect(row!.textContent).toContain(descriptor.legend.label);
                expect(row!.querySelector('svg')).not.toBeNull();
                expect(row!.querySelector('[data-swatch-accent]')?.getAttribute('data-swatch-accent')).toBe(descriptor.color);
            });
        });

        it('has a row for every edge kind, every provenance and every state', () => {
            const expected = [
                ...Object.keys(EDGE_KIND_STYLES).map((kind) => `edge:${kind}`),
                ...Object.keys(PROVENANCE_STYLES).map((provenance) => `provenance:${provenance}`),
                ...Object.keys(STATUS_STYLE).map((status) => `status:${status}`),
                'findings-badge',
            ];
            expect(entries()).toEqual(expect.arrayContaining(expected));
        });

        it('draws each edge kind with the dash the canvas uses', () => {
            Object.entries(EDGE_KIND_STYLES).forEach(([kind, style]) => {
                const line = container.querySelector(`[data-legend-entry="edge:${kind}"] line`)!;
                expect(line.getAttribute('stroke-dasharray')).toBe(style.dashArray ?? null);
            });
        });

        it('shows the inferred chip and the real findings badge', () => {
            const inferred = container.querySelector('[data-legend-entry="provenance:inferred"]')!;
            expect(inferred.querySelector('.pf-v6-c-label')?.textContent).toBe('inferred');
            const badge = container.querySelector('[data-legend-entry="findings-badge"] [data-testid="findings-badge"]');
            expect(badge?.getAttribute('aria-label')).toBe('1 warning, 1 info finding');
        });

        it('covers every edge kind the model draws from the captured nodes', () => {
            const drawn = new Set<string>();
            ['primary-cudn-vrf', 'bonded-lldp', 'evpn-vxlan', 'sriov', 'kernel-routes'].forEach((name) => {
                const cudnFile = path.join(process.cwd(), 'test', 'fixtures', 'cudn', `${name}.json`);
                const ctx = buildGraphContext({
                    nns: fixture<NodeNetworkState>('nns', `${name}.json`),
                    cudns: fs.existsSync(cudnFile) ? fixture<ClusterUserDefinedNetwork[]>('cudn', `${name}.json`) : []
                });
                buildTopologyEdges(ctx, ALL_LANES).edges.forEach((edge) => {
                    drawn.add(`edge:${edge.kind}`);
                    drawn.add(`provenance:${edge.provenance}`);
                });
            });
            expect(drawn.size).toBeGreaterThan(4);
            expect(entries()).toEqual(expect.arrayContaining(Array.from(drawn)));
        });
    });

    describe('logical', () => {
        beforeEach(() => act(() => root.render(<LogicalLegend />)));

        it('has a row for every construct role and ladder edge kind', () => {
            const expected = [
                ...Object.keys(ROLE_DESCRIPTIONS).map((role) => `role:${role}`),
                ...Object.keys(LADDER_EDGE_STYLES).map((kind) => `ladder-edge:${kind}`),
                'band:default',
                'band:others',
            ];
            expect(entries()).toEqual(expect.arrayContaining(expected));
        });

        it('covers every role and edge kind in a captured zone', () => {
            const model = buildLadderModel((cnv1 as unknown as LogicalTopologySnapshot).database as LogicalDatabase);
            const drawn = new Set<string>([
                ...model.constructs.map((construct) => `role:${construct.role}`),
                ...model.edges.map((edge) => `ladder-edge:${edge.kind}`),
            ]);
            expect(entries()).toEqual(expect.arrayContaining(Array.from(drawn)));
        });

        it('draws router peering dashed, as the ladder does', () => {
            const line = container.querySelector('[data-legend-entry="ladder-edge:router-peer"] line')!;
            expect(line.getAttribute('stroke-dasharray')).toBe(LADDER_EDGE_STYLES['router-peer'].dashArray);
        });
    });

    it('opens from the toolbar button and closes again', () => {
        act(() => root.render(<LegendButton><PhysicalLegend /></LegendButton>));
        expect(document.querySelector('[data-testid="physical-legend"]')).toBeNull();
        const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Legend')!;
        act(() => { button.click(); });
        expect(document.querySelector('[data-testid="physical-legend"]')).not.toBeNull();
        act(() => { button.click(); });
    });
});
