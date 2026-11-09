import { LogicalDatabase } from '../types';
import {
    controllerLabel,
    describeOwner,
    networkOfController,
    networkRoleResolverFor,
    networkRolesOf,
    NetworkRoleResolver,
    ownerLink,
    ownerOf,
    ownerTarget,
    ownerText,
} from './ovnOwner';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';

const fixtureDatabase = (cnv1 as unknown as { database: LogicalDatabase }).database;

const DEFAULT_CONTROLLER = 'default-network-controller';
const CUDN_CONTROLLER = 'cluster_udn_vlan-1924-network-controller';
const UDN_CONTROLLER = 'demo-mirror_example-l3-udn-network-controller';

const ids = (type: string | undefined, name: string | undefined, controller = DEFAULT_CONTROLLER, extra = {}) => ({
    ...(controller ? { 'k8s.ovn.org/owner-controller': controller } : {}),
    ...(type ? { 'k8s.ovn.org/owner-type': type } : {}),
    ...(name ? { 'k8s.ovn.org/name': name } : {}),
    'k8s.ovn.org/id': `${controller}:${type}:${name}`,
    ...extra,
});

const roles: NetworkRoleResolver = (network) =>
    ({
        default: 'primary',
        'cluster_udn_example-p-cudn': 'primary',
        'cluster_udn_vlan-1924': 'secondary',
        'demo-mirror_example-l3-udn': 'secondary',
    } as const)[network];

describe('ownerOf', () => {
    it('reads the four ownership keys and keeps the rest as extra', () => {
        const owner = ownerOf(
            ids('NetworkPolicy', 'shop:allow-web', DEFAULT_CONTROLLER, {
                direction: 'Ingress',
                'gress-index': '0',
                'ip-block-index': '-1',
                'port-policy-protocol': 'tcp',
            }),
        );
        expect(owner).toEqual({
            controller: DEFAULT_CONTROLLER,
            type: 'NetworkPolicy',
            name: 'shop:allow-web',
            id: `${DEFAULT_CONTROLLER}:NetworkPolicy:shop:allow-web`,
            extra: {
                direction: 'Ingress',
                'gress-index': '0',
                'ip-block-index': '-1',
                'port-policy-protocol': 'tcp',
            },
        });
    });

    it('is undefined for a row that carries no ownership key', () => {
        expect(ownerOf(undefined)).toBeUndefined();
        expect(ownerOf({})).toBeUndefined();
        expect(ownerOf({ 'k8s.ovn.org/kind': 'Service', 'k8s.ovn.org/owner': 'shop/web' })).toBeUndefined();
    });

    it('reads an owner without a name', () => {
        const owner = ownerOf(ids('MulticastCluster', undefined, DEFAULT_CONTROLLER, { type: 'DefaultDeny' }));
        expect(owner?.type).toBe('MulticastCluster');
        expect(owner?.name).toBeUndefined();
        expect(owner?.extra).toEqual({ type: 'DefaultDeny' });
    });
});

describe('networkOfController', () => {
    it('maps the three network controller name forms to the network identity', () => {
        expect(networkOfController(DEFAULT_CONTROLLER)).toBe('default');
        expect(networkOfController(CUDN_CONTROLLER)).toBe('cluster_udn_vlan-1924');
        expect(networkOfController(UDN_CONTROLLER)).toBe('demo-mirror_example-l3-udn');
    });

    it('is undefined for a controller that serves no network', () => {
        expect(networkOfController('udn-enabled-svc')).toBeUndefined();
        expect(networkOfController(undefined)).toBeUndefined();
        expect(networkOfController('-network-controller')).toBeUndefined();
    });

    it('labels the forms for display, anything else verbatim', () => {
        expect(controllerLabel(DEFAULT_CONTROLLER)).toBe('default');
        expect(controllerLabel(CUDN_CONTROLLER)).toBe('CUDN vlan-1924');
        expect(controllerLabel(UDN_CONTROLLER)).toBe('UDN demo-mirror/example-l3-udn');
        expect(controllerLabel('tenantblue-network-controller')).toBe('tenantblue');
        expect(controllerLabel('udn-enabled-svc')).toBe('udn-enabled-svc');
        expect(controllerLabel(undefined)).toBe('');
    });
});

describe('network roles', () => {
    it('reads roles from the switches and routers of a zone database', () => {
        const zoneRoles = networkRolesOf(fixtureDatabase);
        expect(zoneRoles.get('cluster_udn_example-p-cudn')).toBe('primary');
        expect(zoneRoles.get('cluster_udn_vlan-1924')).toBe('secondary');
        expect(zoneRoles.get('demo-mirror_example-l3-udn')).toBe('secondary');
        expect(zoneRoles.has('default')).toBe(false);
        // Memoised on the database object.
        expect(networkRolesOf(fixtureDatabase)).toBe(zoneRoles);
    });

    it('treats the default network as primary and an unseen network as unknown', () => {
        const roleOf = networkRoleResolverFor(fixtureDatabase);
        expect(roleOf('default')).toBe('primary');
        expect(roleOf('cluster_udn_vlan-1924')).toBe('secondary');
        expect(roleOf('cluster_udn_not-in-this-zone')).toBeUndefined();
        expect(networkRoleResolverFor(undefined)('default')).toBe('primary');
        expect(networkRoleResolverFor(null)('cluster_udn_vlan-1924')).toBeUndefined();
    });
});

