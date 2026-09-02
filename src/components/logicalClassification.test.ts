import { LogicalDatabase, LogicalTopologySnapshot } from '../types';
import {
    classifyDatabase,
    classifySwitchPort,
    DEFAULT_NETWORK,
    mangleNetworkName,
    networkResourceRef,
} from './logicalClassification';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';
import cnv2 from '../../collector/fixtures/snapshots/cnv-2.json';
import ctrl1 from '../../collector/fixtures/snapshots/ctrl-1.json';

const zones: Record<string, LogicalDatabase> = {
    'cnv-1': (cnv1 as unknown as LogicalTopologySnapshot).database as LogicalDatabase,
    'cnv-2': (cnv2 as unknown as LogicalTopologySnapshot).database as LogicalDatabase,
    'ctrl-1': (ctrl1 as unknown as LogicalTopologySnapshot).database as LogicalDatabase,
};

const LAYER2_CUDN = 'cluster_udn_example-p-cudn';

describe('mangleNetworkName', () => {
    it('replaces dashes with dots as OVN-Kubernetes does', () => {
        expect(mangleNetworkName('example-p-cudn')).toBe('example.p.cudn');
        expect(mangleNetworkName('plain')).toBe('plain');
    });
});

describe('classifyDatabase against the captured corpus', () => {
    it.each(Object.keys(zones))('%s: every construct gets a concrete role', (zone) => {
        const classified = classifyDatabase(zones[zone]);
        const unrecognized = classified.constructs.filter(
            (construct) => construct.role === 'other-router' || construct.role === 'other-switch',
        );
        expect(unrecognized.map((construct) => construct.name)).toEqual([]);
    });

    it('classifies the default network ladder on cnv-1', () => {
        const classified = classifyDatabase(zones['cnv-1']);
        const byName = new Map(classified.constructs.map((construct) => [construct.name, construct]));

        expect(byName.get('ovn_cluster_router')).toMatchObject({
            role: 'cluster-router',
            tier: 'cluster-routing',
            network: DEFAULT_NETWORK,
        });
        expect(byName.get('GR_cnv-1')).toMatchObject({
            role: 'gateway-router',
            tier: 'gateway',
            network: DEFAULT_NETWORK,
            node: 'cnv-1',
        });
        expect(byName.get('join')).toMatchObject({ role: 'join-switch', tier: 'waist' });
        expect(byName.get('transit_switch')).toMatchObject({ role: 'transit-switch', tier: 'waist' });
        expect(byName.get('ext_cnv-1')).toMatchObject({
            role: 'external-switch',
            tier: 'external',
            node: 'cnv-1',
        });
        expect(byName.get('cnv-1')).toMatchObject({
            role: 'node-switch',
            tier: 'workload-switch',
            network: DEFAULT_NETWORK,
            node: 'cnv-1',
        });
    });

    it('classifies the Layer2 primary CUDN ladder on cnv-1', () => {
        const classified = classifyDatabase(zones['cnv-1']);
        const byName = new Map(classified.constructs.map((construct) => [construct.name, construct]));

        expect(byName.get('cluster_udn_example.p.cudn_transit_router')).toMatchObject({
            role: 'transit-router',
            tier: 'cluster-routing',
            network: LAYER2_CUDN,
            topology: 'layer2',
        });
        expect(byName.get('GR_cluster_udn_example.p.cudn_cnv-1')).toMatchObject({
            role: 'gateway-router',
            network: LAYER2_CUDN,
            node: 'cnv-1',
        });
        expect(byName.get('ext_cluster_udn_example.p.cudn_cnv-1')).toMatchObject({
            role: 'external-switch',
            network: LAYER2_CUDN,
            node: 'cnv-1',
        });
        expect(byName.get('cluster_udn_example.p.cudn_ovn_layer2_switch')).toMatchObject({
            role: 'layer2-switch',
            tier: 'workload-switch',
            network: LAYER2_CUDN,
        });
    });

    it('classifies the Layer3 namespaced UDN ladder on cnv-1', () => {
        const classified = classifyDatabase(zones['cnv-1']);
        const byName = new Map(classified.constructs.map((construct) => [construct.name, construct]));
        const L3_UDN = 'demo-mirror_example-l3-udn';

        expect(byName.get('demo.mirror_example.l3.udn_ovn_cluster_router')).toMatchObject({
            role: 'cluster-router',
            tier: 'cluster-routing',
            network: L3_UDN,
            topology: 'layer3',
        });
        expect(byName.get('demo.mirror_example.l3.udn_cnv-1')).toMatchObject({
            role: 'node-switch',
            tier: 'workload-switch',
            network: L3_UDN,
            node: 'cnv-1',
        });
        expect(byName.get('demo.mirror_example.l3.udn_transit_switch')).toMatchObject({
            role: 'transit-switch',
            tier: 'waist',
            network: L3_UDN,
        });
    });

    it('resolves network identities to their owning CRs', () => {
        expect(networkResourceRef('default')).toBeUndefined();
        expect(networkResourceRef('cluster_udn_example-p-cudn')).toEqual({
            apiVersion: 'k8s.ovn.org/v1',
            kind: 'ClusterUserDefinedNetwork',
            name: 'example-p-cudn',
        });
        expect(networkResourceRef('demo-mirror_example-l3-udn')).toEqual({
            apiVersion: 'k8s.ovn.org/v1',
            kind: 'UserDefinedNetwork',
            namespace: 'demo-mirror',
            name: 'example-l3-udn',
        });
    });

    it('classifies Localnet CUDN switches as single-rung ladders', () => {
        const classified = classifyDatabase(zones['cnv-1']);
        const localnets = classified.constructs.filter((construct) => construct.role === 'localnet-switch');
        expect(localnets.map((construct) => construct.network).sort()).toEqual([
            'cluster_udn_machinenet',
            'cluster_udn_vlan-1924',
        ]);
    });

    it('lists networks with the default network first', () => {
        const classified = classifyDatabase(zones['ctrl-1']);
        expect(classified.networks[0]).toBe(DEFAULT_NETWORK);
        expect(classified.networks).toContain(LAYER2_CUDN);
        expect(classified.networks).toContain('cluster_udn_machinenet');
    });
});

