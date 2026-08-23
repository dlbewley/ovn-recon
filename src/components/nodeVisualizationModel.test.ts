import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';

import { ClusterUserDefinedNetwork, NodeNetworkState } from '../types';
import { buildGraphContext } from '../topology/context';
import { buildTopologyEdges } from './nodeVisualizationModel';

const loadFixture = (name: string): NodeNetworkState => {
    const raw = fs.readFileSync(
        path.join(process.cwd(), 'test', 'fixtures', 'nns', `${name}.json`), 'utf-8');
    try {
        return JSON.parse(raw) as NodeNetworkState;
    } catch {
        return yaml.load(raw) as NodeNetworkState;
    }
};

const loadCudns = (name: string): ClusterUserDefinedNetwork[] =>
    JSON.parse(fs.readFileSync(
        path.join(process.cwd(), 'test', 'fixtures', 'cudn', `${name}.json`), 'utf-8'));

const VIEW = { showHiddenColumns: false, showNads: false, showLldp: false };

const build = (nns: NodeNetworkState, view: Partial<typeof VIEW> = {}) =>
    buildTopologyEdges(buildGraphContext({ nns }), { ...VIEW, ...view });

const arrows = (result: ReturnType<typeof buildTopologyEdges>) =>
    result.edges.map((e) => `${e.source} -> ${e.target}`).sort();

describe('buildTopologyEdges', () => {
    it('draws enslavement and bridge-mapping edges with canonical ids', () => {
        expect(arrows(build(loadFixture('basic-host')))).toEqual([
            'iface:br-ex -> ovn:physnet',
            'iface:eno1 -> iface:br-ex',
            'iface:ovn-k8s-mp0 -> iface:br-int'
        ]);
    });

    it('adds LLDP edges only when neighbours are being shown', () => {
        const nns = loadFixture('host-lldp');

        expect(build(nns).edges.some((e) => e.source.startsWith('lldp:'))).toBe(false);
        expect(arrows(build(nns, { showLldp: true }))).toEqual(
            expect.arrayContaining(['lldp:enp44s0/0 -> iface:enp44s0', 'lldp:enp45s0/0 -> iface:enp45s0'])
        );
    });

    it('distinguishes a bridge from the internal port that shares its name', () => {
        // The collision the old bare-name scheme papered over with an 'interface-'
        // prefix. ens192 is enslaved to the BRIDGE br-ex, and so is the port.
        const ctx = buildGraphContext({ nns: loadFixture('primary-cudn-vrf') });
        const result = arrows(buildTopologyEdges(ctx, VIEW));

        expect(result).toEqual(expect.arrayContaining([
            'iface:ens192 -> iface:br-ex',
            'port:br-ex -> iface:br-ex'
        ]));
        // The bridge must not be enslaved to itself.
        expect(result).not.toContain('iface:br-ex -> iface:br-ex');
    });

    it('links a localnet CUDN to its bridge mapping', () => {
        const ctx = buildGraphContext({ nns: loadFixture('primary-cudn-vrf'),cudns: loadCudns('primary-cudn-vrf') });
        const result = arrows(buildTopologyEdges(ctx, VIEW));

        expect(result).toEqual(expect.arrayContaining([
            'ovn:physnet -> cudn:machinenet',
            'ovn:physnet-vmdata -> cudn:vlan-1924'
        ]));
    });

    it('hangs an attachment off the network that produced it', () => {
        // attachmentNodes are derived by the context: one per CUDN with namespaces in
        // its status, and one per UDN for the NAD its controller creates.
        const ctx = buildGraphContext({
            nns: loadFixture('basic-host'),
            cudns: [{
                metadata: { name: 'blue' },
                status: { conditions: [{
                    type: 'NetworkCreated', status: 'True',
                    message: 'created in following namespaces: [ns1]'
                }] }
            }],
            udns: [{ metadata: { namespace: 'ns2', name: 'green' } }]
        });

        expect(arrows(buildTopologyEdges(ctx, VIEW))).toEqual(expect.arrayContaining([
            'cudn:blue -> attachment:cudn/blue',
            'udn:ns2/green -> attachment:udn/ns2/green'
        ]));
    });

    it('survives a namespace containing dashes', () => {
        // The previous scheme joined namespace and name with a dash and could not undo
        // it, so a dashed namespace produced the wrong UDN id.
        const ctx = buildGraphContext({
            nns: loadFixture('basic-host'),
            udns: [{ metadata: { namespace: 'demo-vm-primary-udn', name: 'app' } }]
        });

        expect(arrows(buildTopologyEdges(ctx, VIEW))).toContain(
            'udn:demo-vm-primary-udn/app -> attachment:udn/demo-vm-primary-udn/app'
        );
    });
});

describe('unresolved references', () => {
    it('reports a controller naming an interface that is not on this node', () => {
        const nns = loadFixture('basic-host');
        const interfaces = nns.status!.currentState!.interfaces;
        interfaces.push({ name: 'orphan', type: 'ethernet', state: 'up', controller: 'br-nonexistent' });

        const result = buildTopologyEdges(buildGraphContext({ nns }), VIEW);

        expect(result.unresolved).toContainEqual({
            rule: 'controller', reference: 'br-nonexistent', from: 'iface:orphan'
        });
        // The dangling reference is reported, not turned into an edge.
        expect(result.edges.some((e) => e.source === 'iface:orphan')).toBe(false);
    });

    it('reports nothing on real captures, where every reference either resolves or is known', () => {
        expect(build(loadFixture('primary-cudn-vrf')).unresolved).toEqual([]);
        expect(build(loadFixture('bonded-lldp')).unresolved).toEqual([]);
    });

    it('stays quiet about ovs-system, which nmstate never reports', () => {
        // Both real captures enslave something to the OVS datapath device -- a veth in
        // one, the Geneve tunnel in the other -- and it appears in neither interface
        // list. Warning about it would fire on every cluster.
        const nns = loadFixture('primary-cudn-vrf');
        const veth = nns.status!.currentState!.interfaces.find((i) => i.type === 'veth')!;

        expect(veth.controller).toBe('ovs-system');
        expect(build(nns).unresolved).toEqual([]);
    });
});
