import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

import { Interface, NodeNetworkState } from '../types';
import NodeVisualizationComponent from './NodeVisualization';
import { routed } from './testRouter';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    useK8sWatchResource: () => [[]]
}));

const loadFixture = (name: string): NodeNetworkState =>
    JSON.parse(fs.readFileSync(
        path.join(process.cwd(), 'test', 'fixtures', 'nns', `${name}.json`), 'utf-8')) as NodeNetworkState;

/** The fixture plus `count` host-local devices, which classify into the foot grid. */
const withFootGridNodes = (nns: NodeNetworkState, count: number): NodeNetworkState => {
    const extras: Interface[] = Array.from({ length: count }, (_, i) => ({
        name: `veth${i}`, type: 'veth', state: 'up'
    } as Interface));
    const interfaces = [...(nns.status?.currentState?.interfaces ?? []), ...extras];
    return {
        ...nns,
        status: { ...nns.status, currentState: { ...nns.status!.currentState, interfaces } }
    };
};

/**
 * Every connector's geometry, independent of node identity: straight edges by their
 * endpoints, bowed and same-lane edges by their whole path. Sorted so two renders
 * compare as sets.
 */
const edgeGeometry = (container: HTMLElement): string[] => [
    ...Array.from(container.querySelectorAll('line')).map((l) =>
        `${l.getAttribute('x1')},${l.getAttribute('y1')} -> ${l.getAttribute('x2')},${l.getAttribute('y2')}`),
    ...Array.from(container.querySelectorAll('path[d^="M "]')).map((p) => `arc ${p.getAttribute('d')}`)
].sort();

const nodeTitles = (container: HTMLElement): string[] =>
    Array.from(container.querySelectorAll('g'))
        .filter((g) => Array.from(g.children).some((c) => c.tagName.toLowerCase() === 'rect'))
        .map((g) => g.querySelector('title')?.textContent ?? '');

/** Render with the LLDP lane revealed, read the graph, and tear down. */
const renderAndRead = (nns: NodeNetworkState) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
        root.render(<NodeVisualization nns={nns} cudns={[]} udns={[]} nads={[]} routeAdvertisements={[]} />);
    });
    act(() => container.querySelector<HTMLInputElement>('#show-lldp-neighbors-toggle')!.click());
    const result = { edges: edgeGeometry(container), titles: nodeTitles(container) };
    act(() => root.unmount());
    container.remove();
    return result;
};

// The view reads and writes ?select= through the router; the console provides
// one in production.
const NodeVisualization = routed(NodeVisualizationComponent);

describe('NodeVisualization foot grid and edge routing', () => {
    /**
     * Foot-grid nodes carry grid-relative coordinates, starting at 0,0, not canvas
     * coordinates. Fed to the edge router as obstacles they were tested as if they
     * sat in the top-left of the canvas, so adding a loopback or veth bowed lane
     * edges that had nothing to do with it (ovn-recon-s3t.54).
     */
    it('does not change the shape of any lane edge when foot-grid nodes are added', () => {
        const base = loadFixture('bonded-lldp');
        const before = renderAndRead(base);
        // Six extras fill a second grid row, so the (wrongly placed) boxes would
        // have covered the top-left 700x180 of the canvas, where the lane edges are.
        const after = renderAndRead(withFootGridNodes(base, 6));

        // The extras are drawn, so the comparison is between two different pictures.
        expect(after.titles).toEqual(expect.arrayContaining(['veth0 (veth)', 'veth5 (veth)']));
        expect(before.titles).not.toContain('veth0 (veth)');
        expect(before.edges.length).toBeGreaterThan(0);

        expect(after.edges).toEqual(before.edges);
    });
});
