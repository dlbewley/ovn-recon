import { clone, loadFixture, loadItems, loadSnapshot } from '../insights/testing';
import type {
    ClusterUserDefinedNetwork,
    Interface,
    NetworkAttachmentDefinition,
    NodeNetworkState,
    UserDefinedNetwork
} from '../types';
import type { Fact, FactItem } from '../topology/types';
import { constructDetailPath } from '../routes';
import {
    buildPlacement,
    findNetwork,
    gatewayRouterName,
    masqueradeFacts,
    NetworkInputs,
    networkIdOf,
    networkSummaryFacts,
    ovnNetworkNameOfRecord
} from './networkPageModel';

/*
 * ovn-recon-2n6.3: a network's ID and masquerade IP pair on its network scope, and the
 * placement rows' links to the gateway routers.
 */

const fact = (facts: Fact[], label: string): Fact | undefined => facts.find((candidate) => candidate.label === label);
const items = (facts: Fact[], label: string): FactItem[] => (fact(facts, label)?.value ?? []) as FactItem[];

const nadFor = (
    name: string,
    namespace: string,
    config: Record<string, unknown>,
    extra: { networkId?: string; owner?: { kind: string; name: string } } = {}
): NetworkAttachmentDefinition => ({
    metadata: {
        name,
        namespace,
        ...(extra.networkId !== undefined ? { annotations: { 'k8s.ovn.org/network-id': extra.networkId } } : {}),
        ...(extra.owner
            ? { ownerReferences: [{ apiVersion: 'k8s.ovn.org/v1', kind: extra.owner.kind, name: extra.owner.name, uid: 'x' }] }
            : {})
    },
    spec: { config: JSON.stringify({ type: 'ovn-k8s-cni-overlay', ...config }) }
});

const nodeWithSubnets = (name: string, subnets: Record<string, string>) => ({
    metadata: { name, annotations: { 'k8s.ovn.org/node-masquerade-subnet': JSON.stringify(subnets) } }
});

