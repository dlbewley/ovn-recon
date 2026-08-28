import fs from 'fs';
import path from 'path';

import { buildGraphContext } from '../topology/context';
import { buildTopologyEdges, EdgeKind, TopologyEdge } from './nodeVisualizationModel';
import { ClusterUserDefinedNetwork, NodeNetworkState } from '../types';

/**
 * Edges carry what the relationship MEANS, not just that one exists.
 *
 * The graph drew one kind of line for three different relationships, and the columnar
 * layout then added a fourth semantic nobody declared -- that column position is
 * position in a path. Membership edges violated it by pointing back at their container,
 * and reference edges fabricated a hop that does not exist.
 */
const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

const VIEW = { showHiddenColumns: false, showNads: false, showLldp: false };

const edgesFor = (nns: string, cudns?: string, view = VIEW): TopologyEdge[] =>
    buildTopologyEdges(
        buildGraphContext({
            nns: fixture<NodeNetworkState>('nns', `${nns}.json`),
            cudns: cudns ? fixture<ClusterUserDefinedNetwork[]>('cudn', `${cudns}.json`) : []
        }),
        view
    ).edges;

const kindOfRule = (edges: TopologyEdge[], rule: string): EdgeKind | undefined =>
    edges.find((e) => e.rule === rule)?.kind;

describe('every edge says what it means', () => {
    it('carries a kind and a rule, with no gaps', () => {
        const edges = edgesFor('primary-cudn-vrf', 'primary-cudn-vrf');
        expect(edges.length).toBeGreaterThan(0);
        edges.forEach((edge) => {
            expect(['membership', 'layering', 'reference', 'peer']).toContain(edge.kind);
            expect(edge.rule.length).toBeGreaterThan(0);
        });
    });

    it('classifies enslavement as membership', () => {
        // ens192 is a PORT OF br-ex. Nothing is layered, and no name is being resolved.
        expect(kindOfRule(edgesFor('primary-cudn-vrf'), 'controller')).toBe('membership');
    });

    it('classifies a VLAN on its base interface as layering', () => {
        // Traffic really does flow through ens224 to reach ens224.456.
        expect(kindOfRule(edgesFor('primary-cudn-vrf'), 'base-iface')).toBe('layering');
    });

    it('classifies a bridge mapping as a reference', () => {
        // A bridge mapping is the name OVN uses for a bridge. Nothing flows through it,
        // which is exactly what drawing it as an ordinary edge implied.
        expect(kindOfRule(edgesFor('primary-cudn-vrf'), 'bridge-mapping')).toBe('reference');
    });

    it('classifies a CUDN naming a physical network as a reference', () => {
        expect(kindOfRule(edgesFor('primary-cudn-vrf', 'primary-cudn-vrf'), 'physical-network-name'))
            .toBe('reference');
    });

    it('classifies an LLDP neighbour as a peer, not as any of the other three', () => {
        // A neighbour is neither part of the interface, nor layered on it, nor a name
        // for it -- it is the device at the other end of a cable, on another machine.
        // Forcing it into one of the three would have been tidier and wrong.
        const edges = edgesFor('bonded-lldp', undefined, { ...VIEW, showLldp: true });
        expect(kindOfRule(edges, 'lldp')).toBe('peer');
    });

    it('classifies the br-int patch cable as a peer, like LLDP', () => {
        // The reciprocal patch.peer pair is two ends of a virtual cable between
        // br-ex and the synthesized integration bridge (ovn-recon-s3t.46).
        const edges = edgesFor('primary-cudn-vrf');
        expect(kindOfRule(edges, 'patch-peer')).toBe('peer');
        expect(edges.find((e) => e.rule === 'patch-peer'))
            .toMatchObject({ source: 'iface:br-ex', target: 'intbr:br-int' });
    });

    it('classifies attached namespaces as membership', () => {
        const ctx = buildGraphContext({
            nns: fixture<NodeNetworkState>('nns', 'basic-host.json'),
            udns: [{ metadata: { namespace: 'ns1', name: 'blue' } }]
        });
        expect(kindOfRule(buildTopologyEdges(ctx, VIEW).edges, 'attached-namespaces'))
            .toBe('membership');
    });
});

describe('what the kinds are for', () => {
    it('marks every reference edge, and only reference edges, as not carrying traffic', () => {
        const edges = edgesFor('primary-cudn-vrf', 'primary-cudn-vrf');
        const byKind = (kind: EdgeKind) =>
            Array.from(new Set(edges.filter((e) => e.kind === kind).map((e) => e.rule))).sort();

        expect(byKind('reference')).toEqual([
            'bridge-mapping', 'physical-network-name', 'primary-network (subnet, name)'
        ]);
        expect(byKind('membership')).toEqual([
            'attached-namespaces', 'controller', 'management-port (ovn-k8s-mp3)'
        ]);
        expect(byKind('layering')).toEqual(['base-iface']);
    });

    it('gives the ordering pass no reason to care about kinds', () => {
        // computeNodeOrder takes only source and target. Keeping edge meaning out of the
        // layout is deliberate: crossing reduction is about connectivity, not semantics.
        const edges = edgesFor('primary-cudn-vrf', 'primary-cudn-vrf');
        const connections = edges.map(({ source, target }) => ({ source, target }));
        expect(connections.every((c) => c.source && c.target)).toBe(true);
    });
});

describe('direction of travel', () => {
    it('draws no edge that points backwards in the default view', () => {
        // Reading left to right is the only thing the lane order promises. An edge that
        // runs the other way breaks it, which the bridge-port lane used to do.
        const nns = fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json');
        const ctx = buildGraphContext({
            nns, cudns: fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json')
        });
        const { edges } = buildTopologyEdges(ctx, VIEW);

        // Lane index by node id, from the order the lanes are declared in.
        const laneOf = (id: string): number => {
            const prefixes = ['lldp:', 'iface:', 'vrf:', 'ovn:', 'cudn:', 'udn:', 'attachment:', 'nad:'];
            return prefixes.findIndex((p) => id.startsWith(p));
        };

        const backwards = edges.filter((e) => {
            // port: only exists in the hidden lane; excluded from the default view.
            if (e.source.startsWith('port:') || e.target.startsWith('port:')) return false;
            return laneOf(e.source) > laneOf(e.target) && laneOf(e.target) >= 0;
        });

        expect(backwards.map((e) => `${e.source} -> ${e.target} (${e.rule})`)).toEqual([]);
    });

    it('records that the bridge-port edge still points backwards when revealed', () => {
        // A bridge's internal port sits in a lane to the RIGHT of the bridge, so its
        // membership edge runs right to left. ovn-recon-s3t.26 removes the lane
        // entirely by drawing ports on their bridge; until then this is expected.
        const ctx = buildGraphContext({
            nns: fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json')
        });
        const { edges } = buildTopologyEdges(ctx, { ...VIEW, showHiddenColumns: true });

        const portEdge = edges.find((e) => e.source.startsWith('port:'));
        expect(portEdge).toEqual({
            source: 'port:br-ex', target: 'iface:br-ex', kind: 'membership', rule: 'controller'
        });
    });
});
