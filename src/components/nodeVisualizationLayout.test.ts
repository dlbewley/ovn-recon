import { computeGravityById, sortByGravity } from './nodeVisualizationLayout';
import { TopologyEdge } from './nodeVisualizationModel';
import { Interface } from '../types';

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
});
