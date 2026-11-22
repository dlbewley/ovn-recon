import type { ClusterUserDefinedNetwork, NetworkAttachmentDefinition, NodeNetworkState, RouteAdvertisements } from '../types';
import { buildGraphContext } from '../topology/context';
import { clusterMtuOf, isNetworkConfigRef, networkClusterOperatorRef, operatorNetworkRef } from './cno';
import { cnoFixture, cnoSourcesOf, networkConfigOf } from './cnoTesting';
import { evaluatePhysical } from './evaluate';
import { findingSubjectLink } from './links';
import { makeFinding } from './refs';
import { loadItems } from './testing';

/**
 * The cno-* rules together (ovn-recon-n7r.3): a healthy default cluster raises none
 * of them, and their findings link to the Network config tab.
 */
describe('the Cluster Network Operator rules', () => {
    it('raise nothing on a healthy default cluster', () => {
        const cudns = loadItems<ClusterUserDefinedNetwork>('cudn', 'cluster-localnet-coverage.json');
        const nads = loadItems<NetworkAttachmentDefinition>('nad', 'cluster-localnet-coverage.json');
        const nodeNetworkStates = loadItems<NodeNetworkState>('nns', 'cluster-localnet-coverage.json');
        const networkConfig = networkConfigOf();
        const clusterMtu = clusterMtuOf(networkConfig.sources);
        expect(clusterMtu).toEqual(expect.objectContaining({ value: 1400, overhead: 100 }));

        const findings = evaluatePhysical.cluster(
            { cudns, udns: [], nads, nodeNetworkStates, networkConfig },
            nodeNetworkStates.map((nns) => buildGraphContext({ nns, cudns, nads, clusterMtu }))
        );
        expect(findings.filter((f) => f.ruleId.startsWith('cno-'))).toEqual([]);
        expect(findings.filter((f) => f.ruleId === 'mtu-exceeds-uplink' && f.key.endsWith('cluster-network'))).toEqual([]);
    });

    it('stay quiet while no source has been read', () => {
        const unread = networkConfigOf(cnoFixture(), {
            operatorNetwork: { status: 'forbidden' }, configNetwork: { status: 'loading' }, clusterOperator: { status: 'forbidden' },
            routeAdvertisements: [{ metadata: { name: 'default' } } as RouteAdvertisements]
        });
        const findings = evaluatePhysical.network({ cudns: [], udns: [], nads: [], networkConfig: unread });
        expect(findings.filter((f) => f.ruleId.startsWith('cno-'))).toEqual([]);
        expect(clusterMtuOf(unread.sources)).toBeUndefined();
    });

    it('link a finding about the network configuration to the Network config tab', () => {
        expect(isNetworkConfigRef(operatorNetworkRef)).toBe(true);
        expect(isNetworkConfigRef({ group: 'k8s.ovn.org', version: 'v1', kind: 'ClusterUserDefinedNetwork', name: 'x' })).toBe(false);
        const finding = makeFinding({
            ruleId: 'cno-operator-unhealthy', severity: 'warning',
            subject: { kind: 'k8s', ref: networkClusterOperatorRef }, scope: {},
            summary: 's', evidence: [], remedy: { text: 't', target: networkClusterOperatorRef }
        });
        expect(findingSubjectLink(finding)).toEqual({ to: '/ovn-recon/network-config', label: 'ClusterOperator network' });
    });

    it('takes the MTU from the operator spec when the cluster configuration is unread', () => {
        const sources = cnoSourcesOf(cnoFixture(), { configNetwork: { status: 'forbidden' } });
        expect(clusterMtuOf(sources)).toEqual(expect.objectContaining({
            value: 1400, path: 'spec.defaultNetwork.ovnKubernetesConfig.mtu'
        }));
    });
});
