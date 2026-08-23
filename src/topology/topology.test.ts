import fs from 'fs';
import path from 'path';

import { buildGraphContext } from './context';
import { getAttachmentNodeId, getNadNodeId, getNetworkNodeId, getUdnNodeId, resolveNodeId } from './ids';
import { getResourceLinks, getResourcePath } from './links';
import { nodeKindRegistry } from './registry';
import { buildNodeViewModel } from './viewModel';
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

    it('gives a shadowing ovs-interface an id distinct from its bridge', () => {
        expect(resolveNodeId(iface('br-ex', 'ovs-bridge'), 'ovs-bridge', ctx)).toBe('br-ex');
        expect(resolveNodeId(iface('br-ex', 'ovs-interface'), 'ovs-interface', ctx)).toBe('interface-br-ex');
    });

    it('leaves an ovs-interface that shadows nothing under its own name', () => {
        expect(resolveNodeId(iface('ovs-vlan-1920', 'ovs-interface'), 'ovs-interface', ctx))
            .toBe('ovs-vlan-1920');
    });

    it('prefixes the resource-backed kinds', () => {
        expect(resolveNodeId({ localnet: 'physnet' }, 'ovn-mapping', ctx)).toBe('ovn-physnet');
        expect(resolveNodeId({ metadata: { name: 'blue' } }, 'cudn', ctx)).toBe('cudn-blue');
        expect(resolveNodeId({ id: 'lldp-eno1-0' }, 'lldp-neighbor', ctx)).toBe('lldp-eno1-0');
    });
});

describe('id helpers', () => {
    it('namespaces NAD and UDN ids, defaulting a missing namespace', () => {
        expect(getNadNodeId({ metadata: { namespace: 'ns1', name: 'a' } })).toBe('nad-ns1-a');
        expect(getNadNodeId({ metadata: { name: 'a' } })).toBe('nad-default-a');
        expect(getUdnNodeId({ metadata: { namespace: 'ns1', name: 'u' } })).toBe('udn-ns1-u');
    });

    it('distinguishes CUDN-backed from UDN-backed attachments', () => {
        expect(getAttachmentNodeId({ name: 'a', type: 'attachment', namespaces: [], cudn: 'blue' }))
            .toBe('attachment-blue');
        expect(getAttachmentNodeId({ name: 'a', type: 'attachment', namespaces: [], udnId: 'ns1-u' }))
            .toBe('attachment-udn-ns1-u');
    });

    it('routes the shared Networks lane to the right id per kind', () => {
        expect(getNetworkNodeId({ kind: 'cudn', item: { metadata: { name: 'blue' } } })).toBe('cudn-blue');
        expect(getNetworkNodeId({ kind: 'udn', item: { metadata: { namespace: 'ns1', name: 'u' } } }))
            .toBe('udn-ns1-u');
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

    it('maps a VRF, resolving its routes off the context', () => {
        const vrf = ctx.interfaces.find((i) => i.type === 'vrf')!;
        const model = buildNodeViewModel(vrf, 'vrf', ctx);

        expect(model.kind).toBe('vrf');
        expect(model.id).toBe('example-p-cudn');
        expect(model.graphDisplayLabel).toBe('VRF');
        expect(model.state).toContain('ovn-k8s-mp3');
        expect(model.vrfRoutes).toHaveLength(4);
    });

    it('maps a CUDN, folding topology and subnets into the state line', () => {
        const cudn = ctx.cudns.find((c) => c.metadata?.name === 'example-p-cudn')!;
        const model = buildNodeViewModel(cudn, 'cudn', ctx);

        expect(model.kind).toBe('cudn');
        expect(model.subtitle).toBe('Layer2 ClusterUserDefinedNetwork');
        expect(model.state).toContain('10.1.2.0/24');
        expect(model.resourceRef?.kind).toBe('ClusterUserDefinedNetwork');
        expect(model.links?.map((l) => l.label)).toEqual(['Resource', 'YAML']);
    });

    it('maps a bridge mapping to its localnet, not its bridge', () => {
        const model = buildNodeViewModel({ localnet: 'physnet', bridge: 'br-ex' }, 'ovn-mapping', ctx);

        expect(model.id).toBe('ovn-physnet');
        expect(model.label).toBe('physnet');
        expect(model.state).toBe('Bridge: br-ex');
    });

    it('marks an attachment as synthetic and carries its namespaces', () => {
        const model = buildNodeViewModel(
            { name: 'blue', type: 'attachment', namespaces: ['ns1', 'ns2'], cudn: 'blue' }, 'attachment', ctx);

        expect(model.isSynthetic).toBe(true);
        expect(model.namespaces).toEqual(['ns1', 'ns2']);
        expect(model.badges).toEqual(['synthetic', 'derived']);
    });

    it('falls back to the interface kind for a type it does not know', () => {
        // The catch-all that ovn-recon-s3t.8 replaces with an explicit role table.
        const model = buildNodeViewModel(iface('lo'), 'loopback', ctx);
        expect(model.kind).toBe('interface');
        expect(model.id).toBe('lo');
    });

    it('does not reach outside the context it was given', () => {
        // A CUDN present in one context must not leak into a model built from another.
        const bare = buildGraphContext({ nns: fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json') });
        const vrf = bare.interfaces.find((i) => i.type === 'vrf')!;

        expect(nodeKindRegistry.vrf.renderSummary).toBeDefined();
        expect(buildNodeViewModel(vrf, 'vrf', bare).vrfRoutes).toHaveLength(4);
        expect(bare.cudns).toEqual([]);
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
