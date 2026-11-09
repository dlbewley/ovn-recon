import { LOGICAL_TOPOLOGY_SCHEMA_V2, LogicalTopologySnapshot } from '../types';
import { describeOwner, networkRoleResolverFor, ownerOf, ownerTarget } from './ovnOwner';
import { matchRefs } from './policyIndex';

// The captured corpus is the single source of truth shared with the collector
// (served as its fixture fallback and validated by its Go contract tests).
import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';
import cnv2 from '../../collector/fixtures/snapshots/cnv-2.json';
import ctrl1 from '../../collector/fixtures/snapshots/ctrl-1.json';
import defaultSnapshot from '../../collector/fixtures/snapshots/default.json';

const corpus: Record<string, LogicalTopologySnapshot> = {
    'cnv-1': cnv1 as unknown as LogicalTopologySnapshot,
    'cnv-2': cnv2 as unknown as LogicalTopologySnapshot,
    'ctrl-1': ctrl1 as unknown as LogicalTopologySnapshot,
    default: defaultSnapshot as unknown as LogicalTopologySnapshot,
};

describe('captured logical snapshot corpus', () => {
    it.each(Object.entries(corpus))('%s declares the v2 contract', (_name, snapshot) => {
        expect(snapshot.metadata.schemaVersion).toBe(LOGICAL_TOPOLOGY_SCHEMA_V2);
        expect(snapshot.database).toBeDefined();
    });

    it.each(['cnv-1', 'cnv-2', 'ctrl-1'])('%s carries a populated zone database', (name) => {
        const database = corpus[name].database;
        expect(database).toBeDefined();
        if (!database) return;
        expect(database.logicalRouters.length).toBeGreaterThan(0);
        expect(database.logicalRouterPorts.length).toBeGreaterThan(0);
        expect(database.logicalSwitches.length).toBeGreaterThan(0);
        expect(database.logicalSwitchPorts.length).toBeGreaterThan(0);
        expect(database.nats.length).toBeGreaterThan(0);
        expect(database.staticRoutes.length).toBeGreaterThan(0);
    });

    it('covers the network topology variants present on the capture cluster', () => {
        const cnv1Db = corpus['cnv-1'].database;
        expect(cnv1Db).toBeDefined();
        if (!cnv1Db) return;

        const topologies = new Set(
            cnv1Db.logicalRouters
                .map((router) => router.externalIds?.['k8s.ovn.org/topology'])
                .filter(Boolean),
        );
        // Layer2 primary CUDN routers announce their topology; the default
        // cluster network's routers carry no topology external_id.
        expect(topologies.has('layer2')).toBe(true);

        const roles = new Set(
            cnv1Db.logicalSwitches
                .map((logicalSwitch) => logicalSwitch.externalIds?.['k8s.ovn.org/role'])
                .filter(Boolean),
        );
        expect(roles.has('primary')).toBe(true);
        expect(roles.has('secondary')).toBe(true);

        const localnetSwitches = cnv1Db.logicalSwitches.filter((logicalSwitch) =>
            logicalSwitch.name.includes('localnet'),
        );
        expect(localnetSwitches.length).toBeGreaterThan(0);

        // The default cluster network (Layer3): per-node workload switch named
        // after the node, with its host subnet in other_config.
        const nodeSwitch = cnv1Db.logicalSwitches.find((logicalSwitch) => logicalSwitch.name === 'cnv-1');
        expect(nodeSwitch?.otherConfig?.subnet).toBeDefined();
    });

    // The services section (ovn-recon-e2b.6): Load_Balancer and
    // Load_Balancer_Group as one zone holds them. A live response carries it
    // only with ?include=services; the fixtures hold the full snapshot, as
    // the collector's cache does.
    describe.each(['cnv-1', 'cnv-2', 'ctrl-1'])('%s services section', (name) => {
        const database = corpus[name].database!;
        const loadBalancers = database.loadBalancers ?? [];
        const groups = database.loadBalancerGroups ?? [];
        const lbByUuid = new Map(loadBalancers.map((row) => [row.uuid, row]));
        const groupByUuid = new Map(groups.map((row) => [row.uuid, row]));
        const nodeSwitch = database.logicalSwitches.find((row) => row.name === name)!;
        const gatewayRouter = database.logicalRouters.find((row) => row.name === `GR_${name}`)!;

        it('carries both tables', () => {
            expect(database.loadBalancers).toBeDefined();
            expect(database.loadBalancerGroups).toBeDefined();
            expect(loadBalancers.length).toBeGreaterThan(300);
            expect(new Set(loadBalancers.map((row) => row.uuid)).size).toBe(loadBalancers.length);
        });

        it('resolves every switch, router and group reference', () => {
            for (const row of [...database.logicalSwitches, ...database.logicalRouters]) {
                for (const uuid of row.loadBalancer ?? []) expect(lbByUuid.has(uuid)).toBe(true);
                for (const uuid of row.loadBalancerGroup ?? []) expect(groupByUuid.has(uuid)).toBe(true);
            }
            for (const group of groups) {
                for (const uuid of group.loadBalancers) expect(lbByUuid.has(uuid)).toBe(true);
            }
        });

        it('attributes every row to a Service and names its scope', () => {
            for (const row of loadBalancers) {
                expect(row.externalIds?.['k8s.ovn.org/kind']).toBe('Service');
                expect(row.externalIds?.['k8s.ovn.org/owner']).toMatch(/^[^/]+\/[^/]+$/);
                expect(row.name).toMatch(/_(cluster|node_(router\+switch|router|switch)_.+)$/);
                expect(Object.keys(row.vips).length).toBeGreaterThan(0);
            }
        });

        it('covers the row shapes the drawer has to render', () => {
            const vips = loadBalancers.flatMap((row) => Object.entries(row.vips));
            // A load balancer with several VIPs, and a VIP with several backends.
            expect(loadBalancers.some((row) => Object.keys(row.vips).length > 1)).toBe(true);
            expect(vips.some(([, backends]) => backends.includes(','))).toBe(true);
            // A VIP whose Service has no endpoints keeps its key with ''.
            expect(vips.some(([, backends]) => backends === '')).toBe(true);
            // An IPv6 VIP, bracketed, with bracketed backends.
            expect(vips.some(([vip, backends]) => vip.startsWith('[') && backends.startsWith('['))).toBe(true);
            expect(loadBalancers.some((row) => row.protocol === 'udp')).toBe(true);
            expect(loadBalancers.some((row) => row.protocol === 'tcp')).toBe(true);
            // Session affinity (Service sessionAffinity: ClientIP).
            expect(loadBalancers.some((row) => row.options?.affinity_timeout !== undefined)).toBe(true);
        });

        it('attaches node-scoped rows directly and cluster-scoped rows through clusterLBGroup', () => {
            const onSwitch = new Set(nodeSwitch.loadBalancer ?? []);
            const onRouter = new Set(gatewayRouter.loadBalancer ?? []);
            const both = [...onSwitch].filter((uuid) => onRouter.has(uuid));
            // node_router+switch rows sit on both; node_switch and node_router
            // rows on one side only.
            expect(both.length).toBeGreaterThan(0);
            for (const uuid of both) expect(lbByUuid.get(uuid)!.name).toContain(`_node_router+switch_${name}`);
            expect([...onSwitch].some((uuid) => lbByUuid.get(uuid)!.name.endsWith(`_node_switch_${name}`))).toBe(true);
            expect([...onRouter].some((uuid) => lbByUuid.get(uuid)!.name.endsWith(`_node_router_${name}`))).toBe(true);

            const clusterGroup = groups.find((group) => group.name === 'clusterLBGroup')!;
            expect(nodeSwitch.loadBalancerGroup).toContain(clusterGroup.uuid);
            expect(gatewayRouter.loadBalancerGroup).toContain(clusterGroup.uuid);
            expect(clusterGroup.loadBalancers.length).toBeGreaterThan(300);
            for (const uuid of clusterGroup.loadBalancers) {
                expect(lbByUuid.get(uuid)!.name.endsWith('_cluster')).toBe(true);
                expect(onSwitch.has(uuid)).toBe(false);
            }
        });

        it('keeps the empty per-network groups the UDN switches reference', () => {
            const empty = groups.filter((group) => group.loadBalancers.length === 0).map((group) => group.name);
            expect(empty).toEqual(expect.arrayContaining([
                'clusterSwitchLBGroup',
                'clusterRouterLBGroup',
                'cluster_udn_example.p.cudn_clusterLBGroup',
                'cluster_udn_example.p.cudn_clusterSwitchLBGroup',
                'cluster_udn_example.p.cudn_clusterRouterLBGroup',
            ]));
            const udnSwitch = database.logicalSwitches.find(
                (row) => row.name === 'cluster_udn_example.p.cudn_ovn_layer2_switch',
            )!;
            expect(udnSwitch.loadBalancer ?? []).toEqual([]);
            expect(udnSwitch.loadBalancerGroup).toHaveLength(2);
            for (const uuid of udnSwitch.loadBalancerGroup ?? []) {
                expect(groupByUuid.get(uuid)!.loadBalancers).toEqual([]);
            }
        });
    });

    it('holds the same cluster-scoped load balancers in every zone', () => {
        const clusterRows = (name: string) =>
            (corpus[name].database!.loadBalancers ?? [])
                .filter((row) => row.name.endsWith('_cluster'))
                .map((row) => row.name)
                .sort();
        expect(clusterRows('cnv-1')).toEqual(clusterRows('ctrl-1'));
        expect(clusterRows('cnv-1')).toEqual(clusterRows('cnv-2'));
        const nodeRows = (name: string) =>
            (corpus[name].database!.loadBalancers ?? []).filter((row) => !row.name.endsWith('_cluster')).length;
        expect(nodeRows('cnv-1')).not.toBe(nodeRows('ctrl-1'));
    });

    it('leaves the default fixture without the section', () => {
        expect(corpus.default.database?.loadBalancers).toBeUndefined();
        expect(corpus.default.database?.loadBalancerGroups).toBeUndefined();
    });

    // The policy section (ovn-recon-e2b.5): ACL, Port_Group and Address_Set
    // as one zone holds them, on cnv-1. The rows are a live capture of the
    // same zone taken later than the ladder tables: rows of networks the
    // fixture does not model are left out, Port_Group.ports is remapped to
    // the fixture's own switch ports by name, and pods that no longer exist
    // take the groups of a pod of the same workload (or their namespace's
    // group). Some rows are synthetic, because the capture cluster had none:
    // the MultiNetworkPolicy rows (`ovn-recon-fixture-mnp`) and the
    // NetworkPolicy on a primary network (`ovn-recon-fixture-np`), both in
    // the shape verified with a short-lived policy, and the isolation ACL
    // set directly on the layer2 switch (shaped after the one an EVPN layer2
    // network gets).
    describe('cnv-1 policy section', () => {
        const database = corpus['cnv-1'].database!;
        const acls = database.acls ?? [];
        const groups = database.portGroups ?? [];
        const sets = database.addressSets ?? [];
        const aclByUuid = new Map(acls.map((row) => [row.uuid, row]));
        const typeOf = (row: { externalIds?: Record<string, string> }) => row.externalIds?.['k8s.ovn.org/owner-type'];
        const nameOf = (row: { externalIds?: Record<string, string> }) => row.externalIds?.['k8s.ovn.org/name'];
        const controllerOf = (row: { externalIds?: Record<string, string> }) =>
            row.externalIds?.['k8s.ovn.org/owner-controller'];
        const switchNamed = (name: string) => database.logicalSwitches.find((row) => row.name === name)!;

        it('carries the three tables, every row attributed to an owner', () => {
            expect(acls.length).toBeGreaterThan(600);
            expect(groups.length).toBeGreaterThan(800);
            expect(sets.length).toBeGreaterThan(50);
            for (const row of [...acls, ...groups, ...sets]) {
                const owner = ownerOf(row.externalIds);
                expect(owner?.controller).toBeTruthy();
                expect(owner?.type).toBeTruthy();
                expect(owner?.id).toBeTruthy();
            }
            expect(new Set(groups.map((row) => row.name)).size).toBe(groups.length);
            expect(new Set(sets.map((row) => row.name)).size).toBe(sets.length);
        });

        it('resolves the apply side by uuid and the peer side by name, with no orphan ACL', () => {
            const portUuids = new Set(database.logicalSwitchPorts.map((row) => row.uuid));
            const groupNames = new Set(groups.map((row) => row.name));
            const setNames = new Set(sets.map((row) => row.name));
            const attached = new Set<string>();
            for (const group of groups) {
                for (const uuid of group.ports) expect(portUuids.has(uuid)).toBe(true);
                for (const uuid of group.acls) {
                    expect(aclByUuid.has(uuid)).toBe(true);
                    attached.add(uuid);
                }
            }
            for (const logicalSwitch of database.logicalSwitches) {
                for (const uuid of logicalSwitch.acls ?? []) {
                    expect(aclByUuid.has(uuid)).toBe(true);
                    attached.add(uuid);
                }
            }
            for (const acl of acls) {
                expect(attached.has(acl.uuid)).toBe(true);
                const refs = matchRefs(acl);
                for (const name of refs.portGroups) expect(groupNames.has(name)).toBe(true);
                for (const name of refs.addressSets) expect(setNames.has(name)).toBe(true);
            }
        });

        it('has a NetworkPolicy group with ports and ACLs, named namespace:policy', () => {
            const policyGroups = groups.filter((row) => typeOf(row) === 'NetworkPolicy');
            expect(policyGroups.length).toBeGreaterThan(100);
            for (const row of policyGroups) expect(nameOf(row)).toMatch(/^[^:]+:[^:]+$/);
            const applied = policyGroups.find((row) => row.ports.length > 0 && row.acls.length > 0)!;
            expect(applied).toBeDefined();
            for (const uuid of applied.acls) {
                const acl = aclByUuid.get(uuid)!;
                expect(typeOf(acl)).toBe('NetworkPolicy');
                expect(nameOf(acl)).toBe(nameOf(applied));
                // The rule applies to its own group: the match names it.
                expect(matchRefs(acl).portGroups).toContain(applied.name);
            }
            // A policy with no rule of its own still has a group, without ACLs.
            expect(policyGroups.some((row) => row.acls.length === 0)).toBe(true);
        });

        it('has the namespace default-deny pair: defaultDeny and arpAllow per direction', () => {
            const denyGroups = groups.filter((row) => typeOf(row) === 'NetpolNamespace');
            expect(denyGroups.length).toBeGreaterThan(50);
            for (const group of denyGroups) {
                expect(['Ingress', 'Egress']).toContain(group.externalIds?.direction);
                const pair = group.acls.map((uuid) => aclByUuid.get(uuid)!);
                expect(pair.map((acl) => acl.externalIds?.type).sort()).toEqual(['arpAllow', 'defaultDeny']);
                const deny = pair.find((acl) => acl.externalIds?.type === 'defaultDeny')!;
                expect(deny.action).toBe('drop');
                expect(deny.priority).toBe(1000);
                expect(deny.direction).toBe(group.externalIds?.direction === 'Egress' ? 'from-lport' : 'to-lport');
            }
        });

        it('has the cluster port groups, with the management port in clusterPortGroup', () => {
            const cluster = groups.find(
                (row) => nameOf(row) === 'clusterPortGroup' && controllerOf(row) === 'default-network-controller',
            )!;
            expect(typeOf(cluster)).toBe('Cluster');
            const managementPort = database.logicalSwitchPorts.find((row) => row.name === 'k8s-cnv-1')!;
            expect(cluster.ports).toEqual([managementPort.uuid]);
            expect(cluster.acls.length).toBeGreaterThan(0);
            expect(groups.some((row) => nameOf(row) === 'clusterRtrPortGroup')).toBe(true);
        });

        it('has multicast ACLs without k8s.ovn.org/name and without an ACL name', () => {
            const multicast = acls.filter((row) => typeOf(row) === 'MulticastCluster');
            expect(multicast.length).toBeGreaterThan(0);
            for (const acl of multicast) {
                expect(nameOf(acl)).toBeUndefined();
                expect(acl.name).toBeUndefined();
                expect(['DefaultDeny', 'AllowInterNode']).toContain(acl.externalIds?.type);
            }
        });

        it('sets a node ACL on the node switch and an isolation ACL on the layer2 switch', () => {
            const onNodeSwitch = (switchNamed('cnv-1').acls ?? []).map((uuid) => aclByUuid.get(uuid)!);
            expect(onNodeSwitch.map(typeOf)).toEqual(['NetpolNode']);
            expect(nameOf(onNodeSwitch[0])).toBe('cnv-1');
            expect(onNodeSwitch[0].externalIds?.ip).toBeDefined();

            const layer2 = switchNamed('cluster_udn_example.p.cudn_ovn_layer2_switch');
            const onLayer2 = (layer2.acls ?? []).map((uuid) => aclByUuid.get(uuid)!);
            expect(onLayer2.map(typeOf).sort()).toEqual(['NetpolNode', 'UDNIsolation']);
            for (const acl of onLayer2) {
                expect(controllerOf(acl)).toBe('cluster_udn_example-p-cudn-network-controller');
            }
            // Isolation rules of the default network hang on a port group and
            // sit in tier 0, ahead of every NetworkPolicy.
            const secondaryPods = groups.find((row) => nameOf(row) === 'SecondaryPods')!;
            expect(typeOf(secondaryPods)).toBe('UDNIsolation');
            for (const uuid of secondaryPods.acls) expect(aclByUuid.get(uuid)!.tier).toBe(0);
            expect(acls.filter((row) => row.tier !== 0).every((row) => row.tier === 2)).toBe(true);
        });

        it('keeps the empty namespace groups every network controller writes', () => {
            const namespaceGroups = groups.filter((row) => typeOf(row) === 'Namespace');
            const empty = namespaceGroups.filter((row) => row.ports.length === 0 && row.acls.length === 0);
            expect(empty.length).toBeGreaterThan(400);
            // Namespace groups are only the peer side of a match: never ACLs.
            expect(namespaceGroups.every((row) => row.acls.length === 0)).toBe(true);
            // One per namespace and controller, the secondary networks included.
            const controllers = new Set(namespaceGroups.map(controllerOf));
            expect(controllers.has('cluster_udn_vlan-1924-network-controller')).toBe(true);
            expect(controllers.has('demo-mirror_example-l3-udn-network-controller')).toBe(true);
        });

        it('has pod selector address sets that a match refers to, and sets without addresses', () => {
            const selectors = sets.filter((row) => typeOf(row) === 'PodSelector');
            expect(selectors.length).toBeGreaterThan(20);
            const referenced = new Set(acls.flatMap((acl) => matchRefs(acl).addressSets));
            expect(selectors.some((row) => referenced.has(row.name) && row.addresses.length > 0)).toBe(true);
            expect(sets.some((row) => row.addresses.length === 0)).toBe(true);
            expect(acls.some((acl) => {
                const refs = matchRefs(acl);
                return refs.portGroups.length > 0 && refs.addressSets.length > 0;
            })).toBe(true);
            expect(sets.map(typeOf)).toEqual(expect.arrayContaining(['ClusterNodeIPs', 'EgressIP', 'UDNEnabledService']));
        });

        it('carries MultiNetworkPolicy rows that only the controller tells from a NetworkPolicy', () => {
            const roleOf = networkRoleResolverFor(database);
            const name = 'demo-mirror:ovn-recon-fixture-mnp';
            const policyGroups = groups.filter((row) => nameOf(row) === name);
            // One row set per network the policy names.
            expect(policyGroups.map(controllerOf).sort()).toEqual([
                'cluster_udn_vlan-1924-network-controller',
                'demo-mirror_example-l3-udn-network-controller',
            ]);
            for (const group of policyGroups) {
                expect(typeOf(group)).toBe('NetworkPolicy');
                expect(group.ports).toEqual([]);
                const target = ownerTarget(ownerOf(group.externalIds), roleOf);
                expect(target).toMatchObject({
                    apiVersion: 'k8s.cni.cncf.io/v1beta1',
                    kind: 'MultiNetworkPolicy',
                    namespace: 'demo-mirror',
                    name: 'ovn-recon-fixture-mnp',
                });
                const [rule] = group.acls.map((uuid) => aclByUuid.get(uuid)!);
                expect(typeOf(rule)).toBe('NetworkPolicy');
                expect(describeOwner(ownerOf(rule.externalIds), roleOf).kind).toBe('MultiNetworkPolicy');
                expect(matchRefs(rule).portGroups).toEqual([group.name]);

                // The namespace default-deny pair of the same controller.
                const deny = groups.filter(
                    (row) => typeOf(row) === 'NetpolNamespace' && nameOf(row) === 'demo-mirror'
                        && controllerOf(row) === controllerOf(group),
                );
                expect(deny.map((row) => row.externalIds?.direction).sort()).toEqual(['Egress', 'Ingress']);
                for (const row of deny) expect(row.acls).toHaveLength(2);
            }
        });

        it('carries a NetworkPolicy on a primary network, written by that network\'s controller alone', () => {
            const roleOf = networkRoleResolverFor(database);
            const name = 'ovn-recon-fixture:ovn-recon-fixture-np';
            const controller = 'cluster_udn_example-p-cudn-network-controller';
            // The controller's network is primary in this zone.
            expect(roleOf('cluster_udn_example-p-cudn')).toBe('primary');

            // One policy group and one rule ACL, and nothing under the
            // default controller for the same policy.
            const policyGroups = groups.filter((row) => nameOf(row) === name);
            expect(policyGroups.map(controllerOf)).toEqual([controller]);
            const [group] = policyGroups;
            expect(typeOf(group)).toBe('NetworkPolicy');
            const rules = group.acls.map((uuid) => aclByUuid.get(uuid)!);
            expect(rules).toHaveLength(1);
            expect(rules[0]).toMatchObject({ direction: 'to-lport', action: 'allow-related', priority: 1001, tier: 2 });
            expect(typeOf(rules[0])).toBe('NetworkPolicy');
            expect(controllerOf(rules[0])).toBe(controller);
            expect(matchRefs(rules[0]).portGroups).toEqual([group.name]);

            // Same row shape as the MultiNetworkPolicy case; only the role of
            // the controller's network makes it a NetworkPolicy.
            for (const row of [group, rules[0]]) {
                expect(ownerTarget(ownerOf(row.externalIds), roleOf)).toMatchObject({
                    apiVersion: 'networking.k8s.io/v1',
                    kind: 'NetworkPolicy',
                    namespace: 'ovn-recon-fixture',
                    name: 'ovn-recon-fixture-np',
                });
            }

            // The namespace default-deny pair, under the same controller: a
            // one-rule policy adds five ACLs and three port groups.
            const deny = groups.filter(
                (row) => typeOf(row) === 'NetpolNamespace' && nameOf(row) === 'ovn-recon-fixture',
            );
            expect(deny.map(controllerOf)).toEqual([controller, controller]);
            expect(deny.map((row) => row.externalIds?.direction).sort()).toEqual(['Egress', 'Ingress']);
            const added = [...rules, ...deny.flatMap((row) => row.acls.map((uuid) => aclByUuid.get(uuid)!))];
            expect(added).toHaveLength(5);
            expect(added.every((acl) => controllerOf(acl) === controller)).toBe(true);
        });

        it('resolves every NetworkPolicy-typed row to a kind by the role of its controller\'s network', () => {
            const roleOf = networkRoleResolverFor(database);
            const kindOf = (row: { externalIds?: Record<string, string> }) =>
                ownerTarget(ownerOf(row.externalIds), roleOf)?.kind;
            const byController = new Map<string, Set<string | undefined>>();
            for (const row of [...acls, ...groups].filter((candidate) => typeOf(candidate) === 'NetworkPolicy')) {
                const kinds = byController.get(controllerOf(row)!) ?? new Set();
                kinds.add(kindOf(row));
                byController.set(controllerOf(row)!, kinds);
            }
            expect([...byController.get('default-network-controller')!]).toEqual(['NetworkPolicy']);
            expect([...byController.get('cluster_udn_example-p-cudn-network-controller')!]).toEqual(['NetworkPolicy']);
            expect([...byController.get('cluster_udn_vlan-1924-network-controller')!]).toEqual(['MultiNetworkPolicy']);
            expect([...byController.get('demo-mirror_example-l3-udn-network-controller')!]).toEqual(['MultiNetworkPolicy']);
            expect(byController.size).toBe(4);
        });
    });

    it('leaves the other fixtures without the policy section', () => {
        for (const name of ['cnv-2', 'ctrl-1', 'default']) {
            expect(corpus[name].database?.acls).toBeUndefined();
            expect(corpus[name].database?.portGroups).toBeUndefined();
            expect(corpus[name].database?.addressSets).toBeUndefined();
        }
    });
});
