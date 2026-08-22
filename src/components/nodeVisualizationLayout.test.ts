import { computeGravityById, sortByGravity } from './nodeVisualizationLayout';
import { TopologyEdge } from './nodeVisualizationModel';
import { Interface } from '../types';

/** Mirrors UNRANKED_GRAVITY in the module under test. */
const UNRANKED_BAND = 10000;

const iface = (name: string, master?: string): Interface => ({
    name,
    type: 'ethernet',
    state: 'up',
    master
});

describe('nodeVisualizationLayout', () => {
    it('prioritizes interfaces enslaved to important nodes over the important node itself', () => {
        const topologyEdges: TopologyEdge[] = [
            { source: 'eno1', target: 'br-ex' },
            { source: 'br-ex', target: 'ovn-physnet' },
            { source: 'ovn-physnet', target: 'cudn-machinenet' }
        ];
        const interfaces: Interface[] = [iface('eno1', 'br-ex'), iface('br-ex')];

        const gravity = computeGravityById({
            topologyEdges,
            interfaces,
            physicalNodeIds: new Set(['eno1', 'br-ex']),
            importantNodes: new Set(['br-ex'])
        });

        expect(gravity.eno1).toBeLessThan(gravity['br-ex']);
        expect(gravity['br-ex']).toBeLessThan(gravity['ovn-physnet']);
    });

    it('applies a UDN sort penalty so UDN nodes sort below CUDN nodes', () => {
        const topologyEdges: TopologyEdge[] = [
            { source: 'br-ex', target: 'cudn-net-a' },
            { source: 'br-ex', target: 'udn-ns-net-a' }
        ];
        const interfaces: Interface[] = [iface('br-ex')];

        const gravity = computeGravityById({
            topologyEdges,
            interfaces,
            physicalNodeIds: new Set(['br-ex']),
            importantNodes: new Set(['br-ex'])
        });

        expect(gravity['udn-ns-net-a']).toBeGreaterThan(gravity['cudn-net-a']);
    });

    it('sorts by lexical id when gravity is tied', () => {
        const items = [{ id: 'node-b' }, { id: 'node-a' }];
        const gravity = { 'node-a': 100, 'node-b': 100 };

        const sorted = sortByGravity(items, (item) => item.id, gravity);

        expect(sorted.map((item) => item.id)).toEqual(['node-a', 'node-b']);
    });

    it('sorts a node with gravity 0 first, not last', () => {
        // Regression: sortByGravity used `|| 10000`, so a legitimate gravity of 0 was
        // treated as unranked and demoted to the bottom of its column.
        const items = [{ id: 'unranked' }, { id: 'top' }, { id: 'middle' }];
        const gravity = { top: 0, middle: 500 };

        const sorted = sortByGravity(items, (item) => item.id, gravity);

        expect(sorted.map((item) => item.id)).toEqual(['top', 'middle', 'unranked']);
    });

    it('keeps a computed gravity of 0 instead of overwriting it', () => {
        // Regression: `if (!gravityById[id])` and the `gravityById[id] && ...` chain both
        // read 0 as "absent" and reassigned it (to 10000+n, or to 200).
        // pathGravity = 1000 - (pathLength * 100) - position - importantBonus, so a
        // 5-node path through an important node yields exactly 0 at position 0.
        const topologyEdges: TopologyEdge[] = [
            { source: 'eno1', target: 'br-ex' },
            { source: 'br-ex', target: 'ovn-physnet' },
            { source: 'ovn-physnet', target: 'cudn-a' },
            { source: 'cudn-a', target: 'attachment-a' }
        ];
        const interfaces: Interface[] = [iface('eno1'), iface('br-ex')];

        const gravity = computeGravityById({
            topologyEdges,
            interfaces,
            physicalNodeIds: new Set(['eno1', 'br-ex']),
            importantNodes: new Set(['br-ex'])
        });

        // The head of the important path scores exactly 0 here. Before the fix it was
        // read as "absent" and reassigned — to 200 by the important-path chain, or to
        // 10000 + connectionCount by the fill pass. It must survive as 0.
        expect(gravity['eno1']).toBe(0);
        expect(gravity['eno1']).not.toBe(200);
        expect(gravity['eno1']).toBeLessThan(UNRANKED_BAND);
    });

    it('terminates on a dense graph instead of enumerating every simple path', () => {
        // A 12-node clique has ~12! simple paths. Unbounded, this does not return.
        const names = Array.from({ length: 12 }, (_, i) => `n${i}`);
        const topologyEdges: TopologyEdge[] = [];
        names.forEach((a, i) => names.slice(i + 1).forEach((b) => topologyEdges.push({ source: a, target: b })));

        const started = Date.now();
        const gravity = computeGravityById({
            topologyEdges,
            interfaces: names.map((n) => iface(n)),
            physicalNodeIds: new Set(names),
            importantNodes: new Set(['n0'])
        });

        expect(Date.now() - started).toBeLessThan(5000);
        expect(Object.keys(gravity).length).toBe(names.length);
    });
});