describe('ownerTarget and describeOwner', () => {
    it('links a NetworkPolicy on the default network', () => {
        const owner = ownerOf(ids('NetworkPolicy', 'shop:allow-web'));
        expect(ownerTarget(owner, roles)).toEqual({
            apiVersion: 'networking.k8s.io/v1',
            kind: 'NetworkPolicy',
            namespace: 'shop',
            name: 'allow-web',
            path: '/k8s/ns/shop/networking.k8s.io~v1~NetworkPolicy/allow-web',
        });
        expect(ownerLink(owner, roles)).toBe('/k8s/ns/shop/networking.k8s.io~v1~NetworkPolicy/allow-web');
        // The default network needs no role resolver.
        expect(ownerLink(owner)).toBe('/k8s/ns/shop/networking.k8s.io~v1~NetworkPolicy/allow-web');
        expect(ownerText(describeOwner(owner, roles))).toBe('NetworkPolicy shop/allow-web');
    });

    it('links a NetworkPolicy owned by a primary network controller as a NetworkPolicy', () => {
        const owner = ownerOf(ids('NetworkPolicy', 'shop:allow-web', 'cluster_udn_example-p-cudn-network-controller'));
        expect(ownerTarget(owner, roles)?.kind).toBe('NetworkPolicy');
        expect(ownerTarget(owner, roles)?.apiVersion).toBe('networking.k8s.io/v1');
    });

    it('resolves the same owner type on a secondary network to a MultiNetworkPolicy', () => {
        // owner-type is NetworkPolicy here too: only the controller differs.
        for (const controller of [CUDN_CONTROLLER, UDN_CONTROLLER]) {
            const owner = ownerOf(ids('NetworkPolicy', 'demo-mirror:restrict', controller));
            expect(owner?.type).toBe('NetworkPolicy');
            expect(ownerTarget(owner, roles)).toEqual({
                apiVersion: 'k8s.cni.cncf.io/v1beta1',
                kind: 'MultiNetworkPolicy',
                namespace: 'demo-mirror',
                name: 'restrict',
                path: '/k8s/ns/demo-mirror/k8s.cni.cncf.io~v1beta1~MultiNetworkPolicy/restrict',
            });
            expect(ownerText(describeOwner(owner, roles))).toBe('MultiNetworkPolicy demo-mirror/restrict');
        }
    });

    it('does not guess the kind when the network role is unknown', () => {
        const owner = ownerOf(ids('NetworkPolicy', 'demo:restrict', 'cluster_udn_elsewhere-network-controller'));
        expect(ownerTarget(owner, roles)).toBeUndefined();
        expect(ownerLink(owner)).toBeUndefined();
        const description = describeOwner(owner, roles);
        expect(description).toEqual({ kind: 'NetworkPolicy', name: 'demo/restrict', kindUnresolved: true });
    });

    it('keeps a policy name it cannot split as text', () => {
        const owner = ownerOf(ids('NetworkPolicy', 'no-colon'));
        expect(ownerTarget(owner, roles)).toBeUndefined();
        expect(describeOwner(owner, roles)).toEqual({ kind: 'NetworkPolicy', name: 'no-colon', kindUnresolved: false });
    });

    it('links Namespace and NetpolNamespace owners to the namespace', () => {
        for (const type of ['Namespace', 'NetpolNamespace']) {
            const owner = ownerOf(ids(type, 'shop', DEFAULT_CONTROLLER, { direction: 'Egress' }));
            expect(ownerTarget(owner, roles)).toEqual({
                apiVersion: 'v1',
                kind: 'Namespace',
                name: 'shop',
                path: '/k8s/cluster/projects/shop',
            });
            expect(ownerText(describeOwner(owner, roles))).toBe(`${type} shop`);
        }
        // The same on a secondary network: the default-deny groups of a
        // MultiNetworkPolicy are still about the namespace.
        expect(ownerLink(ownerOf(ids('NetpolNamespace', 'demo-mirror', CUDN_CONTROLLER)), roles)).toBe(
            '/k8s/cluster/projects/demo-mirror',
        );
    });

    it('renders an owner without a name as its type alone', () => {
        const description = describeOwner(ownerOf(ids('MulticastCluster', undefined)), roles);
        expect(description.target).toBeUndefined();
        expect(ownerText(description)).toBe('MulticastCluster');
    });

    it('renders an owner type it has never seen as text, without a link', () => {
        const owner = ownerOf(ids('AdminNetworkPolicy', 'cluster-defaults', DEFAULT_CONTROLLER, { direction: 'Ingress' }));
        expect(ownerLink(owner, roles)).toBeUndefined();
        expect(ownerText(describeOwner(owner, roles))).toBe('AdminNetworkPolicy cluster-defaults');
        expect(owner?.extra).toEqual({ direction: 'Ingress' });
    });

    it('renders cluster-scoped helper owners as text', () => {
        expect(ownerText(describeOwner(ownerOf(ids('Cluster', 'clusterPortGroup')), roles))).toBe('Cluster clusterPortGroup');
        expect(ownerText(describeOwner(ownerOf(ids('UDNIsolation', 'DenyPrimaryUDN')), roles))).toBe('UDNIsolation DenyPrimaryUDN');
        expect(ownerText(describeOwner(undefined, roles))).toBe('Unowned');
    });
});
