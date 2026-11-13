import fs from 'fs';
import path from 'path';

import {
    CONSOLE_OWNER, CRD_FLAGS, kindReference, LinkTarget, NETOBSERV_PLUGIN, NETOBSERV_UDN_MAPPING, NETWORKING_PLUGIN,
    NMSTATE_PLUGIN, NO_CAPABILITIES, resolveLinkOut, resolveLinkOuts
} from './registry';
import { allCrds, BARE, capabilities, NETOBSERV_FULL, OCP_4_22, OCP_5_1, withNetobserv } from './testCapabilities';

const NETWORK_POLICY = { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy' };
const MULTI_NETWORK_POLICY = { apiVersion: 'k8s.cni.cncf.io/v1beta1', kind: 'MultiNetworkPolicy' };
const CUDN = { apiVersion: 'k8s.ovn.org/v1', kind: 'ClusterUserDefinedNetwork' };
const UDN = { apiVersion: 'k8s.ovn.org/v1', kind: 'UserDefinedNetwork' };
const NNCP = { apiVersion: 'nmstate.io/v1', kind: 'NodeNetworkConfigurationPolicy' };

const pathAndOwner = (target: LinkTarget, caps = NO_CAPABILITIES) => {
    const link = resolveLinkOut(target, caps);
    return link && [link.path, link.owner];
};

describe('link-out registry (ovn-recon-zdt.4)', () => {
    describe('a resource', () => {
        const policy: LinkTarget = {
            type: 'resource', ref: { ...NETWORK_POLICY, namespace: 'demo', name: 'restrict' }
        };
        const multi: LinkTarget = {
            type: 'resource', ref: { ...MULTI_NETWORK_POLICY, namespace: 'demo', name: 'restrict' }
        };
        const nncp: LinkTarget = { type: 'resource', ref: { ...NNCP, name: 'storage-vlan' } };

        it('opens a NetworkPolicy on the networking plugin\'s page when the plugin is loaded', () => {
            expect(pathAndOwner(policy, OCP_4_22))
                .toEqual(['/k8s/ns/demo/networking.k8s.io~v1~NetworkPolicy/restrict', NETWORKING_PLUGIN]);
            expect(pathAndOwner(multi, OCP_4_22))
                .toEqual(['/k8s/ns/demo/k8s.cni.cncf.io~v1beta1~MultiNetworkPolicy/restrict', NETWORKING_PLUGIN]);
        });

        it('opens the same address on the console\'s own page when the plugin is absent', () => {
            expect(pathAndOwner(policy, BARE))
                .toEqual(['/k8s/ns/demo/networking.k8s.io~v1~NetworkPolicy/restrict', CONSOLE_OWNER]);
            expect(pathAndOwner(multi, BARE))
                .toEqual(['/k8s/ns/demo/k8s.cni.cncf.io~v1beta1~MultiNetworkPolicy/restrict', CONSOLE_OWNER]);
        });

        it('opens an NNCP on nmstate\'s page when that plugin is loaded, else the console\'s', () => {
            const address = '/k8s/cluster/nmstate.io~v1~NodeNetworkConfigurationPolicy/storage-vlan';
            expect(pathAndOwner(nncp, OCP_4_22)).toEqual([address, NMSTATE_PLUGIN]);
            expect(pathAndOwner(nncp, BARE)).toEqual([address, CONSOLE_OWNER]);
        });

        it('falls back to the generic page for a kind no plugin owns', () => {
            expect(pathAndOwner({ type: 'resource', ref: { apiVersion: 'v1', kind: 'Pod', namespace: 'a', name: 'b' } }, OCP_5_1))
                .toEqual(['/k8s/ns/a/core~v1~Pod/b', CONSOLE_OWNER]);
            expect(pathAndOwner({ type: 'resource', ref: { ...CUDN, name: 'vlan-10' } }, OCP_5_1))
                .toEqual(['/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/vlan-10', CONSOLE_OWNER]);
        });

        it('adds /yaml only when the YAML view is asked for', () => {
            expect(resolveLinkOut({ type: 'resource', ref: { ...CUDN, name: 'vlan-10' }, view: 'yaml' })?.path)
                .toBe('/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/vlan-10/yaml');
        });

        // ovn-recon-nt4.4: where to look when the collector does not answer.
        it('opens a workload\'s Pods and Events tabs when asked for', () => {
            const deployment = { apiVersion: 'apps/v1', kind: 'Deployment', namespace: 'ovn-recon', name: 'ovn-recon-collector' };
            const base = '/k8s/ns/ovn-recon/apps~v1~Deployment/ovn-recon-collector';
            expect(resolveLinkOut({ type: 'resource', ref: deployment, view: 'details' }))
                .toMatchObject({ path: base, label: 'Deployment' });
            expect(resolveLinkOut({ type: 'resource', ref: deployment, view: 'pods' }))
                .toMatchObject({ id: 'resource-pods', path: `${base}/pods`, label: 'Pods', owner: CONSOLE_OWNER });
            expect(resolveLinkOut({ type: 'resource', ref: deployment, view: 'events' }))
                .toMatchObject({ id: 'resource-events', path: `${base}/events`, label: 'Events' });
        });

        it('has no page for a reference without a name', () => {
            expect(resolveLinkOut({ type: 'resource', ref: { ...CUDN, name: '' } }, OCP_5_1)).toBeUndefined();
        });
    });

    describe('a list', () => {
        it('addresses cluster, all-namespaces and one-namespace lists', () => {
            expect(pathAndOwner({ type: 'list', kind: CUDN, scope: 'cluster' }, OCP_4_22))
                .toEqual(['/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork', CONSOLE_OWNER]);
            expect(pathAndOwner({ type: 'list', kind: UDN, scope: 'all-namespaces' }, OCP_4_22))
                .toEqual(['/k8s/all-namespaces/k8s.ovn.org~v1~UserDefinedNetwork', CONSOLE_OWNER]);
            expect(pathAndOwner({ type: 'list', kind: NETWORK_POLICY, scope: { namespace: 'demo' } }, OCP_4_22))
                .toEqual(['/k8s/ns/demo/networking.k8s.io~v1~NetworkPolicy', NETWORKING_PLUGIN]);
        });

        it('keeps the address and changes hands when the plugin is absent', () => {
            expect(pathAndOwner({ type: 'list', kind: NETWORK_POLICY, scope: { namespace: 'demo' } }, BARE))
                .toEqual(['/k8s/ns/demo/networking.k8s.io~v1~NetworkPolicy', CONSOLE_OWNER]);
        });

        it('offers no list for a kind whose CRD is absent or not yet discovered', () => {
            const list: LinkTarget = { type: 'list', kind: MULTI_NETWORK_POLICY, scope: 'all-namespaces' };
            expect(resolveLinkOut(list, BARE)).toBeUndefined();
            expect(resolveLinkOut(list, capabilities({ [NETWORKING_PLUGIN]: [] }, {}))).toBeUndefined();
            expect(resolveLinkOut(list, OCP_4_22)?.path)
                .toBe('/k8s/all-namespaces/k8s.cni.cncf.io~v1beta1~MultiNetworkPolicy');
        });
    });

    describe('a create page', () => {
        it('opens the networking plugin\'s form when the plugin is loaded', () => {
            expect(pathAndOwner({ type: 'create', kind: CUDN }, OCP_4_22))
                .toEqual(['/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/~new/form', NETWORKING_PLUGIN]);
            expect(pathAndOwner({ type: 'create', kind: UDN, namespace: 'demo' }, OCP_4_22))
                .toEqual(['/k8s/ns/demo/k8s.ovn.org~v1~UserDefinedNetwork/~new/form', NETWORKING_PLUGIN]);
            expect(pathAndOwner({ type: 'create', kind: NETWORK_POLICY, namespace: 'demo' }, OCP_4_22))
                .toEqual(['/k8s/ns/demo/networking.k8s.io~v1~NetworkPolicy/~new/form', NETWORKING_PLUGIN]);
            expect(pathAndOwner({ type: 'create', kind: MULTI_NETWORK_POLICY, namespace: 'demo' }, OCP_4_22))
                .toEqual(['/k8s/ns/demo/k8s.cni.cncf.io~v1beta1~MultiNetworkPolicy/~new/form', NETWORKING_PLUGIN]);
        });

        it('opens the console\'s own create page when the plugin is absent', () => {
            const crdsOnly = capabilities({}, OCP_4_22.crds);
            expect(pathAndOwner({ type: 'create', kind: CUDN }, crdsOnly))
                .toEqual(['/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/~new', CONSOLE_OWNER]);
            expect(pathAndOwner({ type: 'create', kind: NETWORK_POLICY, namespace: 'demo' }, BARE))
                .toEqual(['/k8s/ns/demo/networking.k8s.io~v1~NetworkPolicy/~new', CONSOLE_OWNER]);
        });

        it('uses the console\'s create page for a kind the plugin has no form route for', () => {
            expect(pathAndOwner({ type: 'create', kind: NNCP }, OCP_4_22))
                .toEqual(['/k8s/cluster/nmstate.io~v1~NodeNetworkConfigurationPolicy/~new', CONSOLE_OWNER]);
        });

        it('offers nothing when the CRD is absent', () => {
            expect(resolveLinkOut({ type: 'create', kind: CUDN }, BARE)).toBeUndefined();
        });
    });

    describe('an interface on a node', () => {
        const iface: LinkTarget = { type: 'node-interface', node: 'worker-1', name: 'ens192', interfaceType: 'ethernet' };

        it('gets a secondary link to its details on nmstate\'s state page, by node, name and type', () => {
            const { primary, secondary } = resolveLinkOuts(iface, OCP_4_22);
            expect(primary).toBeUndefined();
            expect(secondary).toEqual([{
                id: 'nmstate-interface',
                path: '/k8s/cluster/nmstate.io~v1beta1~NodeNetworkState?selectedState=worker-1&selectedInterface=ens192&selectedInterfaceType=ethernet',
                owner: NMSTATE_PLUGIN,
                label: 'Interface details in nmstate',
            }]);
        });

        it('escapes a name that would break the query string', () => {
            const odd: LinkTarget = { ...iface, name: 'a&b=c' } as LinkTarget;
            expect(resolveLinkOuts(odd, OCP_5_1).secondary[0].path)
                .toBe('/k8s/cluster/nmstate.io~v1beta1~NodeNetworkState'
                    + '?selectedState=worker-1&selectedInterface=a%26b%3Dc&selectedInterfaceType=ethernet');
        });

        it('gets nothing when the nmstate plugin is absent', () => {
            expect(resolveLinkOuts(iface, BARE)).toEqual({ secondary: [] });
            // The networking plugin alone does not provide the page.
            expect(resolveLinkOuts(iface, capabilities({ [NETWORKING_PLUGIN]: ['/physical-networks'] })).secondary)
                .toEqual([]);
        });

        it('does not depend on the topology page: the state page comes with the plugin', () => {
            expect(resolveLinkOuts(iface, capabilities({ [NMSTATE_PLUGIN]: [] })).secondary).toHaveLength(1);
        });

        it('gets nothing when the cluster does not serve NodeNetworkState', () => {
            expect(resolveLinkOuts(iface, capabilities({ [NMSTATE_PLUGIN]: [] }, allCrds(false))).secondary)
                .toEqual([]);
        });

        it('gets nothing without all three parts of the selection', () => {
            expect(resolveLinkOuts({ ...iface, interfaceType: '' } as LinkTarget, OCP_4_22).secondary).toEqual([]);
        });
    });

    describe('a Localnet physical network', () => {
        const physnet: LinkTarget = { type: 'physical-network', name: 'physnet' };

        it('opens Physical networks, owned by nmstate on 4.22 and by networking on 5.1', () => {
            expect(pathAndOwner(physnet, OCP_4_22)).toEqual(['/physical-networks', NMSTATE_PLUGIN]);
            expect(pathAndOwner(physnet, OCP_5_1)).toEqual(['/physical-networks', NETWORKING_PLUGIN]);
        });

        it('has no page, and no generic fallback, when neither plugin provides one', () => {
            expect(resolveLinkOut(physnet, BARE)).toBeUndefined();
            expect(resolveLinkOut(physnet, capabilities({ [NMSTATE_PLUGIN]: ['/node-network-configuration'] })))
                .toBeUndefined();
        });

        it('ignores the same href from a plugin that is not known to own the page', () => {
            expect(resolveLinkOut(physnet, capabilities({ 'some-other-plugin': ['/physical-networks'] })))
                .toBeUndefined();
        });
    });

    describe('console pages that need no plugin', () => {
        it('opens a namespace as its Project', () => {
            expect(pathAndOwner({ type: 'namespace', name: 'demo' }, BARE))
                .toEqual(['/k8s/cluster/projects/demo', CONSOLE_OWNER]);
        });

        it('opens a kind\'s API reference', () => {
            expect(resolveLinkOut({ type: 'api-resource', kind: CUDN })?.path)
                .toBe('/api-resource/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/');
        });

        it('passes an in-console path through and refuses anything else', () => {
            expect(resolveLinkOut({ type: 'path', path: '/api-resource/cluster/core~v1~Namespace/instances?label=a%3Db' })?.path)
                .toBe('/api-resource/cluster/core~v1~Namespace/instances?label=a%3Db');
            expect(resolveLinkOut({ type: 'path', path: 'https://example.com/' })).toBeUndefined();
        });
    });

    it('never returns an absolute URL', () => {
        const targets: LinkTarget[] = [
            { type: 'resource', ref: { ...CUDN, name: 'a' } },
            { type: 'list', kind: UDN, scope: 'all-namespaces' },
            { type: 'create', kind: UDN, namespace: 'a' },
            { type: 'namespace', name: 'a' },
            { type: 'api-resource', kind: CUDN },
            { type: 'node-interface', node: 'n', name: 'i', interfaceType: 'bond' },
            { type: 'physical-network', name: 'p' },
        ];
        for (const caps of [BARE, OCP_4_22, OCP_5_1]) {
            for (const target of targets) {
                const { primary, secondary } = resolveLinkOuts(target, caps);
                for (const link of [...(primary ? [primary] : []), ...secondary]) {
                    expect(link.path).toMatch(/^\/[^/]/);
                }
            }
        }
    });

    it('asks the console about exactly the CRDs the registry tracks', () => {
        const extensions: Array<{ type: string; properties: { flag: string; model: { group: string; version: string; kind: string } } }> =
            JSON.parse(fs.readFileSync(path.join(process.cwd(), 'console-extensions.json'), 'utf-8'));
        const declared = extensions
            .filter((extension) => extension.type === 'console.flag/model')
            .map(({ properties: { flag, model } }) => `${flag}=${model.group}~${model.version}~${model.kind}`)
            .sort();
        expect(declared).toEqual(CRD_FLAGS.map(({ flag, kind }) => `${flag}=${kindReference(kind)}`).sort());
    });
});

describe('Network Observability traffic links (ovn-recon-vqd.1)', () => {
    const node: LinkTarget = { type: 'resource', ref: { apiVersion: 'v1', kind: 'Node', name: 'worker-1' } };
    const cudn: LinkTarget = { type: 'resource', ref: { ...CUDN, name: 'machinenet' } };
    const udn: LinkTarget = { type: 'resource', ref: { ...UDN, namespace: 'demo', name: 'blue' } };
    const service: LinkTarget = {
        type: 'resource', ref: { apiVersion: 'v1', kind: 'Service', namespace: 'demo', name: 'web' },
    };
    const everyTarget = [node, cudn, udn, service];

    const traffic = (target: LinkTarget, caps = NETOBSERV_FULL) =>
        resolveLinkOuts(target, caps).secondary.filter((link) => link.owner === NETOBSERV_PLUGIN);
    const paths = (target: LinkTarget, caps = NETOBSERV_FULL) => traffic(target, caps).map((link) => link.path);

    const UDN_MAPPING = new Set([NETOBSERV_UDN_MAPPING]);

    describe('with the plugin loaded and everything it needs', () => {
        it('opens a node on netobserv\'s own tab of the Node page', () => {
            expect(traffic(node)).toEqual([{
                id: 'netobserv-node',
                path: '/k8s/cluster/core~v1~Node/worker-1/netflow',
                owner: NETOBSERV_PLUGIN,
                label: 'View traffic',
                hint: 'Network Observability: traffic to and from this node',
            }]);
        });

        it('filters the traffic page to a CUDN by name', () => {
            expect(paths(cudn)).toEqual(['/netflow-traffic?filters=udns%3Dmachinenet']);
        });

        it('filters the traffic page to a UDN by namespace.name', () => {
            expect(paths(udn)).toEqual(['/netflow-traffic?filters=udns%3Ddemo.blue']);
        });

        it('filters the traffic page to a Service as the destination', () => {
            expect(paths(service)).toEqual(['/netflow-traffic?filters=dst_resource%3DService.demo.web']);
        });

        it('leaves the primary page of each object alone', () => {
            expect(resolveLinkOut(node, NETOBSERV_FULL)?.path).toBe('/k8s/cluster/core~v1~Node/worker-1');
            expect(resolveLinkOut(service, NETOBSERV_FULL)?.owner).toBe(CONSOLE_OWNER);
        });

        it('offers nothing for a kind it has no filter for, or for a YAML view', () => {
            expect(traffic({ type: 'resource', ref: { apiVersion: 'v1', kind: 'Pod', namespace: 'demo', name: 'web-1' } }))
                .toEqual([]);
            expect(traffic({
                type: 'resource',
                ref: { apiVersion: 'k8s.cni.cncf.io/v1', kind: 'NetworkAttachmentDefinition', namespace: 'demo', name: 'blue' },
            })).toEqual([]);
            expect(traffic({ ...node, view: 'yaml' } as LinkTarget)).toEqual([]);
            expect(traffic({ ...node, view: 'events' } as LinkTarget)).toEqual([]);
            expect(traffic({ type: 'node-interface', node: 'worker-1', name: 'ens192', interfaceType: 'ethernet' }))
                .toEqual([]);
        });

        it('offers nothing for a namespaced object that names no namespace', () => {
            expect(traffic({ type: 'resource', ref: { ...UDN, name: 'blue' } })).toEqual([]);
            expect(traffic({ type: 'resource', ref: { apiVersion: 'v1', kind: 'Service', name: 'web' } })).toEqual([]);
        });
    });

    describe('with the plugin absent', () => {
        it.each([['no plugin at all', BARE], ['the 4.22 plugins', OCP_4_22], ['nothing loaded', NO_CAPABILITIES]])(
            'offers no traffic link with %s',
            (_name, caps) => {
                for (const target of everyTarget) expect(traffic(target, caps)).toEqual([]);
            },
        );

        it('is not fooled by the forms-only netobserv plugin, or by answers without the traffic page', () => {
            const formsOnly = {
                ...capabilities({ 'netobserv-plugin-static': [], [NETOBSERV_PLUGIN]: ['/network-health'] }),
                netobserv: NETOBSERV_FULL.netobserv,
            };
            for (const target of everyTarget) expect(traffic(target, formsOnly)).toEqual([]);
        });
    });

    describe('with the plugin loaded but not what a link needs', () => {
        it('offers nothing while nothing is known yet', () => {
            for (const caps of [withNetobserv(undefined), withNetobserv({})]) {
                for (const target of everyTarget) expect(traffic(target, caps)).toEqual([]);
            }
        });

        it('offers a node on Loki alone, or on node metrics alone, and not without both', () => {
            expect(paths(node, withNetobserv({ loki: true }))).toHaveLength(1);
            expect(paths(node, withNetobserv({ loki: false, nodeMetrics: true }))).toHaveLength(1);
            expect(paths(node, withNetobserv({ loki: false, nodeMetrics: false, features: UDN_MAPPING }))).toEqual([]);
            expect(paths(node, withNetobserv({ loki: false }))).toEqual([]);
        });

        it('offers a network only when the FlowCollector maps UDNs', () => {
            for (const target of [cudn, udn]) {
                expect(paths(target, withNetobserv({ loki: true, nodeMetrics: true, features: new Set(['PacketDrop']) })))
                    .toEqual([]);
                // The FlowCollector could not be read, so its features are unknown.
                expect(paths(target, withNetobserv({ loki: true }))).toEqual([]);
            }
        });

        it('offers a network only with Loki, where the UDN filter is answered', () => {
            for (const target of [cudn, udn]) {
                expect(paths(target, withNetobserv({ loki: false, nodeMetrics: true, features: UDN_MAPPING }))).toEqual([]);
                expect(paths(target, withNetobserv({ nodeMetrics: true, features: UDN_MAPPING }))).toEqual([]);
            }
        });

        it('offers a Service only with Loki, where the resource filter is answered', () => {
            expect(paths(service, withNetobserv({ loki: false, nodeMetrics: true, features: UDN_MAPPING }))).toEqual([]);
            expect(paths(service, withNetobserv({ nodeMetrics: true }))).toEqual([]);
            expect(paths(service, withNetobserv({ loki: true }))).toHaveLength(1);
        });
    });
});
