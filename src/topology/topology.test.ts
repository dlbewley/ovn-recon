import fs from 'fs';
import path from 'path';

import { buildGraphContext } from './context';
import {
    attachmentNodeId, edgeKey, findDuplicateIds, nadNodeId, networkNodeId,
    parseNodeId, resolveInterfaceRef, resolveNodeId, udnNodeId
} from './ids';
import { getResourceLinks, getResourcePath } from './links';
import { nodeKindRegistry } from './registry';
import { buildNodeViewModel } from './viewModel';
import { descriptorFor, NODE_TYPES } from './descriptors';
import { ClusterUserDefinedNetwork, NodeNetworkState } from '../types';

/**
 * Direct unit tests for the topology model.
 *
 * None of this was reachable before ovn-recon-s3t.5: every function here was
 * declared inside the NodeVisualization function body and closed over its props, so
 * the only way to exercise it was to render the whole component. Being able to call
 * buildNodeViewModel with a hand-built context is the point of the extraction.
 */
const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

const ctx = buildGraphContext({
    nns: fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json'),
    cudns: fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json')
});

describe('buildGraphContext', () => {
    it('derives the interface and mapping lists off the NodeNetworkState', () => {
        expect(ctx.interfaces).toHaveLength(20);
        expect(ctx.bridgeMappings.map((m) => m.localnet)).toEqual(['physnet', 'physnet-vmdata']);
    });

    it('collects the names that make id resolution ambiguous', () => {
        // br-ex is both an ovs-bridge and an ovs-interface, which is the collision
        // resolveNodeId exists to break.
        expect(ctx.explicitBridgeNames.has('br-ex')).toBe(true);
        expect(ctx.explicitBridgeNames.has('br-vmdata')).toBe(true);
        expect(ctx.explicitBridgeNames.has('ens192')).toBe(false);
        expect(ctx.controllerNames.has('br-ex')).toBe(true);
    });

    it('tolerates a NodeNetworkState with no status at all', () => {
        const empty = buildGraphContext({ nns: {} as NodeNetworkState });
        expect(empty.interfaces).toEqual([]);
        expect(empty.bridgeMappings).toEqual([]);
        expect(empty.cudns).toEqual([]);
    });
});

describe('resolveNodeId', () => {
    const iface = (name: string, type: string) => ({ name, type });

    it('gives a shadowing ovs-interface its own kind, not a name hack', () => {
        expect(resolveNodeId(iface('br-ex', 'ovs-bridge'), 'ovs-bridge', ctx)).toBe('iface:br-ex');
        expect(resolveNodeId(iface('br-ex', 'ovs-interface'), 'ovs-interface', ctx)).toBe('port:br-ex');
    });

    it('leaves an ovs-interface that shadows nothing as an ordinary interface', () => {
        expect(resolveNodeId(iface('ovs-vlan-1920', 'ovs-interface'), 'ovs-interface', ctx))
            .toBe('iface:ovs-vlan-1920');
    });

    it('gives a VRF its own kind', () => {
        expect(resolveNodeId(iface('blue', 'vrf'), 'vrf', ctx)).toBe('vrf:blue');
    });

    it('namespaces every kind', () => {
        expect(resolveNodeId({ localnet: 'physnet' }, 'ovn-mapping', ctx)).toBe('ovn:physnet');
        expect(resolveNodeId({ metadata: { name: 'blue' } }, 'cudn', ctx)).toBe('cudn:blue');
        expect(resolveNodeId({ id: 'lldp:eno1/0' }, 'lldp-neighbor', ctx)).toBe('lldp:eno1/0');
    });

    it('round-trips through parseNodeId', () => {
        expect(parseNodeId('udn:ns1/blue')).toEqual({ kind: 'udn', key: 'ns1/blue' });
        expect(parseNodeId('iface:br-ex')).toEqual({ kind: 'iface', key: 'br-ex' });
        expect(parseNodeId('not-an-id')).toBeNull();
    });
});

describe('resolveInterfaceRef', () => {
    it('resolves a name reference to the bridge, never to its internal port', () => {
        // br-ex names both. A controller reference means the bridge.
        expect(resolveInterfaceRef('br-ex', ctx)).toBe('iface:br-ex');
    });

    it('returns undefined for a name no interface carries', () => {
        expect(resolveInterfaceRef('br-nonexistent', ctx)).toBeUndefined();
        expect(resolveInterfaceRef(undefined, ctx)).toBeUndefined();
    });
});

