import { evaluatePhysical, findingsForNetwork } from '../insights';
import { clone, loadFixture, loadItems } from '../insights/testing';
import type {
    ClusterUserDefinedNetwork,
    Interface,
    NetworkAttachmentDefinition,
    NodeNetworkState,
    UserDefinedNetwork
} from '../types';
import {
    buildPlacement,
    findNadOwner,
    findNetwork,
    generatedNads,
    isClusterDefaultNad,
    listNetworks,
    networkCreationFailure,
    NetworkInputs,
    networkPath,
    networkSummaryFacts,
    parseNetworkPath,
    physicalViewPath,
    placementSummary
} from './networkPageModel';

// A real capture: ten nodes, six Localnet CUDNs and the NADs they generated. physnet is
// mapped on all ten nodes, physnet-vmdata on the four workers, thirdmap and secondmap
// on none (test/fixtures/nns/cluster-localnet-coverage.md).
const coverage = {
    cudns: loadItems<ClusterUserDefinedNetwork>('cudn', 'cluster-localnet-coverage.json'),
    nads: loadItems<NetworkAttachmentDefinition>('nad', 'cluster-localnet-coverage.json'),
    nodeNetworkStates: loadItems<NodeNetworkState>('nns', 'cluster-localnet-coverage.json')
};
const coverageInputs: NetworkInputs = { cudns: coverage.cudns, udns: [], nads: coverage.nads, routeAdvertisements: [] };

const factValue = (facts: ReturnType<typeof networkSummaryFacts>, label: string) =>
    facts.find((fact) => fact.label === label);

describe('network paths', () => {
    it('round-trips each kind', () => {
        expect(networkPath({ kind: 'cudn', name: 'vlan-1924' })).toBe('/ovn-recon/networks/cudn/vlan-1924');
        expect(networkPath({ kind: 'udn', namespace: 'demo', name: 'blue' })).toBe('/ovn-recon/networks/udn/demo/blue');
        expect(parseNetworkPath('/ovn-recon/networks')).toEqual({ list: true });
        expect(parseNetworkPath('/ovn-recon/networks/')).toEqual({ list: true });
        expect(parseNetworkPath('/ovn-recon/networks/cudn/vlan-1924')).toEqual({ kind: 'cudn', name: 'vlan-1924' });
        expect(parseNetworkPath('/ovn-recon/networks/nad/default/vm-igb'))
            .toEqual({ kind: 'nad', namespace: 'default', name: 'vm-igb' });
    });

    it('rejects paths it does not serve', () => {
        expect(parseNetworkPath('/ovn-recon/networks/cudn')).toBeNull();
        expect(parseNetworkPath('/ovn-recon/networks/udn/only-name')).toBeNull();
        expect(parseNetworkPath('/ovn-recon/networks/pod/a/b')).toBeNull();
    });

    it('links the physical view with the select parameter', () => {
        expect(physicalViewPath('worker-1', 'ovn:physnet-vmdata'))
            .toBe('/ovn-recon/node-network-state/worker-1?select=ovn:physnet-vmdata');
    });
});

describe('listNetworks', () => {
    it('lists every CUDN and leaves out the NADs they generated', () => {
        const rows = listNetworks(coverageInputs);
        expect(rows.map((row) => `${row.kind}:${row.name}`)).toEqual([
            'cudn:machinenet', 'cudn:vlan-1924', 'cudn:vlan-1926',
            'cudn:vlan-333', 'cudn:vlan-333-again', 'cudn:vlan-999'
        ]);
    });

    it('lists a NAD that no CUDN or UDN generated', () => {
        const sriov = loadItems<NetworkAttachmentDefinition>('nad', 'sriov.json');
        const rows = listNetworks({ ...coverageInputs, nads: [...coverage.nads, ...sriov] });
        const nad = rows.find((row) => row.kind === 'nad');
        expect(nad).toEqual(expect.objectContaining({ name: 'vm-igb', namespace: 'default', topology: 'sriov', placement: 'none' }));
    });
});

