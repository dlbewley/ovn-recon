import fs from 'fs';
import path from 'path';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';
import { LogicalDatabase, NodeNetworkState } from '../types';
import { addressBookForDatabase, addressOwnerTarget, AddressOwner, buildAddressBook, resolveAddress } from './addressBook';

const database = cnv1.database as unknown as LogicalDatabase;
const CUDN = 'cluster_udn_example-p-cudn';
const UDN = 'demo-mirror_example-l3-udn';

const loadNns = (name: string): NodeNetworkState =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'nns', `${name}.json`), 'utf-8'));

const brief = (owner: AddressOwner) => [owner.kind, owner.label, owner.network];

/** Addresses something holds, leaving out what the masquerade formula alone places. */
const heldAddresses = (book: ReturnType<typeof buildAddressBook>): string[] =>
    [...book.byIp].filter(([, owners]) => owners.some((owner) => owner.masquerade?.basis !== 'derived')).map(([key]) => key);

describe('the address book over the cnv-1 snapshot', () => {
    const book = addressBookForDatabase(database, 'cnv-1')!;

    it('resolves a pod address to its pod, with where it was read', () => {
        expect(resolveAddress(book, '10.131.1.172')).toEqual([{
            kind: 'pod',
            ref: {
                type: 'resource',
                resource: {
                    apiVersion: 'v1',
                    kind: 'Pod',
                    namespace: 'openshift-mtv',
                    name: 'forklift-volume-populator-controller-6d5f776884-cllnz',
                },
            },
            label: 'openshift-mtv/forklift-volume-populator-controller-6d5f776884-cllnz',
            node: 'cnv-1',
            network: 'default',
            provenance: [{
                source: 'Logical_Switch_Port',
                record: 'openshift-mtv_forklift-volume-populator-controller-6d5f776884-cllnz',
                field: 'addresses',
                value: '10.131.1.172',
                zone: 'cnv-1',
            }],
        }]);
    });

    it('resolves a pod by its MAC in any spelling', () => {
        const owners = resolveAddress(book, '0A-58-0A-83-01-AC');
        expect(owners.map(brief)).toEqual([
            ['pod', 'openshift-mtv/forklift-volume-populator-controller-6d5f776884-cllnz', 'default'],
        ]);
        expect(owners[0].provenance[0].value).toBe('0a:58:0a:83:01:ac');
    });

    it('resolves router ports, ignoring the mask on either side', () => {
        for (const spelling of ['10.131.0.1', '10.131.0.1/23']) {
            expect(resolveAddress(book, spelling).map(brief)).toEqual([['router-port', 'rtos-cnv-1', 'default']]);
        }
    });

    it('reads both ends of a point-to-point prefix as addresses', () => {
        expect(resolveAddress(book, '100.88.0.10/31').map(brief)).toEqual(
            resolveAddress(book, '100.88.0.10').map(brief),
        );
        expect(resolveAddress(book, '100.88.0.10/31').map((owner) => owner.label)).toContain(
            'trtor-GR_cluster_udn_example.p.cudn_cnv-1',
        );
    });

    it('answers for the exact address only, never by the subnet around it', () => {
        expect(resolveAddress(book, '10.131.0.0/23')).toEqual([]);
        expect(resolveAddress(book, '10.1.2.0/24')).toEqual([]);
        // Inside the node subnet, and held by nothing.
        expect(resolveAddress(book, '10.131.1.254')).toEqual([]);
        expect(resolveAddress(book, 'not-an-address')).toEqual([]);
    });

    it('returns every network of an address present in several, each tagged', () => {
        expect(resolveAddress(book, '100.88.0.11').map(brief)).toEqual([
            ['router-port', 'rtotr-GR_cluster_udn_example.p.cudn_cnv-1', CUDN],
            ['switch-port', 'tstor-cnv-3', 'default'],
            ['switch-port', 'demo.mirror_example.l3.udn_tstor-cnv-3', UDN],
        ]);
    });

    it('narrows to one network only when told which', () => {
        expect(resolveAddress(book, '100.88.0.11', { network: UDN }).map(brief)).toEqual([
            ['switch-port', 'demo.mirror_example.l3.udn_tstor-cnv-3', UDN],
        ]);
        expect(resolveAddress(book, '100.88.0.11', { network: 'some-other-network' })).toEqual([]);
    });

    it('keeps the node a remote port stands for', () => {
        const [owner] = resolveAddress(book, '100.88.0.11', { network: 'default' });
        expect(owner.node).toBe('cnv-3');
    });

    it('folds a router\'s many NAT rows on one external IP into one owner', () => {
        const owners = resolveAddress(book, '192.168.4.72');
        expect(owners.map(brief)).toEqual([
            ['router-port', 'rtoe-GR_cluster_udn_example.p.cudn_cnv-1', CUDN],
            ['router-port', 'rtoe-GR_cnv-1', 'default'],
            ['nat', 'GR_cnv-1', 'default'],
        ]);
        const nat = owners.find((owner) => owner.kind === 'nat')!;
        expect(nat.provenance).toEqual([
            { source: 'NAT', record: 'GR_cnv-1', field: 'external_ip', value: '192.168.4.72', zone: 'cnv-1' },
        ]);
    });

    it('resolves a ClusterIP to its Service', () => {
        expect(resolveAddress(book, '172.30.80.5').map(brief)).toEqual([
            ['service', 'c9s/clabernetes-http', 'default'],
        ]);
    });

    it('does not make a node address the property of every NodePort Service', () => {
        const kinds = resolveAddress(book, '192.168.4.72').map((owner) => owner.kind);
        expect(kinds).not.toContain('service');
    });

    it('reads no VIPs from a snapshot without the services section', () => {
        const ladderOnly: LogicalDatabase = { ...database, loadBalancers: undefined, loadBalancerGroups: undefined };
        const ladder = buildAddressBook({ zones: [{ node: 'cnv-1', database: ladderOnly }] });
        expect(resolveAddress(ladder, '172.30.80.5')).toEqual([]);
        expect(resolveAddress(ladder, '10.131.0.1')).toHaveLength(1);
    });

    it('is built once per database object', () => {
        expect(addressBookForDatabase(database, 'cnv-1')).toBe(book);
        expect(addressBookForDatabase({ ...database }, 'cnv-1')).not.toBe(book);
        expect(addressBookForDatabase(null)).toBeUndefined();
    });

    it('links each kind of owner to where it is shown', () => {
        const target = (address: string, kind: AddressOwner['kind']) =>
            addressOwnerTarget(resolveAddress(book, address).find((owner) => owner.kind === kind)!);
        expect(target('10.131.1.172', 'pod')).toEqual({
            type: 'resource',
            ref: {
                apiVersion: 'v1',
                kind: 'Pod',
                namespace: 'openshift-mtv',
                name: 'forklift-volume-populator-controller-6d5f776884-cllnz',
            },
        });
        expect(target('10.131.0.1', 'router-port')).toEqual({
            type: 'path',
            path: '/ovn-recon/ovn/cnv-1?select=router:ovn_cluster_router',
        });
        expect(target('10.131.0.2', 'switch-port')).toEqual({
            type: 'path',
            path: '/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=ports&port=k8s-cnv-1',
        });
        expect(target('192.168.4.72', 'nat')).toEqual({
            type: 'path',
            path: '/ovn-recon/ovn/cnv-1/router/GR_cnv-1?tab=routes',
        });
    });

    it('merges one row seen from two zones into one owner', () => {
        const merged = buildAddressBook({
            zones: [{ node: 'cnv-1', database }, { node: 'cnv-2', database }],
        });
        const [owner, ...rest] = resolveAddress(merged, '10.131.0.1');
        expect(rest).toEqual([]);
        expect(owner.provenance.map((entry) => entry.zone)).toEqual(['cnv-1', 'cnv-2']);
    });
});