describe('edgeKey', () => {
    it('is the same whichever way round the edge is given', () => {
        expect(edgeKey('iface:a', 'iface:b')).toBe(edgeKey('iface:b', 'iface:a'));
    });

    it('distinguishes different edges', () => {
        expect(edgeKey('iface:a', 'iface:b')).not.toBe(edgeKey('iface:a', 'iface:c'));
    });
});

describe('findDuplicateIds', () => {
    it('reports each duplicated id once, sorted', () => {
        expect(findDuplicateIds(['a', 'b', 'a', 'c', 'b', 'a'])).toEqual(['a', 'b']);
        expect(findDuplicateIds(['a', 'b'])).toEqual([]);
    });

    it('finds no duplicates across the real captures', () => {
        const ids = ctx.interfaces.map((i) => resolveNodeId(i, i.type, ctx));
        expect(findDuplicateIds(ids)).toEqual([]);
    });
});

describe('id helpers', () => {
    it('separates namespace from name, defaulting a missing namespace', () => {
        expect(nadNodeId({ metadata: { namespace: 'ns1', name: 'a' } })).toBe('nad:ns1/a');
        expect(nadNodeId({ metadata: { name: 'a' } })).toBe('nad:default/a');
        expect(udnNodeId({ metadata: { namespace: 'ns1', name: 'u' } })).toBe('udn:ns1/u');
    });

    it('keeps namespaces containing dashes intact', () => {
        // The old scheme joined with a dash, so this namespace was indistinguishable
        // from several other namespace/name splits.
        expect(udnNodeId({ metadata: { namespace: 'demo-vm-primary-udn', name: 'app' } }))
            .toBe('udn:demo-vm-primary-udn/app');
    });

    it('distinguishes CUDN-backed from UDN-backed attachments', () => {
        expect(attachmentNodeId({ name: 'a', type: 'attachment', namespaces: [], cudn: 'blue' }))
            .toBe('attachment:cudn/blue');
        expect(attachmentNodeId({
            name: 'a', type: 'attachment', namespaces: [], udn: { namespace: 'ns1', name: 'u' }
        })).toBe('attachment:udn/ns1/u');
    });

    it('routes the shared Networks lane to the right id per kind', () => {
        expect(networkNodeId({ kind: 'cudn', item: { metadata: { name: 'blue' } } })).toBe('cudn:blue');
        expect(networkNodeId({ kind: 'udn', item: { metadata: { namespace: 'ns1', name: 'u' } } }))
            .toBe('udn:ns1/u');
    });
});

describe('console links', () => {
    it('builds a cluster-scoped path when there is no namespace', () => {
        expect(getResourcePath({ apiVersion: 'k8s.ovn.org/v1', kind: 'ClusterUserDefinedNetwork', name: 'blue' }))
            .toBe('/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/blue');
    });

    it('builds a namespaced path when there is one', () => {
        expect(getResourcePath({
            apiVersion: 'k8s.cni.cncf.io/v1', kind: 'NetworkAttachmentDefinition', name: 'a', namespace: 'ns1'
        })).toBe('/k8s/ns/ns1/k8s.cni.cncf.io~v1~NetworkAttachmentDefinition/a');
    });

    it('offers both the resource and its YAML', () => {
        expect(getResourceLinks({ apiVersion: 'v1', kind: 'Node', name: 'n1' }).map((l) => l.label))
            .toEqual(['Resource', 'YAML']);
    });
});