describe('a primary CUDN', () => {
    // The capture's CUDN example-p-cudn is network ID 3, so 169.254.0.15 and .16; the
    // collector's ctrl-1 fixture shows .15 on GR_cluster_udn_example.p.cudn_ctrl-1.
    const cudns = loadItems<ClusterUserDefinedNetwork>('cudn', 'primary-cudn-vrf.json');
    const worker1 = loadFixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json');
    const nad = nadFor(
        'example-p-cudn', 'example',
        { name: 'cluster_udn_example-p-cudn', topology: 'layer2', role: 'primary' },
        { networkId: '3', owner: { kind: 'ClusterUserDefinedNetwork', name: 'example-p-cudn' } }
    );
    const inputs: NetworkInputs = { cudns, udns: [], nads: [nad], routeAdvertisements: [] };
    const record = findNetwork({ kind: 'cudn', name: 'example-p-cudn' }, inputs)!;
    const ctrl1 = { node: 'ctrl-1', database: loadSnapshot('ctrl-1').database! };

    it('shows its network ID from the generated NAD', () => {
        const facts = networkSummaryFacts(record, inputs);
        expect(fact(facts, 'Network ID')).toEqual(expect.objectContaining({ value: '3', provenance: 'observed' }));
        expect(fact(facts, 'Network ID')?.hint).toContain('example/example-p-cudn');
    });

    it('shows its masquerade pair with roles, derived, in the families its subnets use', () => {
        const facts = networkSummaryFacts(record, inputs);
        expect(items(facts, 'Masquerade IPs')).toEqual([
            { text: '169.254.0.15', detail: '(Gateway router masquerade, IPv4, derived)' },
            { text: '169.254.0.16', detail: '(Management port masquerade, IPv4, derived)' }
        ]);
        expect(fact(facts, 'Masquerade IPs')?.provenance).toBe('inferred');
        expect(fact(facts, 'Masquerade IPs')?.hint).toContain('Derived from network ID 3');
        expect(fact(facts, 'Masquerade IPs')?.hint).toContain('169.254.0.0/17 (the platform default)');
    });

    it('marks the pair confirmed when a remembered zone shows it on the gateway router', () => {
        const facts = networkSummaryFacts(record, inputs, { zones: [ctrl1] });
        expect(items(facts, 'Masquerade IPs')[0].detail).toBe('(Gateway router masquerade, IPv4, confirmed)');
        expect(items(facts, 'Masquerade IPs')[1].detail).toBe('(Management port masquerade, IPv4, derived)');
        expect(fact(facts, 'Masquerade IPs')?.provenance).toBe('observed');
        expect(fact(facts, 'Masquerade IPs')?.hint).toContain('GR_cluster_udn_example.p.cudn_ctrl-1');
    });

    it('stays derived when the zone holds another network\'s address', () => {
        const other = clone(ctrl1);
        other.database.logicalRouters.forEach((router) => {
            if (router.externalIds?.physical_ips) router.externalIds.physical_ips = '192.168.4.110';
        });
        other.database.logicalRouterPorts.forEach((port) => {
            port.networks = (port.networks ?? []).filter((network) => !network.startsWith('169.254.0.15'));
        });
        other.database.nats.forEach((nat) => {
            if (nat.externalIp === '169.254.0.15') nat.externalIp = '192.168.4.110';
        });
        const facts = networkSummaryFacts(record, inputs, { zones: [other] });
        expect(fact(facts, 'Masquerade IPs')?.provenance).toBe('inferred');
    });

    it('reads the masquerade subnet from the Nodes, and says when it has no room for the ID', () => {
        const wide = networkSummaryFacts(record, inputs, { nodes: [nodeWithSubnets('n', { ipv4: '169.254.64.0/18' })] });
        expect(items(wide, 'Masquerade IPs')[0].text).toBe('169.254.64.15');
        const narrow = networkSummaryFacts(record, inputs, { nodes: [nodeWithSubnets('n', { ipv4: '169.254.0.0/29' })] });
        expect(fact(narrow, 'Network ID')?.value).toBe('3');
        expect(items(narrow, 'Masquerade IPs')).toEqual([
            { text: 'No room in 169.254.0.0/29', detail: '(the subnet is too small for network ID 3)' }
        ]);
    });

    it('links each wired row to its node\'s gateway router on Routes and NAT, with the collector on', () => {
        const placement = buildPlacement(record, [worker1], inputs, undefined, { collectorEnabled: true });
        expect(placement.rows[0].status).toBe('wired');
        expect(placement.rows[0].gatewayRouter).toEqual({
            name: 'GR_cluster_udn_example.p.cudn_worker-1',
            path: constructDetailPath('worker-1', 'router', 'GR_cluster_udn_example.p.cudn_worker-1', { tab: 'routes' })
        });
        expect(placement.rows[0].gatewayRouter?.path).toContain('?tab=routes');
    });

    it('takes the router\'s name from a remembered zone', () => {
        const nns = clone(worker1);
        nns.metadata = { ...nns.metadata, name: 'ctrl-1' };
        const row = buildPlacement(record, [nns], inputs, undefined, { collectorEnabled: true, zones: [ctrl1] }).rows[0];
        expect(row.gatewayRouter?.name).toBe('GR_cluster_udn_example.p.cudn_ctrl-1');
    });

    it('draws no gateway router link with the collector off, or on a row that is not wired', () => {
        expect(buildPlacement(record, [worker1], inputs).rows[0].gatewayRouter).toBeUndefined();
        const bare = clone(worker1);
        bare.status!.currentState!.interfaces = bare.status!.currentState!.interfaces.filter((iface) => iface.type !== 'vrf');
        const row = buildPlacement(record, [bare], inputs, undefined, { collectorEnabled: true }).rows[0];
        expect(row.status).toBe('not-wired');
        expect(row.gatewayRouter).toBeUndefined();
    });
});