describe('the address book over NodeNetworkState and Node', () => {
    const worker = loadNns('kernel-routes');
    const peer: NodeNetworkState = {
        ...worker,
        metadata: { name: 'worker-peer' },
        status: {
            currentState: {
                interfaces: [
                    { name: 'lo', type: 'loopback', state: 'up', 'mac-address': '00:00:00:00:00:00', ipv4: { address: [{ ip: '127.0.0.1', 'prefix-length': 8 }] } },
                    { name: 'br-ex', type: 'ovs-interface', state: 'up', ipv4: { address: [{ ip: '192.0.2.253', 'prefix-length': 24 }, { ip: '169.254.0.2', 'prefix-length': 17 }] } },
                ],
            },
        },
    };
    const withMasquerade: NodeNetworkState = {
        ...worker,
        status: {
            currentState: {
                interfaces: [
                    ...worker.status!.currentState!.interfaces,
                    { name: 'ens5', type: 'ethernet', state: 'up', ipv4: { address: [{ ip: '169.254.0.2', 'prefix-length': 17 }] } },
                ],
            },
        },
    };
    const book = buildAddressBook({ nodeNetworkStates: [withMasquerade, peer] });

    it('resolves an interface address, with no network: it is the host\'s', () => {
        const [owner, ...rest] = resolveAddress(book, '198.51.100.20');
        expect(rest).toEqual([]);
        expect(brief(owner)).toEqual(['interface', 'ens4 on worker-routes', undefined]);
        expect(owner.node).toBe('worker-routes');
        expect(owner.provenance).toEqual([{
            source: 'NodeNetworkState',
            record: 'worker-routes',
            field: 'ens4 address',
            value: '198.51.100.20/24',
        }]);
        expect(addressOwnerTarget(owner)).toEqual({
            type: 'path',
            path: '/ovn-recon/node-network-state/worker-routes?select=iface:ens4',
        });
    });

    it('resolves IPv6 in any spelling', () => {
        expect(resolveAddress(book, '2001:0db8:1:0::10').map(brief)).toEqual([
            ['interface', 'br-ex on worker-routes', undefined],
        ]);
    });

    it('returns both interfaces that share a MAC', () => {
        expect(resolveAddress(book, '02:00:00:00:00:03').map((owner) => owner.label)).toEqual([
            'br-ex on worker-routes',
            'ens3 on worker-routes',
        ]);
    });

    it('finds a gateway held by another node', () => {
        expect(resolveAddress(book, '192.0.2.253', { preferNode: 'worker-routes' }).map(brief)).toEqual([
            ['interface', 'br-ex on worker-peer', undefined],
        ]);
    });

    it('prefers the node the address was read on, and lists every node without one', () => {
        // The masquerade owner spans nodes: it is on each of them.
        expect(resolveAddress(book, '169.254.0.2').map((owner) => owner.node)).toEqual([undefined, 'worker-peer', 'worker-routes']);
        expect(resolveAddress(book, '169.254.0.2', { preferNode: 'worker-routes' }).map(brief)).toEqual([
            ['masquerade', 'Host masquerade', undefined],
            ['interface', 'ens5 on worker-routes', undefined],
        ]);
        expect(resolveAddress(book, '169.254.0.2', { preferNode: 'elsewhere' })).toHaveLength(3);
    });

    it('ignores what every host has', () => {
        expect(resolveAddress(book, '127.0.0.1')).toEqual([]);
        expect(resolveAddress(book, '00:00:00:00:00:00')).toEqual([]);
    });

    it('adds Node status addresses, skipping a hostname', () => {
        const nodes = buildAddressBook({
            nodes: [{
                metadata: { name: 'worker-routes' },
                status: { addresses: [{ type: 'InternalIP', address: '192.0.2.10' }, { type: 'Hostname', address: 'worker-routes' }] },
            } as never],
        });
        const [owner] = resolveAddress(nodes, '192.0.2.10');
        expect(brief(owner)).toEqual(['node', 'worker-routes', undefined]);
        expect(owner.provenance[0].field).toBe('status.addresses InternalIP');
        expect(addressOwnerTarget(owner)).toEqual({
            type: 'resource',
            ref: { apiVersion: 'v1', kind: 'Node', name: 'worker-routes' },
        });
        expect(heldAddresses(nodes)).toHaveLength(1);
    });

    it('holds nothing when given nothing', () => {
        expect(resolveAddress(buildAddressBook({}), '192.0.2.10')).toEqual([]);
    });

    it('tolerates a NodeNetworkState with no reported state', () => {
        const empty = buildAddressBook({ nodeNetworkStates: [{ metadata: { name: 'new-node' } } as NodeNetworkState] });
        expect(heldAddresses(empty)).toEqual([]);
    });
});