describe('buildNodeViewModel', () => {
    const iface = (name: string) => ctx.interfaces.find((i) => i.name === name)!;

    it('maps a VRF without resolving its routes, which belong to the drawer', () => {
        const vrf = ctx.interfaces.find((i) => i.type === 'vrf')!;
        const model = buildNodeViewModel(vrf, descriptorFor('vrf')!, ctx);

        expect(model.kind).toBe('vrf');
        expect(model.id).toBe('vrf:example-p-cudn');
        expect(model.graphDisplayLabel).toBe('VRF');
        expect(model.state).toContain('ovn-k8s-mp3');
        // Route association walks the whole NNS route table, so it moved out of the
        // view model and into the VRF drawer renderer (ovn-recon-s3t.4).
        expect('vrfRoutes' in model).toBe(false);
    });

    it('maps a CUDN, folding topology and subnets into the state line', () => {
        const cudn = ctx.cudns.find((c) => c.metadata?.name === 'example-p-cudn')!;
        const model = buildNodeViewModel(cudn, descriptorFor('cudn')!, ctx);

        expect(model.kind).toBe('cudn');
        expect(model.subtitle).toBe('Layer2 ClusterUserDefinedNetwork');
        expect(model.state).toContain('10.1.2.0/24');
        expect(model.resourceRef?.kind).toBe('ClusterUserDefinedNetwork');
        expect(model.links?.map((l) => l.label)).toEqual(['Resource', 'YAML']);
    });

    it('maps a bridge mapping to its localnet, not its bridge', () => {
        const model = buildNodeViewModel({ localnet: 'physnet', bridge: 'br-ex' }, descriptorFor('ovn-mapping')!, ctx);

        expect(model.id).toBe('ovn:physnet');
        expect(model.label).toBe('physnet');
        expect(model.state).toBe('Bridge: br-ex');
    });

    it('marks an attachment as synthetic and carries its namespaces', () => {
        const model = buildNodeViewModel(
            { name: 'blue', type: 'attachment', namespaces: ['ns1', 'ns2'], cudn: 'blue' }, descriptorFor('attachment')!, ctx);

        expect(model.isSynthetic).toBe(true);
        expect(model.namespaces).toEqual(['ns1', 'ns2']);
        expect(model.badges).toEqual(['synthetic', 'derived']);
    });

    it('renders an unlaned interface through the catch-all descriptor', () => {
        const model = buildNodeViewModel(iface('lo'), descriptorFor('other')!, ctx);
        expect(model.kind).toBe('interface');
        expect(model.id).toBe('iface:lo');
    });

    it('does not reach outside the context it was given', () => {
        // A CUDN present in one context must not leak into a model built from another.
        const bare = buildGraphContext({ nns: fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json') });
        const vrf = bare.interfaces.find((i) => i.type === 'vrf')!;

        expect(nodeKindRegistry.vrf.renderSummary).toBeDefined();
        expect(buildNodeViewModel(vrf, descriptorFor('vrf')!, bare).state).toContain('ovn-k8s-mp3');
        expect(bare.cudns).toEqual([]);
    });
});

describe('the descriptor table', () => {
    it('covers every node type exactly once', () => {
        const types = NODE_TYPES.map((d) => d.type);
        expect(new Set(types).size).toBe(types.length);
    });

    it('requires each descriptor to supply the fields the graph needs', () => {
        NODE_TYPES.forEach((d) => {
            expect(typeof d.items).toBe('function');
            expect(typeof d.id).toBe('function');
            expect(typeof d.present).toBe('function');
            expect(d.color).toMatch(/^#[0-9A-Fa-f]{3,6}$/);
            expect(d.icon).toBeDefined();
        });
    });

    it('stacks bridge mappings above VRFs in the Layer 3 lane', () => {
        // Descriptor order within a lane IS the group order, and getting it backwards
        // inverts the lane. It did, once, before the snapshot caught it.
        const l3 = NODE_TYPES.filter((d) => d.lane === 'l3').map((d) => d.type);
        expect(l3).toEqual(['ovn-mapping', 'vrf']);
    });
});

describe('nodeKindRegistry', () => {
    it('has an entry for every node kind', () => {
        expect(Object.keys(nodeKindRegistry).sort()).toEqual([
            'attachment', 'cudn', 'interface', 'lldp-neighbor', 'nad', 'other', 'ovn-mapping', 'udn', 'vrf'
        ]);
    });

    it('leaves the per-kind tab override unused, as the drawer assumes', () => {
        // Dead configuration noted on ovn-recon-s3t.13. If a kind ever sets it, that
        // bead's assumption needs revisiting.
        Object.values(nodeKindRegistry).forEach((def) => expect(def.tabs).toBeUndefined());
    });
});