describe('a Localnet CUDN wired on some nodes', () => {
    const record = findNetwork({ kind: 'cudn', name: 'vlan-1924' }, coverageInputs)!;

    it('reads its spec', () => {
        expect(record).toEqual(expect.objectContaining({
            topology: 'Localnet', role: 'Secondary', physicalNetworkName: 'physnet-vmdata', placement: 'localnet'
        }));
        const facts = networkSummaryFacts(record, coverageInputs);
        expect(factValue(facts, 'VLAN')?.value).toBe('1924');
        expect(factValue(facts, 'Physical network')).toEqual(expect.objectContaining({ value: 'physnet-vmdata', provenance: 'declared' }));
        expect(factValue(facts, 'IPAM')?.value).toBe('mode Disabled');
        // The CUDN declares no MTU; its generated NAD carries the applied one.
        expect(factValue(facts, 'MTU')).toEqual(expect.objectContaining({ value: '1500', provenance: 'declared' }));
        expect(factValue(facts, 'MTU')?.hint).toContain('demo-mirror/vlan-1924');
        // Namespaces come out of the NetworkCreated message, so they are inferred.
        expect(factValue(facts, 'Namespaces')).toEqual(expect.objectContaining({
            provenance: 'inferred',
            value: [expect.objectContaining({ text: 'demo-mirror' })]
        }));
        expect(factValue(facts, 'NetworkAttachmentDefinitions')?.value)
            .toEqual([expect.objectContaining({ text: 'demo-mirror/vlan-1924' })]);
        // A Localnet CUDN cannot be selected by a RouteAdvertisements.
        expect(factValue(facts, 'Route advertisements')).toBeUndefined();
    });

    it('is wired on the four workers only', () => {
        const placement = buildPlacement(record, coverage.nodeNetworkStates, coverageInputs);
        expect(placementSummary(placement)).toBe('Wired on 4 of 10 nodes');
        const wired = placement.rows.filter((row) => row.status === 'wired').map((row) => row.node);
        expect(wired).toEqual(['worker-1', 'worker-2', 'worker-3', 'worker-4']);

        const worker1 = placement.rows.find((row) => row.node === 'worker-1')!;
        expect(worker1.reason).toBe('physnet-vmdata is mapped to br-vmdata.');
        expect(worker1.bridge).toEqual({ name: 'br-vmdata', present: true });
        expect(worker1.uplinks).toEqual([{ name: 'ens224', type: 'ethernet', state: 'up', mtu: 1500 }]);
        expect(worker1.physicalPath).toBe('/ovn-recon/node-network-state/worker-1?select=ovn:physnet-vmdata');
        expect(worker1.logicalPath).toBe('/ovn-recon/ovn/worker-1');

        const control1 = placement.rows.find((row) => row.node === 'control-1')!;
        expect(control1.status).toBe('not-wired');
        expect(control1.reason).toBe('No bridge mapping names physnet-vmdata.');
        expect(control1.physicalPath).toBe('/ovn-recon/node-network-state/control-1?select=cudn:vlan-1924');
    });

    it('raises no finding: partial coverage is a fact, not a warning', () => {
        const findings = evaluatePhysical.network({ ...coverage, udns: [] });
        expect(findingsForNetwork(findings, record.ref)).toEqual([]);
    });

    it('says when the mapping names a bridge the node does not report', () => {
        const states = clone(coverage.nodeNetworkStates);
        const worker2 = states.find((nns) => nns.metadata?.name === 'worker-2')!;
        worker2.status!.currentState!.interfaces = worker2.status!.currentState!.interfaces
            .filter((iface) => iface.name !== 'br-vmdata');
        const row = buildPlacement(record, states, coverageInputs).rows.find((r) => r.node === 'worker-2')!;
        expect(row.status).toBe('not-wired');
        expect(row.reason).toBe('physnet-vmdata is mapped to br-vmdata, which this node does not report.');
    });
});