describe('a primary UDN', () => {
    const udn: UserDefinedNetwork = {
        apiVersion: 'k8s.ovn.org/v1',
        kind: 'UserDefinedNetwork',
        metadata: { name: 'tenant-blue', namespace: 'blue' },
        spec: { topology: 'Layer2', layer2: { role: 'Primary', subnets: ['10.20.0.0/24', 'fd20::/64'] } }
    };
    const nad = nadFor(
        'tenant-blue', 'blue',
        { name: 'blue_tenant-blue', topology: 'layer2', role: 'primary' },
        { networkId: '12', owner: { kind: 'UserDefinedNetwork', name: 'tenant-blue' } }
    );
    const inputs: NetworkInputs = { cudns: [], udns: [udn], nads: [nad], routeAdvertisements: [] };
    const record = findNetwork({ kind: 'udn', namespace: 'blue', name: 'tenant-blue' }, inputs)!;

    it('shows its ID and both masquerade IPs with roles, IPv4 and IPv6', () => {
        const facts = networkSummaryFacts(record, inputs);
        expect(fact(facts, 'Network ID')?.value).toBe('12');
        expect(items(facts, 'Masquerade IPs')).toEqual([
            { text: '169.254.0.33', detail: '(Gateway router masquerade, IPv4, derived)' },
            { text: '169.254.0.34', detail: '(Management port masquerade, IPv4, derived)' },
            { text: 'fd69::21', detail: '(Gateway router masquerade, IPv6, derived)' },
            { text: 'fd69::22', detail: '(Management port masquerade, IPv6, derived)' }
        ]);
    });

    it('names its gateway routers by its namespaced network, dashes as dots', () => {
        expect(ovnNetworkNameOfRecord(record)).toBe('blue_tenant-blue');
        expect(gatewayRouterName('blue_tenant-blue', 'worker-1')).toBe('GR_blue_tenant.blue_worker-1');
        const nns = clone(loadFixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json'));
        nns.status!.currentState!.interfaces.push(
            { name: 'mp12-udn-vrf', type: 'vrf', state: 'up', vrf: { port: ['ovn-k8s-mp5'], 'route-table-id': 1012 } } as Interface,
            { name: 'ovn-k8s-mp5', type: 'ovs-interface', state: 'ignore', controller: 'br-int' } as Interface
        );
        const row = buildPlacement(record, [nns], inputs, undefined, { collectorEnabled: true }).rows[0];
        expect(row.status).toBe('wired');
        expect(row.gatewayRouter?.path).toBe(
            constructDetailPath('worker-1', 'router', 'GR_blue_tenant.blue_worker-1', { tab: 'routes' })
        );
    });
});

describe('a secondary network', () => {
    const udn: UserDefinedNetwork = {
        apiVersion: 'k8s.ovn.org/v1',
        kind: 'UserDefinedNetwork',
        metadata: { name: 'side', namespace: 'blue' },
        spec: { topology: 'Layer2', layer2: { role: 'Secondary', subnets: ['10.30.0.0/24'] } }
    };
    const nad = nadFor(
        'side', 'blue',
        { name: 'blue_side', topology: 'layer2', role: 'secondary' },
        { networkId: '4', owner: { kind: 'UserDefinedNetwork', name: 'side' } }
    );
    const inputs: NetworkInputs = { cudns: [], udns: [udn], nads: [nad], routeAdvertisements: [] };

    it('shows the network ID only', () => {
        const record = findNetwork({ kind: 'udn', namespace: 'blue', name: 'side' }, inputs)!;
        const facts = networkSummaryFacts(record, inputs);
        expect(fact(facts, 'Network ID')?.value).toBe('4');
        expect(fact(facts, 'Masquerade IPs')).toBeUndefined();
    });

    it('has no gateway router link', () => {
        const record = findNetwork({ kind: 'udn', namespace: 'blue', name: 'side' }, inputs)!;
        const nns = loadFixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json');
        const row = buildPlacement(record, [nns], inputs, undefined, { collectorEnabled: true }).rows[0];
        expect(row.gatewayRouter).toBeUndefined();
    });
});

describe('a NAD-only network without the annotation', () => {
    const nad = nadFor('plain', 'red', { name: 'red_plain', topology: 'layer2', role: 'secondary' });
    const inputs: NetworkInputs = { cudns: [], udns: [], nads: [nad], routeAdvertisements: [] };

    it('shows neither the network ID nor masquerade IPs', () => {
        const record = findNetwork({ kind: 'nad', namespace: 'red', name: 'plain' }, inputs)!;
        expect(networkIdOf(record, inputs).ids).toEqual([]);
        const facts = networkSummaryFacts(record, inputs);
        expect(fact(facts, 'Network ID')).toBeUndefined();
        expect(fact(facts, 'Masquerade IPs')).toBeUndefined();
    });

    it('shows neither for a primary NAD without the annotation', () => {
        const primary = nadFor('lone', 'red', { name: 'red_lone', topology: 'layer2', role: 'primary' });
        const primaryInputs: NetworkInputs = { ...inputs, nads: [primary] };
        const record = findNetwork({ kind: 'nad', namespace: 'red', name: 'lone' }, primaryInputs)!;
        expect(masqueradeFacts(record, primaryInputs)).toEqual([]);
    });
});

describe('NADs that disagree on the network ID', () => {
    it('shows both IDs and no masquerade pair', () => {
        const cudns = loadItems<ClusterUserDefinedNetwork>('cudn', 'primary-cudn-vrf.json');
        const owner = { kind: 'ClusterUserDefinedNetwork', name: 'example-p-cudn' };
        const config = { name: 'cluster_udn_example-p-cudn', topology: 'layer2', role: 'primary' };
        const inputs: NetworkInputs = {
            cudns,
            udns: [],
            nads: [nadFor('example-p-cudn', 'a', config, { networkId: '3', owner }), nadFor('example-p-cudn', 'b', config, { networkId: '5', owner })],
            routeAdvertisements: []
        };
        const record = findNetwork({ kind: 'cudn', name: 'example-p-cudn' }, inputs)!;
        const facts = masqueradeFacts(record, inputs);
        expect(facts.map((f) => f.label)).toEqual(['Network ID']);
        expect(facts[0].value).toBe('3, 5');
        expect(facts[0].hint).toContain('disagree');
    });
});