describe('classifySwitchPort', () => {
    it('classifies every port kind present on ctrl-1', () => {
        const classified = classifyDatabase(zones['ctrl-1']);
        const roleCounts = new Map<string, number>();
        for (const port of classified.ports) {
            roleCounts.set(port.role, (roleCounts.get(port.role) ?? 0) + 1);
        }

        expect(roleCounts.get('router-link-port')).toBe(9);
        expect(roleCounts.get('localnet-port')).toBe(4);
        expect(roleCounts.get('remote-port')).toBe(18);
        expect(roleCounts.get('pod-port')).toBeGreaterThan(10);
        expect(roleCounts.get('management-port')).toBeGreaterThanOrEqual(2);
        expect(roleCounts.get('other-port') ?? 0).toBe(0);
    });

    it('extracts namespace and pod from pod ports', () => {
        const port = classifySwitchPort({
            uuid: 'p1',
            name: 'openshift-monitoring_prometheus-k8s-0',
        });
        expect(port).toMatchObject({
            role: 'pod-port',
            namespace: 'openshift-monitoring',
            pod: 'prometheus-k8s-0',
        });
    });

    it('extracts namespace and pod from secondary-network pod ports', () => {
        // Live-cluster shape (ovn-recon-3um): a localnet-attached pod port
        // carries a network prefix before <namespace>_<pod>.
        const port = classifySwitchPort({
            uuid: 'p3',
            name: 'demo.mirror.vlan.1924_demo-mirror_virt-launcher-ex-vm-xhd67',
            externalIds: {
                'k8s.ovn.org/nad': 'demo-mirror/vlan-1924',
                namespace: 'demo-mirror',
                pod: 'true',
            },
        });
        expect(port).toMatchObject({
            role: 'pod-port',
            namespace: 'demo-mirror',
            pod: 'virt-launcher-ex-vm-xhd67',
        });
    });

    it('parses secondary-network pod ports positionally without externalIds', () => {
        const port = classifySwitchPort({
            uuid: 'p4',
            name: 'demo.mirror.vlan.1924_demo-mirror_virt-launcher-ex-vm-xhd67',
        });
        expect(port).toMatchObject({
            role: 'pod-port',
            namespace: 'demo-mirror',
            pod: 'virt-launcher-ex-vm-xhd67',
        });
    });

    it('extracts the peer node from transit remote ports', () => {
        const port = classifySwitchPort({ uuid: 'p2', name: 'tstor-cnv-4', type: 'remote' });
        expect(port).toMatchObject({ role: 'remote-port', node: 'cnv-4' });
    });
});