describe('a Localnet CUDN wired on no node', () => {
    const record = findNetwork({ kind: 'cudn', name: 'vlan-333' }, coverageInputs)!;

    it('is wired on none, and the existing finding names it once', () => {
        const placement = buildPlacement(record, coverage.nodeNetworkStates, coverageInputs);
        expect(placementSummary(placement)).toBe('Wired on 0 of 10 nodes');
        const findings = findingsForNetwork(evaluatePhysical.network({ ...coverage, udns: [] }), record.ref);
        expect(findings.map((finding) => finding.ruleId)).toEqual(['localnet-unmapped']);
    });
});

describe('a Primary Layer2 CUDN', () => {
    const cudns = loadItems<ClusterUserDefinedNetwork>('cudn', 'primary-cudn-vrf.json');
    const worker1 = loadFixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json');
    const renamed = (name: string, withoutVrf = false): NodeNetworkState => {
        const nns = clone(worker1);
        nns.metadata = { ...nns.metadata, name };
        if (withoutVrf) {
            nns.status!.currentState!.interfaces = nns.status!.currentState!.interfaces
                .filter((iface) => iface.type !== 'vrf');
        }
        return nns;
    };
    const inputs: NetworkInputs = { cudns, udns: [], nads: [], routeAdvertisements: [] };
    const record = findNetwork({ kind: 'cudn', name: 'example-p-cudn' }, inputs)!;

    it('finds its VRF on each node, inferred by name', () => {
        expect(record.placement).toBe('primary');
        const placement = buildPlacement(record, [worker1, renamed('worker-2')], inputs);
        expect(placementSummary(placement)).toBe('Wired on 2 of 2 nodes');
        const row = placement.rows[0];
        expect(row.vrf).toEqual(expect.objectContaining({
            name: 'example-p-cudn',
            provenance: 'inferred',
            managementPorts: [{ name: 'ovn-k8s-mp3', state: 'ignore' }]
        }));
        expect(row.vrf?.hint).toContain('Matched by name');
        expect(row.physicalPath).toBe('/ovn-recon/node-network-state/worker-1?select=vrf:example-p-cudn');
    });

    it('reports the VRF as declared when status.vrfName names it', () => {
        const declared = clone(cudns);
        declared[0].status = { ...declared[0].status, vrfName: 'example-p-cudn' };
        const declaredInputs = { ...inputs, cudns: declared };
        const row = buildPlacement(findNetwork({ kind: 'cudn', name: 'example-p-cudn' }, declaredInputs)!, [worker1], declaredInputs).rows[0];
        expect(row.vrf?.provenance).toBe('declared');
    });

    it('is not wired on a node without the VRF', () => {
        const placement = buildPlacement(record, [worker1, renamed('worker-2', true)], inputs);
        expect(placementSummary(placement)).toBe('Wired on 1 of 2 nodes');
        expect(placement.rows[1]).toEqual(expect.objectContaining({
            status: 'not-wired',
            reason: 'No VRF on this node was matched to example-p-cudn.'
        }));
    });

    it('shows its subnets and IPAM', () => {
        const facts = networkSummaryFacts(record, inputs);
        expect(factValue(facts, 'Subnets')?.value).toBe('10.1.2.0/24');
        expect(factValue(facts, 'IPAM')?.value).toBe('lifecycle Persistent');
        expect(factValue(facts, 'Route advertisements')).toEqual(expect.objectContaining({ value: [] }));
    });

    it('lists a RouteAdvertisements that selects it', () => {
        const ra = {
            metadata: { name: 'advertise-p' },
            spec: { networkSelectors: [{ clusterUserDefinedNetworkSelector: { networkSelector: { matchLabels: { 'network/cudn-p-10-1-2-0': '' } } } }] }
        };
        const facts = networkSummaryFacts(record, { ...inputs, routeAdvertisements: [ra] });
        expect(factValue(facts, 'Route advertisements')?.value).toEqual([expect.objectContaining({ text: 'advertise-p' })]);
    });
});

