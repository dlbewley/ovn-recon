import { consoleHrefForRef, findingSubjectLink, nodePagePath } from './links';
import { cudnRef, makeFinding, nadRef, nncpRef, nodeRef } from './refs';
import type { Finding } from './types';

const finding = (overrides: Partial<Finding>): Finding => makeFinding({
    ruleId: 'test-rule',
    severity: 'warning',
    subject: { kind: 'graph-node', node: 'worker-1', graphNodeId: 'iface:ens224' },
    scope: { node: 'worker-1' },
    summary: 'Something on worker-1.',
    evidence: [],
    remedy: { text: 'Fix it.', target: nodeRef('worker-1') },
    ...overrides
});

describe('finding links', () => {
    it('builds console paths for cluster, namespaced and core objects', () => {
        expect(consoleHrefForRef(nncpRef('br-ex-policy'), true))
            .toBe('/k8s/cluster/nmstate.io~v1~NodeNetworkConfigurationPolicy/br-ex-policy/yaml');
        expect(consoleHrefForRef(nadRef({ metadata: { name: 'blue', namespace: 'demo' } })))
            .toBe('/k8s/ns/demo/k8s.cni.cncf.io~v1~NetworkAttachmentDefinition/blue');
        expect(consoleHrefForRef(nodeRef('worker-1'))).toBe('/k8s/cluster/core~v1~Node/worker-1');
    });

    it('links a graph-node finding to its node page with ?select=', () => {
        expect(findingSubjectLink(finding({}))).toEqual({
            to: '/ovn-recon/node-network-state/worker-1?select=iface:ens224', label: 'worker-1'
        });
        expect(nodePagePath('worker-1')).toBe('/ovn-recon/node-network-state/worker-1');
    });

    it('links a network-wide CUDN finding to a node page with the CUDN selected', () => {
        const network = finding({ subject: { kind: 'k8s', ref: cudnRef('vlan-333') }, scope: { network: cudnRef('vlan-333') } });
        expect(findingSubjectLink(network, 'control-1')).toEqual({
            to: '/ovn-recon/node-network-state/control-1?select=cudn:vlan-333',
            label: 'ClusterUserDefinedNetwork vlan-333'
        });
    });

    it('links a NAD finding, whose lane is hidden by default, to the console', () => {
        const ref = nadRef({ metadata: { name: 'blue', namespace: 'demo' } });
        expect(findingSubjectLink(finding({ subject: { kind: 'k8s', ref }, scope: { network: ref } }), 'control-1')).toEqual({
            href: '/k8s/ns/demo/k8s.cni.cncf.io~v1~NetworkAttachmentDefinition/blue',
            label: 'NetworkAttachmentDefinition demo/blue'
        });
    });

    it('falls back to the console when there is no node to show a CUDN on', () => {
        const network = finding({ subject: { kind: 'k8s', ref: cudnRef('vlan-333') }, scope: { network: cudnRef('vlan-333') } });
        expect(findingSubjectLink(network).href).toBe('/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/vlan-333');
    });
});