describe('the masquerade source', () => {
    const nadOf = (namespace: string, name: string, networkName: string, networkId: string) => ({
        apiVersion: 'k8s.cni.cncf.io/v1',
        kind: 'NetworkAttachmentDefinition',
        metadata: { namespace, name, annotations: { 'k8s.ovn.org/network-id': networkId } },
        spec: { config: JSON.stringify({ name: networkName, role: 'primary', topology: 'layer2' }) },
    }) as never;
    const networks = {
        cudns: [{ metadata: { name: 'example-p-cudn' } } as never],
        udns: [{ metadata: { namespace: 'tenant-c', name: 'red' } } as never],
        nads: [
            nadOf('demo-a', 'example-p-cudn', 'cluster_udn_example-p-cudn', '3'),
            nadOf('tenant-c', 'red', 'tenant-c_red', '4'),
        ],
    };
    const zones = [{ node: 'cnv-1', database }];
    const masqueradeOf = (book: ReturnType<typeof buildAddressBook>, address: string) =>
        resolveAddress(book, address).filter((owner) => owner.kind === 'masquerade');

    it('names the network of a gateway router address OVN holds, before the port and NAT holding it', () => {
        const book = addressBookForDatabase(database, 'cnv-1')!;
        const owners = resolveAddress(book, '169.254.0.15');
        expect(owners.map(brief)).toEqual([
            ['masquerade', 'Gateway router masquerade of CUDN example-p-cudn', CUDN],
            ['router-port', 'rtoe-GR_cluster_udn_example.p.cudn_cnv-1', CUDN],
            ['nat', 'GR_cluster_udn_example.p.cudn_cnv-1', CUDN],
        ]);
        const [owner] = owners;
        expect(owner.ref).toEqual({
            type: 'masquerade',
            role: 'udn-gateway-router',
            networkId: 3,
            network: { kind: 'cudn', name: 'example-p-cudn' },
        });
        // No NADs here: the router, its port and its NAT rules say it, the formula only labels it.
        expect(owner.masquerade).toEqual({ role: 'udn-gateway-router', networkId: 3, subnet: '169.254.0.0/17', basis: 'observed' });
        expect(owner.provenance.map((entry) => `${entry.source} ${entry.field}`)).toEqual([
            'Logical_Router_Port networks',
            'NAT external_ip',
            'Logical_Router external_ids:physical_ips',
        ]);
        expect(addressOwnerTarget(owner)).toEqual({ type: 'path', path: '/ovn-recon/networks/cudn/example-p-cudn' });
    });

    it('reads the management port address off the transit router\'s NAT', () => {
        const [owner] = masqueradeOf(addressBookForDatabase(database, 'cnv-1')!, '169.254.0.16');
        expect(brief(owner)).toEqual(['masquerade', 'Management port masquerade of CUDN example-p-cudn', CUDN]);
    });

    it('records an address both observed and derived once, with both kinds of provenance', () => {
        const [owner, ...rest] = masqueradeOf(buildAddressBook({ zones, networks }), '169.254.0.15');
        expect(rest).toEqual([]);
        expect(owner.masquerade?.basis).toBe('both');
        expect(owner.provenance.at(-1)).toEqual({
            source: 'Masquerade formula',
            record: 'network ID 3 (NAD demo-a/example-p-cudn)',
            field: 'gateway router in 169.254.0.0/17',
            value: '169.254.0.15',
        });
    });

    it('derives the pair of a network OVN does not show here, in both families', () => {
        const book = buildAddressBook({ zones, networks });
        for (const [address, label] of [
            ['169.254.0.17', 'Gateway router masquerade of UDN tenant-c/red'],
            ['169.254.0.18', 'Management port masquerade of UDN tenant-c/red'],
            ['fd69::11', 'Gateway router masquerade of UDN tenant-c/red'],
            ['fd69::f', 'Gateway router masquerade of CUDN example-p-cudn'],
        ]) {
            const [owner, ...rest] = resolveAddress(book, address);
            expect(rest).toEqual([]);
            expect(owner.label).toBe(label);
            expect(owner.masquerade?.basis).toBe('derived');
        }
        expect(addressOwnerTarget(resolveAddress(book, '169.254.0.17')[0])).toEqual({
            type: 'path',
            path: '/ovn-recon/networks/udn/tenant-c/red',
        });
    });

    it('names the global roles, which link nowhere', () => {
        const book = buildAddressBook({ zones });
        expect(['169.254.0.1', '169.254.0.2', '169.254.0.3', '169.254.0.4', '169.254.0.5', 'fd69::2']
            .map((address) => resolveAddress(book, address).map(brief))).toEqual([
            [['masquerade', 'OVN masquerade', undefined]],
            [['masquerade', 'Host masquerade', undefined]],
            [['masquerade', 'Host masquerade for externalTrafficPolicy=Local', undefined]],
            [['masquerade', 'Dummy next hop', undefined]],
            [['masquerade', 'OVN service hairpin masquerade', undefined]],
            [['masquerade', 'Host masquerade', undefined]],
        ]);
        expect(addressOwnerTarget(resolveAddress(book, '169.254.0.4')[0])).toBeUndefined();
    });

    it('keeps a global role in a network\'s scope, and a pair only in its own', () => {
        const book = buildAddressBook({ zones, networks });
        expect(resolveAddress(book, '169.254.0.4', { network: CUDN }).map(brief)).toEqual([
            ['masquerade', 'Dummy next hop', undefined],
        ]);
        expect(resolveAddress(book, '169.254.0.17', { network: CUDN })).toEqual([]);
        expect(resolveAddress(book, '169.254.0.15', { network: CUDN })[0].kind).toBe('masquerade');
    });

    it('lists both networks when the NADs and OVN disagree on whose an address is', () => {
        const book = buildAddressBook({
            zones,
            networks: { ...networks, nads: [nadOf('tenant-c', 'red', 'tenant-c_red', '3')] },
        });
        expect(masqueradeOf(book, '169.254.0.15').map((owner) => [owner.label, owner.masquerade?.basis])).toEqual([
            ['Gateway router masquerade of CUDN example-p-cudn', 'observed'],
            ['Gateway router masquerade of UDN tenant-c/red', 'derived'],
        ]);
    });

    it('names no network for an ID two networks claim', () => {
        const book = buildAddressBook({
            nodes: [{ metadata: { name: 'cnv-1' } } as never],
            networks: { ...networks, nads: [...networks.nads, nadOf('tenant-c', 'red', 'tenant-c_red', '3')] },
        });
        const [owner, ...rest] = resolveAddress(book, '169.254.0.15');
        expect(rest).toEqual([]);
        expect(brief(owner)).toEqual(['masquerade', 'Gateway router masquerade of network ID 3', undefined]);
        expect(owner.masquerade?.ambiguous).toEqual(['CUDN example-p-cudn', 'UDN tenant-c/red']);
        expect(addressOwnerTarget(owner)).toBeUndefined();
    });

    it('follows a custom subnet from the Node annotation, and the legacy /29 holds no pair', () => {
        const annotated = (subnet: string) => ({
            metadata: { name: 'cnv-1', annotations: { 'k8s.ovn.org/node-masquerade-subnet': JSON.stringify({ ipv4: subnet }) } },
        }) as never;
        const custom = buildAddressBook({ nodes: [annotated('100.254.0.0/16')], networks });
        expect(resolveAddress(custom, '100.254.0.15').map(brief)).toEqual([
            ['masquerade', 'Gateway router masquerade of CUDN example-p-cudn', CUDN],
        ]);
        expect(resolveAddress(custom, '169.254.0.15')).toEqual([]);

        const legacy = buildAddressBook({ nodes: [annotated('169.254.169.0/29')], networks });
        expect(resolveAddress(legacy, '169.254.169.2').map(brief)).toEqual([['masquerade', 'Host masquerade', undefined]]);
        expect(resolveAddress(legacy, '169.254.169.11')).toEqual([]);
    });

    it('marks a host interface holding a masquerade address as an observation', () => {
        const state = {
            metadata: { name: 'worker' },
            status: { currentState: { interfaces: [
                { name: 'ovn-k8s-mp4', type: 'ovs-interface', state: 'up', ipv4: { address: [{ ip: '169.254.0.18', 'prefix-length': 17 }] } },
            ] } },
        } as NodeNetworkState;
        const owners = resolveAddress(buildAddressBook({ nodeNetworkStates: [state], networks }), '169.254.0.18');
        expect(owners.map(brief)).toEqual([
            ['masquerade', 'Management port masquerade of UDN tenant-c/red', 'tenant-c_red'],
            ['interface', 'ovn-k8s-mp4 on worker', undefined],
        ]);
        expect(owners[0].masquerade?.basis).toBe('both');
    });
});