describe('a namespaced Primary UDN', () => {
    // Constructed: no UDN capture exists yet. The VRF takes the mp<ID>-udn-vrf form a
    // namespaced UDN always gets, and its NAD carries the network ID.
    const udn: UserDefinedNetwork = {
        apiVersion: 'k8s.ovn.org/v1',
        kind: 'UserDefinedNetwork',
        metadata: { name: 'tenant-blue', namespace: 'blue' },
        spec: { topology: 'Layer2', layer2: { role: 'Primary', subnets: ['10.20.0.0/24'] } },
        status: { conditions: [{ type: 'NetworkCreated', status: 'True', message: 'NetworkAttachmentDefinition has been created' }] }
    };
    const nad: NetworkAttachmentDefinition = {
        metadata: {
            name: 'tenant-blue',
            namespace: 'blue',
            annotations: { 'k8s.ovn.org/network-id': '12' },
            ownerReferences: [{ apiVersion: 'k8s.ovn.org/v1', kind: 'UserDefinedNetwork', name: 'tenant-blue', uid: 'x' }]
        },
        spec: { config: JSON.stringify({ type: 'ovn-k8s-cni-overlay', topology: 'layer2', role: 'primary', name: 'blue.tenant-blue', mtu: 1400 }) }
    };
    const nns = clone(loadFixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json'));
    nns.status!.currentState!.interfaces.push(
        { name: 'mp12-udn-vrf', type: 'vrf', state: 'up', vrf: { port: ['ovn-k8s-mp5'], 'route-table-id': 1012 } } as Interface,
        { name: 'ovn-k8s-mp5', type: 'ovs-interface', state: 'ignore', controller: 'br-int' } as Interface
    );
    const inputs: NetworkInputs = { cudns: [], udns: [udn], nads: [nad], routeAdvertisements: [] };
    const record = findNetwork({ kind: 'udn', namespace: 'blue', name: 'tenant-blue' }, inputs)!;

    it('is found by namespace and name, and not in another namespace', () => {
        expect(record).toEqual(expect.objectContaining({ topology: 'Layer2', role: 'Primary', placement: 'primary' }));
        expect(findNetwork({ kind: 'udn', namespace: 'red', name: 'tenant-blue' }, inputs)).toBeUndefined();
    });

    it('summarises its namespace, NAD and MTU', () => {
        const facts = networkSummaryFacts(record, inputs);
        expect(factValue(facts, 'Namespace')).toEqual(expect.objectContaining({ provenance: 'declared' }));
        expect(factValue(facts, 'NetworkAttachmentDefinitions')?.value).toEqual([expect.objectContaining({ text: 'blue/tenant-blue' })]);
        expect(factValue(facts, 'MTU')?.value).toBe('1400');
        expect(generatedNads(record, inputs)).toHaveLength(1);
    });

    it('matches its VRF by network ID, inferred', () => {
        const row = buildPlacement(record, [nns], inputs).rows[0];
        expect(row.status).toBe('wired');
        expect(row.vrf).toEqual(expect.objectContaining({
            name: 'mp12-udn-vrf', provenance: 'inferred', managementPorts: [{ name: 'ovn-k8s-mp5', state: 'ignore' }]
        }));
        expect(row.vrf?.hint).toContain('blue/tenant-blue');
    });

    it('keeps its NAD out of the list', () => {
        expect(listNetworks(inputs).map((r) => r.kind)).toEqual(['udn']);
        expect(findNadOwner(nad, inputs)).toEqual({ kind: 'udn', name: 'tenant-blue', namespace: 'blue' });
    });
});

describe('a Localnet NAD with no CUDN', () => {
    // A generated NAD from the capture, made standalone: no owner, its own network name.
    const nad = clone(coverage.nads.find((n) => n.metadata?.name === 'vlan-1924')!);
    nad.metadata = { ...nad.metadata, name: 'tenant-vmdata', ownerReferences: undefined };
    nad.spec = { config: JSON.stringify({ ...JSON.parse(nad.spec!.config), name: 'tenant-vmdata' }) };
    const inputs: NetworkInputs = { ...coverageInputs, nads: [...coverage.nads, nad] };
    const record = findNetwork({ kind: 'nad', namespace: 'demo-mirror', name: 'tenant-vmdata' }, inputs)!;

    it('is listed, and read from its config', () => {
        expect(listNetworks(inputs).filter((row) => row.kind === 'nad').map((row) => row.name)).toEqual(['tenant-vmdata']);
        expect(record).toEqual(expect.objectContaining({
            topology: 'Localnet', cniType: 'ovn-k8s-cni-overlay', physicalNetworkName: 'physnet-vmdata', owner: undefined
        }));
        const facts = networkSummaryFacts(record, inputs);
        expect(factValue(facts, 'VLAN')?.value).toBe('1924');
        expect(factValue(facts, 'MTU')).toEqual(expect.objectContaining({ value: '1500', hint: 'spec.config.mtu' }));
        expect(factValue(facts, 'NetworkAttachmentDefinitions')).toBeUndefined();
    });

    it('is wired where physnet-vmdata is mapped', () => {
        expect(placementSummary(buildPlacement(record, coverage.nodeNetworkStates, inputs))).toBe('Wired on 4 of 10 nodes');
    });

    it('marks a physical network name taken from the network name as inferred', () => {
        const unnamed = clone(nad);
        const config = JSON.parse(unnamed.spec!.config);
        delete config.physicalNetworkName;
        unnamed.spec = { config: JSON.stringify(config) };
        const r = findNetwork({ kind: 'nad', namespace: 'demo-mirror', name: 'tenant-vmdata' }, { ...inputs, nads: [unnamed] })!;
        expect(r.physicalNetworkName).toBe('tenant-vmdata');
        expect(factValue(networkSummaryFacts(r, inputs), 'Physical network')?.provenance).toBe('inferred');
    });

    it('names its CUDN owner when the NAD is a generated one', () => {
        const generated = findNetwork({ kind: 'nad', namespace: 'demo-mirror', name: 'vlan-1924' }, inputs)!;
        expect(generated.owner).toEqual({ kind: 'cudn', name: 'vlan-1924' });
    });
});

describe('a NAD outside OVN-Kubernetes', () => {
    const sriov = loadItems<NetworkAttachmentDefinition>('nad', 'sriov.json');
    const inputs: NetworkInputs = { cudns: [], udns: [], nads: sriov, routeAdvertisements: [] };

    it('has no per-node check and no summary line', () => {
        const record = findNetwork({ kind: 'nad', namespace: 'default', name: 'vm-igb' }, inputs)!;
        const placement = buildPlacement(record, coverage.nodeNetworkStates, inputs);
        expect(placement.rows.every((row) => row.status === 'not-checked')).toBe(true);
        expect(placementSummary(placement)).toBeUndefined();
    });

    it('checks the bridge of a bridge-CNI NAD', () => {
        const bridgeNad: NetworkAttachmentDefinition = {
            metadata: { name: 'br-vm', namespace: 'default' },
            spec: { config: JSON.stringify({ type: 'cnv-bridge', bridge: 'br-vmdata', vlan: 30 }) }
        };
        const bridgeInputs = { ...inputs, nads: [bridgeNad] };
        const record = findNetwork({ kind: 'nad', namespace: 'default', name: 'br-vm' }, bridgeInputs)!;
        expect(record.placement).toBe('bridge');
        const placement = buildPlacement(record, coverage.nodeNetworkStates, bridgeInputs);
        expect(placementSummary(placement)).toBe('Wired on 4 of 10 nodes');
        expect(placement.rows.find((row) => row.node === 'worker-1')?.physicalPath)
            .toBe('/ovn-recon/node-network-state/worker-1?select=iface:br-vmdata');
        expect(factValue(networkSummaryFacts(record, bridgeInputs), 'VLAN')?.value).toBe('30');
    });
});

describe('the cluster default network NAD', () => {
    const config = '{"cniVersion":"0.4.0","name":"ovn-kubernetes","type":"ovn-k8s-cni-overlay"}';
    const nad = (namespace: string, name = 'default', specConfig = config): NetworkAttachmentDefinition =>
        ({ metadata: { name, namespace }, spec: { config: specConfig } });
    const inputs = (item: NetworkAttachmentDefinition): NetworkInputs => ({ ...coverageInputs, nads: [item] });

    it('is recognised by name, namespace and CNI type', () => {
        expect(isClusterDefaultNad(nad('openshift-ovn-kubernetes'))).toBe(true);
        expect(isClusterDefaultNad(nad('ovn-kubernetes'))).toBe(true);
        expect(isClusterDefaultNad(nad('demo'))).toBe(false);
        expect(isClusterDefaultNad(nad('openshift-ovn-kubernetes', 'other'))).toBe(false);
        expect(isClusterDefaultNad(nad('openshift-ovn-kubernetes', 'default', '{"type":"bridge","bridge":"br1"}'))).toBe(false);
    });

    it('is named for what it is rather than given an unknown topology', () => {
        const item = nad('openshift-ovn-kubernetes');
        const record = findNetwork({ kind: 'nad', namespace: 'openshift-ovn-kubernetes', name: 'default' }, inputs(item))!;
        expect(record).toMatchObject({ topology: 'Cluster default network', clusterDefault: true, placement: 'none' });
        const facts = networkSummaryFacts(record, inputs(item));
        expect(factValue(facts, 'Topology')).toBeUndefined();
        expect(factValue(facts, 'Network')).toMatchObject({ value: 'Cluster default network' });
    });

    it('leaves any other OVN-Kubernetes NAD without a topology as Unknown', () => {
        const item = nad('demo');
        expect(findNetwork({ kind: 'nad', namespace: 'demo', name: 'default' }, inputs(item))).toMatchObject({ topology: 'Unknown' });
    });

    it('keeps a declared topology on a NAD in that place', () => {
        const item = nad('openshift-ovn-kubernetes', 'default', '{"type":"ovn-k8s-cni-overlay","topology":"layer2"}');
        const record = findNetwork({ kind: 'nad', namespace: 'openshift-ovn-kubernetes', name: 'default' }, inputs(item))!;
        expect(record.topology).toBe('Layer2');
        expect(record.clusterDefault).toBeUndefined();
    });
});

describe('a network whose NetworkCreated condition is False', () => {
    const withCondition = (status: string) => {
        const cudn = clone(coverage.cudns.find((c) => c.metadata?.name === 'vlan-333')!);
        cudn.status = { conditions: [{ type: 'NetworkCreated', status, reason: 'SyncError', message: 'no' }] };
        return findNetwork({ kind: 'cudn', name: 'vlan-333' }, { ...coverageInputs, cudns: [cudn] })!;
    };

    it('reports the condition when False, and nothing when True, Unknown or absent', () => {
        expect(networkCreationFailure(withCondition('False'))).toMatchObject({ reason: 'SyncError', message: 'no' });
        expect(networkCreationFailure(withCondition('True'))).toBeUndefined();
        expect(networkCreationFailure(withCondition('Unknown'))).toBeUndefined();
        const bare = clone(coverage.cudns[0]);
        delete bare.status;
        expect(networkCreationFailure(findNetwork(
            { kind: 'cudn', name: bare.metadata?.name || '' }, { ...coverageInputs, cudns: [bare] }
        )!)).toBeUndefined();
    });
});

describe('an unknown network', () => {
    it('is not found', () => {
        expect(findNetwork({ kind: 'cudn', name: 'nope' }, coverageInputs)).toBeUndefined();
        expect(findNetwork({ kind: 'nad', namespace: 'default', name: 'nope' }, coverageInputs)).toBeUndefined();
    });
});
