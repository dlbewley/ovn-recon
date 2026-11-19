import type { NodeNetworkState, UserDefinedNetwork } from '../../types';
import { DEFAULT_ANNOTATION, masqueradeNode, primaryCudn, primaryNad, SNAPSHOT_NODES } from '../masqueradeTesting';
import { clone, clusterContext, loadFixture, loadSnapshot } from '../testing';
import type { ClusterNetworkInputs, ZoneDatabase } from '../types';
import { masqueradeSubnetOverlap } from './masqueradeSubnetOverlap';

const nns = loadFixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json');
const zones = (): ZoneDatabase[] => SNAPSHOT_NODES.map((node) => ({ node, database: loadSnapshot(node).database! }));

/** A healthy cluster: the default /17, a primary CUDN, br-ex's own masquerade address, the zones' join and transit ports. */
const healthy = (): Partial<ClusterNetworkInputs> => ({
    nodes: SNAPSHOT_NODES.map((name) => masqueradeNode(name, DEFAULT_ANNOTATION)),
    cudns: [clone(primaryCudn)],
    nads: [primaryNad],
    nodeNetworkStates: [clone(nns)],
    zoneDatabases: zones()
});

describe('masquerade-subnet-overlap', () => {
    it('is quiet on a cluster with the default subnet, its own br-ex address and no overlap', () => {
        const cluster = healthy();
        expect(cluster.nodeNetworkStates![0].status!.currentState!.interfaces.some((iface) =>
            iface.name === 'br-ex' && iface.ipv4?.address?.some((address) => address.ip === '169.254.0.2'))).toBe(true);
        expect(masqueradeSubnetOverlap.evaluate(clusterContext(cluster))).toEqual([]);
    });

    it('fires on a CUDN subnet or a UDN join subnet inside the masquerade subnet', () => {
        const cluster = healthy();
        cluster.cudns![0].spec!.network!.layer2!.subnets = ['169.254.0.0/24'];
        const udn: UserDefinedNetwork = {
            apiVersion: 'k8s.ovn.org/v1', kind: 'UserDefinedNetwork',
            metadata: { name: 'blue', namespace: 'tenant' },
            spec: { topology: 'Layer3', layer3: { role: 'Primary', subnets: [{ cidr: '10.20.0.0/16' }], joinSubnets: ['169.254.64.0/20'] } }
        } as UserDefinedNetwork;
        cluster.udns = [udn];

        const findings = masqueradeSubnetOverlap.evaluate(clusterContext(cluster));
        expect(findings.map((finding) => finding.summary)).toEqual([
            'ClusterUserDefinedNetwork example-p-cudn subnet 169.254.0.0/24 overlaps the masquerade subnet 169.254.0.0/17.',
            'UserDefinedNetwork tenant/blue join subnet 169.254.64.0/20 overlaps the masquerade subnet 169.254.0.0/17.'
        ]);
        expect(findings[0]).toEqual(expect.objectContaining({
            severity: 'warning',
            subject: { kind: 'k8s', ref: expect.objectContaining({ kind: 'ClusterUserDefinedNetwork', name: 'example-p-cudn' }) },
            scope: { network: expect.objectContaining({ name: 'example-p-cudn' }) }
        }));
        expect(findings[0].remedy.path).toBe('spec.network.layer2.subnets');
        expect(findings[1].remedy.path).toBe('spec.layer3.joinSubnets');
        expect(findings[0].evidence[1].path).toBe('metadata.annotations["k8s.ovn.org/node-masquerade-subnet"]');
    });

    it('fires on a node interface address in the subnet, on that interface, and on br-ex holding more than its own address', () => {
        const cluster = healthy();
        const state = cluster.nodeNetworkStates![0];
        const interfaces = state.status!.currentState!.interfaces;
        const uplink = interfaces.find((iface) => iface.name !== 'br-ex' && iface.ipv4?.address !== undefined && iface.type === 'ethernet')
            ?? interfaces.find((iface) => iface.name !== 'br-ex')!;
        uplink.ipv4 = { enabled: true, address: [{ ip: '169.254.10.5', 'prefix-length': 24 }] };
        const brEx = interfaces.find((iface) => iface.name === 'br-ex' && iface.type === 'ovs-interface')!;
        brEx.ipv4!.address!.push({ ip: '169.254.0.9', 'prefix-length': 16 });

        const findings = masqueradeSubnetOverlap.evaluate(clusterContext(cluster));
        const node = state.metadata!.name!;
        expect(findings.map((finding) => [finding.subject, finding.scope, finding.summary])).toEqual(expect.arrayContaining([
            [{ kind: 'graph-node', node, graphNodeId: `iface:${uplink.name}` }, { node },
                `Interface ${uplink.name} on ${node} address 169.254.10.5/24 overlaps the masquerade subnet 169.254.0.0/17.`],
            [{ kind: 'graph-node', node, graphNodeId: 'iface:br-ex' }, { node },
                `Interface br-ex on ${node} address 169.254.0.9/16 overlaps the masquerade subnet 169.254.0.0/17.`]
        ]));
        expect(findings).toHaveLength(2);
    });

    it('fires once per join or transit subnet seen on router ports, however many zones carry it', () => {
        const cluster = healthy();
        cluster.zoneDatabases!.forEach(({ database }) => {
            database.logicalRouterPorts.forEach((port) => {
                if (port.name.startsWith('rtoj-')) port.networks = (port.networks ?? []).map((network) => network.replace(/^100\.64\./, '169.254.'));
            });
        });
        const findings = masqueradeSubnetOverlap.evaluate(clusterContext(cluster));
        expect(findings).toHaveLength(1);
        expect(findings[0]).toEqual(expect.objectContaining({
            subject: { kind: 'k8s', ref: expect.objectContaining({ kind: 'Network', name: 'cluster' }) },
            scope: {},
            summary: 'The join or transit subnet 169.254.0.0/16 overlaps the masquerade subnet 169.254.0.0/17.'
        }));
        expect(findings[0].evidence[0].origin).toMatch(/^the northbound database of node /);
    });

    it('falls back to the default subnet without Nodes, and is quiet with nothing to compare', () => {
        const cluster = { ...healthy(), nodes: undefined, zoneDatabases: undefined };
        cluster.cudns![0].spec!.network!.layer2!.subnets = ['169.254.0.0/24'];
        expect(masqueradeSubnetOverlap.evaluate(clusterContext(cluster))[0].evidence[1].inferred).toMatch(/default/);
        expect(masqueradeSubnetOverlap.evaluate(clusterContext({}))).toEqual([]);
    });
});
