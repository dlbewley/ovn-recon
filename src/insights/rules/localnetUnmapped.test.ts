import type { ClusterUserDefinedNetwork, NetworkAttachmentDefinition, NodeNetworkState } from '../../types';
import { clone, clusterContext, loadItems } from '../testing';
import { localnetUnmapped } from './localnetUnmapped';

// A real capture: ten nodes, six Localnet CUDNs, the NADs they generated. physnet is
// mapped on all ten, physnet-vmdata on four, thirdmap and secondmap on none.
const coverage = {
    cudns: loadItems<ClusterUserDefinedNetwork>('cudn', 'cluster-localnet-coverage.json'),
    nads: loadItems<NetworkAttachmentDefinition>('nad', 'cluster-localnet-coverage.json'),
    nodeNetworkStates: loadItems<NodeNetworkState>('nns', 'cluster-localnet-coverage.json')
};

describe('localnet-unmapped', () => {
    it('fires once per network whose physical network no node maps', () => {
        const findings = localnetUnmapped.evaluate(clusterContext(coverage));

        expect(findings.map((f) => f.subject)).toEqual([
            { kind: 'k8s', ref: expect.objectContaining({ kind: 'ClusterUserDefinedNetwork', name: 'vlan-333' }) },
            { kind: 'k8s', ref: expect.objectContaining({ kind: 'ClusterUserDefinedNetwork', name: 'vlan-333-again' }) },
            { kind: 'k8s', ref: expect.objectContaining({ kind: 'ClusterUserDefinedNetwork', name: 'vlan-999' }) }
        ]);
        expect(findings[0].summary).toBe(
            'ClusterUserDefinedNetwork vlan-333 names physical network thirdmap, which no node maps to a bridge.');
        expect(findings[0].scope).toEqual({ network: expect.objectContaining({ name: 'vlan-333' }) });
        expect(findings[0].evidence[1].sources).toHaveLength(10);
        expect(findings[0].evidence[2].fact).toBe(
            'Physical networks that are mapped: physnet (10 of 10 nodes), physnet-vmdata (4 of 10 nodes).');
        expect(findings[0].remedy).toEqual(expect.objectContaining({
            target: expect.objectContaining({ kind: 'ClusterUserDefinedNetwork', name: 'vlan-333' }),
            path: 'spec.network.localnet.physicalNetworkName'
        }));
    });

    it('is quiet for networks mapped everywhere, and for partial coverage', () => {
        const findings = localnetUnmapped.evaluate(clusterContext(coverage));
        const names = findings.map((f) => f.subject.kind === 'k8s' && f.subject.ref.name);
        // machinenet (physnet, every node) and vlan-1924/vlan-1926 (physnet-vmdata,
        // four nodes of ten) are fine; their generated NADs do not repeat the CUDNs.
        expect(names).not.toContain('machinenet');
        expect(names).not.toContain('vlan-1924');
        expect(names).not.toContain('vlan-1926');
        expect(findings.every((f) => f.subject.kind === 'k8s' && f.subject.ref.kind === 'ClusterUserDefinedNetwork'))
            .toBe(true);
    });

    it('is quiet when the nodes\' NodeNetworkState is not available', () => {
        expect(localnetUnmapped.evaluate(clusterContext({ ...coverage, nodeNetworkStates: undefined }))).toEqual([]);
        expect(localnetUnmapped.evaluate(clusterContext({ ...coverage, nodeNetworkStates: [] }))).toEqual([]);
    });

    it('does not count a mapping nmstate was asked to remove', () => {
        const states = clone(coverage.nodeNetworkStates);
        states.forEach((nns) => nns.status?.currentState?.ovn?.['bridge-mappings']
            .forEach((mapping) => { if (mapping.localnet === 'physnet-vmdata') mapping.state = 'absent'; }));
        const names = localnetUnmapped.evaluate(clusterContext({ ...coverage, nodeNetworkStates: states }))
            .map((f) => f.subject.kind === 'k8s' && f.subject.ref.name);
        expect(names).toEqual(['vlan-1924', 'vlan-1926', 'vlan-333', 'vlan-333-again', 'vlan-999']);
    });

    it('reports a standalone Localnet NAD, marking a defaulted physical network as inferred', () => {
        const standalone: NetworkAttachmentDefinition = {
            apiVersion: 'k8s.cni.cncf.io/v1',
            kind: 'NetworkAttachmentDefinition',
            metadata: { name: 'tenant-x', namespace: 'tenant-x' },
            spec: { config: JSON.stringify({ cniVersion: '0.3.1', name: 'tenant-x', type: 'ovn-k8s-cni-overlay', topology: 'localnet' }) }
        };
        const findings = localnetUnmapped.evaluate(clusterContext({ ...coverage, nads: [...coverage.nads, standalone] }));
        const nadFinding = findings.find((f) => f.subject.kind === 'k8s' && f.subject.ref.kind === 'NetworkAttachmentDefinition');

        expect(nadFinding?.evidence[0]).toEqual(expect.objectContaining({
            fact: 'NetworkAttachmentDefinition tenant-x names physical network tenant-x.',
            path: 'spec.config.name',
            inferred: expect.stringContaining('uses the network name')
        }));
        // Nothing to point the remedy at a field: the field is not set.
        expect(nadFinding?.remedy.path).toBeUndefined();
    });

    it('skips a CUDN-generated NAD even without owner references', () => {
        const nads = clone(coverage.nads).map((nad) => ({ ...nad, metadata: { ...nad.metadata, ownerReferences: undefined } }));
        const findings = localnetUnmapped.evaluate(clusterContext({ ...coverage, nads }));
        expect(findings).toHaveLength(3);
    });
});
