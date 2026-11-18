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
        expect(resolveAddress(book, '169.254.0.2').map((owner) => owner.node)).toEqual(['worker-peer', 'worker-routes']);
        expect(resolveAddress(book, '169.254.0.2', { preferNode: 'worker-routes' }).map(brief)).toEqual([
            ['interface', 'ens5 on worker-routes', undefined],
        ]);
        expect(resolveAddress(book, '169.254.0.2', { preferNode: 'elsewhere' })).toHaveLength(2);
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
        expect(nodes.byIp.size).toBe(1);
    });

    it('holds nothing when given nothing', () => {
        expect(resolveAddress(buildAddressBook({}), '192.0.2.10')).toEqual([]);
    });

    it('tolerates a NodeNetworkState with no reported state', () => {
        const empty = buildAddressBook({ nodeNetworkStates: [{ metadata: { name: 'new-node' } } as NodeNetworkState] });
        expect(empty.byIp.size).toBe(0);
    });
});
