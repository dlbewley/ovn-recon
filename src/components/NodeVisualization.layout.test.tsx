import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import * as yaml from 'js-yaml';

import { NodeNetworkState } from '../types';
import NodeVisualization from './NodeVisualization';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    useK8sWatchResource: () => [[]]
}));

// Mirrors the render constants in NodeVisualization.
const ITEM_WIDTH = 160;
const ITEM_HEIGHT = 80;

const loadFixture = (name: string): NodeNetworkState => {
    const raw = fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'nns', `${name}.json`), 'utf-8');
    try {
        return JSON.parse(raw) as NodeNetworkState;
    } catch {
        return yaml.load(raw) as NodeNetworkState;
    }
};

const parseTranslate = (element: Element): { x: number; y: number } | null => {
    const match = /translate\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/.exec(element.getAttribute('transform') || '');
    return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
};

/** Absolute top-left of every rendered node, accounting for nested render groups. */
const nodeOrigins = (container: HTMLElement): { x: number; y: number }[] => {
    const origins: { x: number; y: number }[] = [];
    container.querySelectorAll('g').forEach((group) => {
        // A node group is the one that draws the node's own rect. Checked via direct
        // children rather than `:scope > rect`, which jsdom does not support.
        if (!Array.from(group.children).some((child) => child.tagName.toLowerCase() === 'rect')) return;
        const own = parseTranslate(group);
        if (!own) return;
        const parent = group.parentElement && group.parentElement.tagName.toLowerCase() === 'g'
            ? parseTranslate(group.parentElement)
            : null;
        origins.push({ x: own.x + (parent?.x ?? 0), y: own.y + (parent?.y ?? 0) });
    });
    return origins;
};

const edgeEndpoints = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('line')).map((line) => ({
        x1: Number(line.getAttribute('x1')),
        y1: Number(line.getAttribute('y1')),
        x2: Number(line.getAttribute('x2')),
        y2: Number(line.getAttribute('y2'))
    }));

describe('NodeVisualization node placement', () => {
    let container: HTMLDivElement;
    let root: Root;

    const render = (nns: NodeNetworkState) => {
        act(() => {
            root.render(
                <NodeVisualization nns={nns} cudns={[]} udns={[]} nads={[]} routeAdvertisements={[]} />
            );
        });
    };

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    /**
     * The regression this guards: node Y used to be computed twice — once into the
     * nodePositions map that connectors read, and again from the render index inside
     * six of the column branches. When those disagreed, a node was drawn in one place
     * and its edges terminated in another.
     *
     * Asserting the invariant rather than the arithmetic: every connector endpoint must
     * land on the connection point of a node that was actually rendered.
     */
    const expectEdgesToMeetNodes = (minimumEdges = 1) => {
        const origins = nodeOrigins(container);
        const anchors = new Set<string>();
        origins.forEach(({ x, y }) => {
            anchors.add(`${x},${y + ITEM_HEIGHT / 2}`);                 // left edge (edge target)
            anchors.add(`${x + ITEM_WIDTH},${y + ITEM_HEIGHT / 2}`);    // right edge (edge source)
        });

        const endpoints = edgeEndpoints(container);
        expect(endpoints.length).toBeGreaterThanOrEqual(minimumEdges);

        endpoints.forEach(({ x1, y1, x2, y2 }) => {
            expect(anchors.has(`${x1},${y1}`)).toBe(true);
            expect(anchors.has(`${x2},${y2}`)).toBe(true);
        });
    };

    it('terminates every connector on a rendered node', () => {
        render(loadFixture('basic-host'));
        expectEdgesToMeetNodes();
    });

    it('keeps connectors aligned when a hidden column is revealed', () => {
        // Revealing the logical column gives previously position-less nodes coordinates
        // and shifts every lane to the right. Both sources of truth had to agree about
        // that; now there is only one.
        render(loadFixture('basic-host'));

        const toggle = container.querySelector<HTMLInputElement>('#show-hidden-columns-toggle');
        expect(toggle).not.toBeNull();
        act(() => toggle!.click());

        expectEdgesToMeetNodes();
    });

    it('renders a VRF fixture without dangling connectors', () => {
        // This fixture has no bridge mappings, controllers or networks, so it draws no
        // edges at all. The assertion that matters is that nothing dangles.
        render(loadFixture('vrf-mixed-routes'));
        expectEdgesToMeetNodes(0);
        expect(nodeOrigins(container).length).toBeGreaterThan(0);
    });

    it('places nodes in a lane at the spacing the ordering produced, with no gaps', () => {
        render(loadFixture('basic-host'));

        // Group node origins by lane (shared x) and confirm the vertical run is contiguous.
        const byLane = new Map<number, number[]>();
        nodeOrigins(container).forEach(({ x, y }) => {
            byLane.set(x, [...(byLane.get(x) ?? []), y]);
        });

        byLane.forEach((ys) => {
            const sorted = Array.from(new Set(ys)).sort((a, b) => a - b);
            sorted.slice(1).forEach((y, index) => {
                // Lanes stack at itemHeight + 20; the l3 lane adds a 40px sub-group header gap.
                const delta = y - sorted[index];
                expect(delta === ITEM_HEIGHT + 20 || delta === ITEM_HEIGHT + 60).toBe(true);
            });
        });
    });
});
