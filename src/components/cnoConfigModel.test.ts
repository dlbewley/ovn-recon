import fs from 'fs';
import path from 'path';

import type { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import type { ClusterOperator, ConfigMap, ConfigNetwork, FeatureGate, Infrastructure, OperatorNetwork } from '../types';
import {
    buildCnoConfigModel,
    CnoConfigInputs,
    CnoConfigModel,
    clusterNetworkCapacity,
    ConfigRow,
    DEFAULTS,
    MASQUERADE_SUBNET_ANNOTATION,
    NO_CNO_CONFIG_INPUTS,
    nodeMasqueradeSubnets,
    Source,
    sourceOf,
} from './cnoConfigModel';

/**
 * The cluster network configuration model (ovn-recon-n7r.1), against the configuration
 * of a cluster with nothing changed (test/fixtures/network-config/default.json, written
 * from the API types) and what an administrator can turn on from there.
 */

interface Fixture {
    operatorNetwork: OperatorNetwork;
    configNetwork: ConfigNetwork;
    clusterOperator: ClusterOperator;
    featureGate: FeatureGate;
    infrastructure: Infrastructure;
}

const fixture = (): Fixture => JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'network-config', 'default.json'), 'utf-8'),
);

const ok = <T,>(data: T): Source<T> => ({ status: 'ok', data });
const ABSENT: Source<ConfigMap> = { status: 'absent' };
const NOW = Date.parse('2026-01-10T12:00:00Z');

const inputsOf = (data: Fixture, extra: Partial<CnoConfigInputs> = {}): CnoConfigInputs => ({
    operatorNetwork: ok(data.operatorNetwork),
    configNetwork: ok(data.configNetwork),
    clusterOperator: ok(data.clusterOperator),
    featureGate: ok(data.featureGate),
    infrastructure: ok(data.infrastructure),
    configMaps: { appliedCluster: ABSENT, mtu: ABSENT, overrides: ABSENT, gatewayMode: ABSENT },
    nodes: [],
    ...extra,
});

const rowOf = (model: CnoConfigModel, id: string): ConfigRow | undefined =>
    model.sections.flatMap((section) => section.rows).find((row) => row.id === id);

const node = (name: string, subnets: unknown): K8sResourceCommon => ({
    metadata: { name, annotations: { [MASQUERADE_SUBNET_ANNOTATION]: typeof subnets === 'string' ? subnets : JSON.stringify(subnets) } },
});

describe('sourceOf', () => {
    it('reads a loaded object, and waits for one that has not loaded', () => {
        expect(sourceOf({ metadata: { name: 'cluster' } }, true, undefined)).toEqual({ status: 'ok', data: { metadata: { name: 'cluster' } } });
        expect(sourceOf(undefined, false, undefined)).toEqual({ status: 'loading' });
    });

    it('tells not found from not allowed from anything else', () => {
        expect(sourceOf(undefined, false, { code: 404, message: 'not found' })).toEqual({ status: 'absent' });
        expect(sourceOf(undefined, false, { response: { status: 403 }, message: 'forbidden' })).toEqual({ status: 'forbidden', message: 'forbidden' });
        expect(sourceOf(undefined, false, { json: { code: 401 }, message: 'unauthorized' }).status).toBe('forbidden');
        expect(sourceOf(undefined, true, new Error('boom'))).toEqual({ status: 'error', message: 'boom' });
    });

    it('takes a loaded watch with no object as absent', () => {
        expect(sourceOf(undefined, true, undefined).status).toBe('absent');
        expect(sourceOf({}, true, undefined).status).toBe('absent');
        expect(sourceOf([], true, undefined).status).toBe('absent');
    });
});

describe('clusterNetworkCapacity', () => {
    it('derives the node subnets and the addresses in each', () => {
        expect(clusterNetworkCapacity({ cidr: '10.128.0.0/14', hostPrefix: 23 })).toBe('Up to 512 node subnets, 512 addresses each');
        expect(clusterNetworkCapacity({ cidr: 'fd01::/48', hostPrefix: 64 })).toBe('Up to 65536 node subnets');
    });

    it('says nothing of an entry it cannot read', () => {
        expect(clusterNetworkCapacity({ cidr: '10.128.0.0/14' })).toBeUndefined();
        expect(clusterNetworkCapacity({ cidr: '10.128.0.0', hostPrefix: 23 })).toBeUndefined();
        expect(clusterNetworkCapacity({ cidr: '10.128.0.0/24', hostPrefix: 23 })).toBeUndefined();
    });
});

describe('nodeMasqueradeSubnets', () => {
    it('collects the distinct subnets per family and skips what is not JSON', () => {
        expect(nodeMasqueradeSubnets([
            node('a', { ipv4: '169.254.0.0/17', ipv6: 'fd69::/112' }),
            node('b', { ipv4: '169.254.0.0/17' }),
            node('c', 'not json'),
            { metadata: { name: 'd' } },
        ])).toEqual({ ipv4: ['169.254.0.0/17'], ipv6: ['fd69::/112'], nodes: 2 });
    });
});

describe('buildCnoConfigModel', () => {
    it('is loading until a source answers', () => {
        const model = buildCnoConfigModel(NO_CNO_CONFIG_INPUTS, NOW);
        expect(model.loading).toBe(true);
        expect(model.sections).toEqual([]);
        expect(model.summary).toEqual([]);
    });

    describe('a cluster with nothing changed', () => {
        const model = buildCnoConfigModel(inputsOf(fixture()), NOW);

        it('summarises it in one line', () => {
            expect(model.summary.map((chip) => `${chip.label}: ${chip.value}`)).toEqual([
                'Network type: OVNKubernetes',
                'Gateway mode: Shared',
                'Transport: Geneve',
                'MTU: 1400',
                'IPsec: Disabled',
                'Routing: None',
            ]);
            expect(model.notices).toEqual([]);
            expect(model.loading).toBe(false);
        });

        it('groups the fields', () => {
            expect(model.sections.map((section) => section.id)).toEqual([
                'addressing', 'overlay', 'gateway', 'routing', 'security', 'multi-network', 'other',
                'cluster-config', 'operator', 'feature-gates',
            ]);
        });

        it('says which values are set and which are left to the default', () => {
            expect(rowOf(model, 'network-type')).toMatchObject({ value: 'OVNKubernetes', origin: 'set', sourcePath: 'spec.defaultNetwork.type' });
            expect(rowOf(model, 'join-subnet-ipv4')).toMatchObject({ value: DEFAULTS.joinSubnetV4, origin: 'default' });
            expect(rowOf(model, 'transit-switch-subnet-ipv4')).toMatchObject({ value: '100.88.0.0/16', origin: 'default' });
            expect(rowOf(model, 'masquerade-subnet-ipv4')).toMatchObject({
                value: '169.254.0.0/17',
                origin: 'default',
                sourcePath: 'spec.defaultNetwork.ovnKubernetesConfig.gatewayConfig.ipv4.internalMasqueradeSubnet',
            });
            expect(rowOf(model, 'transport')).toMatchObject({ value: 'Geneve', origin: 'default' });
            expect(rowOf(model, 'uplink-mode')).toMatchObject({ value: 'Required', origin: 'default' });
            expect(rowOf(model, 'route-advertisements')).toMatchObject({ value: 'Disabled', origin: 'default' });
            expect(rowOf(model, 'routing-providers')).toMatchObject({ value: 'None', origin: 'default' });
            expect(rowOf(model, 'routing-via-host')).toMatchObject({ value: 'false', origin: 'set' });
            expect(rowOf(model, 'egress-ip-timeout')).toMatchObject({ value: '1', origin: 'default' });
            expect(rowOf(model, 'hybrid-overlay')).toMatchObject({ value: 'Not configured', origin: 'unset' });
            expect(rowOf(model, 'service-node-port-range')).toMatchObject({ value: '30000-32767', origin: 'default', source: 'Cluster network configuration' });
        });

        it('leaves a single-stack cluster without IPv6 rows', () => {
            expect(rowOf(model, 'ip-families')?.value).toBe('IPv4');
            expect(rowOf(model, 'join-subnet-ipv6')).toBeUndefined();
            expect(rowOf(model, 'masquerade-subnet-ipv6')).toBeUndefined();
        });

        it('marks what cannot be changed, and what the operator wrote back', () => {
            expect(rowOf(model, 'transport')?.immutable).toBe('Set at install only');
            expect(rowOf(model, 'geneve-port')).toMatchObject({ value: '6081', origin: 'set', immutable: 'The operator refuses a change' });
            expect(rowOf(model, 'geneve-port')?.note).toMatch(/writes this into the spec/);
            expect(rowOf(model, 'mtu')?.immutable).toMatch(/MTU migration/);
            expect(rowOf(model, 'ip-forwarding')?.immutable).toBeUndefined();
        });

        it('reads the MTU in effect, the platform and the versions from where they are reported', () => {
            expect(rowOf(model, 'cluster-mtu')).toMatchObject({ value: '1400', origin: 'reported', sourcePath: 'status.clusterNetworkMTU' });
            expect(rowOf(model, 'cluster-mtu')?.note).toBeUndefined();
            expect(rowOf(model, 'platform')).toMatchObject({ value: 'BareMetal', origin: 'reported' });
            expect(rowOf(model, 'cluster-operator-version')?.value).toBe('4.22.0');
            expect(rowOf(model, 'host-mtu')).toBeUndefined();
        });

        it('lists the gates the operator reads, including one this release does not list', () => {
            expect(rowOf(model, 'feature-set')).toMatchObject({ value: 'Default', origin: 'default' });
            expect(rowOf(model, 'gate-NoOverlayMode')?.value).toBe('Disabled');
            expect(rowOf(model, 'gate-DNSNameResolver')?.value).toBe('Enabled');
            expect(rowOf(model, 'gate-MACSecurity')?.value).toBe('Not listed in this release');
        });

        it('gathers the conditions of all three resources, none needing attention', () => {
            expect(model.conditions).toHaveLength(10);
            expect(new Set(model.conditions.map((condition) => condition.source))).toEqual(new Set([
                'ClusterOperator network', 'Network operator configuration', 'Cluster network configuration',
            ]));
            expect(model.conditions.every((condition) => condition.severity === 'none')).toBe(true);
        });

        it('names every source, the optional ConfigMaps as not present', () => {
            expect(model.sources.map((source) => [source.id, source.text])).toEqual([
                ['operatorNetwork', 'Read'],
                ['configNetwork', 'Read'],
                ['clusterOperator', 'Read'],
                ['featureGate', 'Read'],
                ['infrastructure', 'Read'],
                ['configMap:appliedCluster', 'Not present'],
                ['configMap:mtu', 'Not present'],
                ['configMap:overrides', 'Not present'],
                ['configMap:gatewayMode', 'Not present'],
            ]);
        });
    });

    it('reads local gateway mode, FRR, route advertisements and IPsec', () => {
        const data = fixture();
        const spec = data.operatorNetwork.spec!;
        spec.additionalRoutingCapabilities = { providers: ['FRR'] };
        const ovn = spec.defaultNetwork!.ovnKubernetesConfig!;
        ovn.routeAdvertisements = 'Enabled';
        ovn.gatewayConfig = { ...ovn.gatewayConfig, routingViaHost: true, ipForwarding: 'Global' };
        ovn.ipsecConfig = { mode: 'Full' };
        const model = buildCnoConfigModel(inputsOf(data), NOW);

        expect(model.summary.map((chip) => chip.value)).toEqual(['OVNKubernetes', 'Local', 'Geneve', '1400', 'Full', 'FRR + route advertisements']);
        expect(rowOf(model, 'routing-via-host')).toMatchObject({ value: 'true', origin: 'set' });
        expect(rowOf(model, 'routing-via-host')?.note).toMatch(/^Local gateway mode/);
        expect(rowOf(model, 'ip-forwarding')).toMatchObject({ value: 'Global', origin: 'set' });
        expect(rowOf(model, 'routing-providers')).toMatchObject({ value: 'FRR', origin: 'set' });
        expect(rowOf(model, 'route-advertisements')).toMatchObject({ value: 'Enabled', origin: 'set' });
        expect(rowOf(model, 'ipsec-encapsulation')).toMatchObject({ value: 'Auto', origin: 'default' });
    });

    it('shows the gated no-overlay fields only where they apply', () => {
        expect(rowOf(buildCnoConfigModel(inputsOf(fixture()), NOW), 'no-overlay-routing')).toBeUndefined();
        const data = fixture();
        const ovn = data.operatorNetwork.spec!.defaultNetwork!.ovnKubernetesConfig!;
        ovn.transport = 'NoOverlay';
        ovn.noOverlayConfig = { outboundSNAT: 'Enabled', routing: 'Managed' };
        const model = buildCnoConfigModel(inputsOf(data), NOW);
        expect(rowOf(model, 'transport')).toMatchObject({ value: 'NoOverlay', origin: 'set' });
        expect(rowOf(model, 'no-overlay-routing')).toMatchObject({ value: 'Managed', immutable: 'Cannot be changed once set' });
        expect(rowOf(model, 'bgp-as-number')).toMatchObject({ value: '64512', origin: 'default' });
    });

    it('shows both families of a dual-stack cluster', () => {
        const data = fixture();
        data.operatorNetwork.spec!.clusterNetwork!.push({ cidr: 'fd01::/48', hostPrefix: 64 });
        data.operatorNetwork.spec!.serviceNetwork!.push('fd02::/112');
        const model = buildCnoConfigModel(inputsOf(data), NOW);
        expect(rowOf(model, 'ip-families')?.value).toBe('Dual stack (IPv4 and IPv6)');
        expect(rowOf(model, 'cluster-network-1')).toMatchObject({ value: 'fd01::/48, host prefix /64', note: 'Up to 65536 node subnets' });
        expect(rowOf(model, 'join-subnet-ipv6')).toMatchObject({ value: 'fd98::/64', origin: 'default' });
        expect(rowOf(model, 'masquerade-subnet-ipv6')).toMatchObject({ value: 'fd69::/112', origin: 'default' });
    });

    describe('the masquerade subnet', () => {
        it('shows what the nodes report beside the default, as on an upgraded cluster', () => {
            const model = buildCnoConfigModel(inputsOf(fixture(), {
                nodes: [node('a', { ipv4: '169.254.169.0/29' }), node('b', { ipv4: '169.254.169.0/29' })],
            }), NOW);
            expect(rowOf(model, 'masquerade-subnet-ipv4')).toMatchObject({ value: '169.254.0.0/17', origin: 'default' });
            expect(rowOf(model, 'masquerade-subnet-effective-ipv4')).toMatchObject({
                value: '169.254.169.0/29',
                origin: 'reported',
                source: 'Node annotation',
                sourcePath: MASQUERADE_SUBNET_ANNOTATION,
                note: 'Reported by 2 nodes',
            });
        });

        it('shows a configured subnet as set, and says when nodes disagree', () => {
            const data = fixture();
            data.operatorNetwork.spec!.defaultNetwork!.ovnKubernetesConfig!.gatewayConfig!.ipv4 = { internalMasqueradeSubnet: '169.254.64.0/18' };
            const model = buildCnoConfigModel(inputsOf(data, {
                nodes: [node('a', { ipv4: '169.254.64.0/18' }), node('b', { ipv4: '169.254.0.0/17' })],
            }), NOW);
            expect(rowOf(model, 'masquerade-subnet-ipv4')).toMatchObject({ value: '169.254.64.0/18', origin: 'set' });
            expect(rowOf(model, 'masquerade-subnet-ipv4')?.note).toBeUndefined();
            expect(rowOf(model, 'masquerade-subnet-effective-ipv4')).toMatchObject({
                value: '169.254.0.0/17, 169.254.64.0/18', note: 'Nodes disagree',
            });
        });
    });

    describe('conditions', () => {
        it('puts a degraded operator first', () => {
            const data = fixture();
            data.clusterOperator.status!.conditions![0] = {
                type: 'Degraded', status: 'True', reason: 'RolloutHung', message: 'DaemonSet is not making progress', lastTransitionTime: '2026-01-10T11:00:00Z',
            };
            const [first] = buildCnoConfigModel(inputsOf(data), NOW).conditions;
            expect(first).toMatchObject({ source: 'ClusterOperator network', type: 'Degraded', severity: 'danger', reason: 'RolloutHung' });
        });

        it('warns of a long Progressing, and only notes a short one', () => {
            const data = fixture();
            data.clusterOperator.status!.conditions![1] = { type: 'Progressing', status: 'True', lastTransitionTime: '2026-01-10T09:00:00Z' };
            data.operatorNetwork.status!.conditions![3] = { type: 'Progressing', status: 'True', lastTransitionTime: '2026-01-10T11:50:00Z' };
            const progressing = buildCnoConfigModel(inputsOf(data), NOW).conditions.filter((condition) => condition.type === 'Progressing');
            expect(progressing.map((condition) => [condition.source, condition.severity, condition.note])).toEqual([
                ['ClusterOperator network', 'warning', 'Progressing for 3 h'],
                ['Network operator configuration', 'info', undefined],
            ]);
        });

        it('warns when the operator cannot upgrade or diagnostics are unavailable', () => {
            const data = fixture();
            data.clusterOperator.status!.conditions![3] = { type: 'Upgradeable', status: 'False' };
            data.configNetwork.status!.conditions![0] = { type: 'NetworkDiagnosticsAvailable', status: 'False' };
            const conditions = buildCnoConfigModel(inputsOf(data), NOW).conditions;
            expect(conditions.slice(0, 2).map((condition) => [condition.type, condition.severity])).toEqual([
                ['Upgradeable', 'warning'], ['NetworkDiagnosticsAvailable', 'warning'],
            ]);
        });
    });

    describe('notices', () => {
        it('says a migration is in progress, from the spec or the status', () => {
            const data = fixture();
            data.operatorNetwork.spec!.migration = { mtu: { network: { from: 1400, to: 8900 }, machine: { to: 9000 } } };
            expect(buildCnoConfigModel(inputsOf(data), NOW).notices).toEqual([{
                id: 'migration', severity: 'info', title: 'A network migration is in progress',
                body: 'cluster MTU 1400 to 8900; machine MTU ? to 9000',
            }]);
            const other = fixture();
            other.configNetwork.status!.migration = { networkType: 'OVNKubernetes' };
            expect(buildCnoConfigModel(inputsOf(other), NOW).notices[0].body).toBe('network type to OVNKubernetes');
        });

        it('flags an unmanaged operator and unsupported overrides', () => {
            const data = fixture();
            data.operatorNetwork.spec!.managementState = 'Unmanaged';
            data.operatorNetwork.spec!.unsupportedConfigOverrides = { anything: true };
            const model = buildCnoConfigModel(inputsOf(data), NOW);
            expect(model.notices.map((notice) => [notice.id, notice.severity])).toEqual([
                ['management-state', 'warning'], ['unsupported-overrides', 'warning'],
            ]);
            expect(rowOf(model, 'unsupported-config-overrides')).toMatchObject({ value: 'Set', origin: 'set' });
        });

        it('flags the hidden overrides and the legacy gateway mode ConfigMaps, and reads the probed MTU', () => {
            const model = buildCnoConfigModel(inputsOf(fixture(), {
                configMaps: {
                    appliedCluster: ABSENT,
                    mtu: ok({ data: { mtu: '1500' } }),
                    overrides: ok({ data: { 'enable-lflow-cache': 'false' } }),
                    gatewayMode: ok({ data: { mode: 'local' } }),
                },
            }), NOW);
            expect(model.notices).toEqual([
                { id: 'overrides-configmap', severity: 'warning', title: 'Hidden OVN-Kubernetes overrides are present (ConfigMap ovn-kubernetes-config-overrides)', body: 'Keys: enable-lflow-cache' },
                { id: 'gateway-mode-configmap', severity: 'info', title: 'The legacy gateway mode switch is present (ConfigMap gateway-mode-config)', body: 'mode: local' },
            ]);
            expect(rowOf(model, 'host-mtu')).toMatchObject({ value: '1500', origin: 'reported', source: 'ConfigMap mtu' });
        });
    });

    describe('a source the user may not read', () => {
        const forbidden: Source<never> = { status: 'forbidden', message: 'networks.operator.openshift.io "cluster" is forbidden' };

        it('keeps everything else when the operator configuration is refused', () => {
            const model = buildCnoConfigModel(inputsOf(fixture(), { operatorNetwork: forbidden }), NOW);
            expect(model.loading).toBe(false);
            expect(model.sources[0]).toMatchObject({ status: 'forbidden', text: 'Not visible to you', optional: false });
            expect(model.sections.map((section) => section.id)).toEqual(['cluster-config', 'operator', 'feature-gates']);
            expect(model.summary.map((chip) => chip.id)).toEqual(['network-type', 'mtu']);
            expect(model.conditions.map((condition) => condition.source)).not.toContain('Network operator configuration');
        });

        it('keeps the operator configuration when the rest is refused', () => {
            const model = buildCnoConfigModel(inputsOf(fixture(), {
                configNetwork: forbidden,
                clusterOperator: forbidden,
                featureGate: forbidden,
                infrastructure: forbidden,
                configMaps: { appliedCluster: forbidden, mtu: forbidden, overrides: forbidden, gatewayMode: forbidden },
            }), NOW);
            expect(model.sections.map((section) => section.id)).toEqual([
                'addressing', 'overlay', 'gateway', 'routing', 'security', 'multi-network', 'other', 'operator',
            ]);
            expect(rowOf(model, 'cluster-mtu')).toBeUndefined();
            expect(model.summary.find((chip) => chip.id === 'mtu')?.value).toBe('1400');
            expect(model.sources.filter((source) => source.status === 'forbidden')).toHaveLength(8);
        });

        it('treats a gated field that is absent as its default, never as an error', () => {
            const data = fixture();
            data.operatorNetwork.spec = { defaultNetwork: { type: 'OVNKubernetes' } };
            const model = buildCnoConfigModel(inputsOf(data), NOW);
            expect(rowOf(model, 'transport')).toMatchObject({ value: 'Geneve', origin: 'default' });
            expect(rowOf(model, 'mtu')).toMatchObject({ origin: 'unset' });
            expect(rowOf(model, 'cluster-network')).toMatchObject({ value: 'Not set', origin: 'unset' });
            expect(rowOf(model, 'management-state')).toMatchObject({ value: 'Managed', origin: 'default' });
        });
    });

    describe('the capability checklist (ovn-recon-n7r.2)', () => {
        const capabilityOf = (model: CnoConfigModel, id: string) => model.capabilities.find((capability) => capability.id === id)!;
        const states = (model: CnoConfigModel, id: string) =>
            capabilityOf(model, id).prerequisites.map((prerequisite) => [prerequisite.id, prerequisite.state, prerequisite.actual]);

        it('lists every feature, none ready on a cluster with nothing changed', () => {
            const model = buildCnoConfigModel(inputsOf(fixture(), { routeAdvertisements: [], vteps: [] }), NOW);
            expect(model.capabilities.map((capability) => [capability.id, capability.status, capability.statusText])).toEqual([
                ['route-advertisements', 'not-ready', '0 of 2 prerequisites met'],
                ['evpn', 'not-ready', '2 of 6 prerequisites met'],
                ['no-overlay', 'not-ready', '0 of 4 prerequisites met'],
                ['uplink-optional', 'not-ready', '0 of 3 prerequisites met'],
                ['multi-network-policy', 'not-ready', '1 of 2 prerequisites met'],
                ['ipsec', 'not-ready', '0 of 1 prerequisite met'],
                ['hybrid-overlay', 'not-ready', '0 of 1 prerequisite met'],
            ]);
            expect(states(model, 'route-advertisements')).toEqual([
                ['frr-provider', 'unmet', 'None'],
                ['route-advertisements-enabled', 'unmet', 'Disabled'],
            ]);
            expect(capabilityOf(model, 'route-advertisements').prerequisites[1]).toMatchObject({
                source: 'Network operator configuration',
                sourcePath: 'spec.defaultNetwork.ovnKubernetesConfig.routeAdvertisements',
            });
            expect(capabilityOf(model, 'route-advertisements').notes).toEqual(['No RouteAdvertisements resources exist']);
        });

        it('has none without the operator configuration', () => {
            const model = buildCnoConfigModel(inputsOf(fixture(), { operatorNetwork: { status: 'forbidden' } }), NOW);
            expect(model.capabilities).toEqual([]);
        });

        it('ticks route advertisements and EVPN once their settings are on', () => {
            const data = fixture();
            const spec = data.operatorNetwork.spec!;
            spec.additionalRoutingCapabilities = { providers: ['FRR'] };
            const ovn = spec.defaultNetwork!.ovnKubernetesConfig!;
            ovn.routeAdvertisements = 'Enabled';
            ovn.gatewayConfig = { ...ovn.gatewayConfig, routingViaHost: true, ipForwarding: 'Global' };
            const model = buildCnoConfigModel(inputsOf(data, {
                routeAdvertisements: [
                    { metadata: { name: 'a' }, status: { conditions: [{ type: 'Accepted', status: 'True' }] } } as never,
                    { metadata: { name: 'b' } },
                ],
                vteps: [{ metadata: { name: 'vtep-1' }, spec: { mode: 'Unmanaged', cidrs: ['192.0.2.0/24'] } }],
            }), NOW);
            expect(capabilityOf(model, 'route-advertisements')).toMatchObject({ status: 'ready', statusText: 'Prerequisites met' });
            expect(capabilityOf(model, 'route-advertisements').notes).toEqual(['2 RouteAdvertisements resources, 1 accepted']);
            expect(capabilityOf(model, 'evpn').status).toBe('ready');
            expect(states(model, 'evpn')).toEqual([
                ['frr-provider', 'met', 'FRR'],
                ['route-advertisements-enabled', 'met', 'Enabled'],
                ['routing-via-host', 'met', 'true'],
                ['ip-forwarding-global', 'met', 'Global'],
                ['platform-bare-metal', 'met', 'BareMetal'],
                ['ipsec-disabled', 'met', 'Disabled'],
            ]);
            expect(capabilityOf(model, 'evpn').notes[0]).toBe('1 VTEP resource: vtep-1 (Unmanaged; 192.0.2.0/24)');
        });

        it('says what stands in the way of EVPN: IPsec, the platform, shared gateway mode', () => {
            const data = fixture();
            data.operatorNetwork.spec!.defaultNetwork!.ovnKubernetesConfig!.ipsecConfig = { mode: 'Full' };
            data.infrastructure.status = { platformStatus: { type: 'AWS' } };
            const model = buildCnoConfigModel(inputsOf(data), NOW);
            expect(states(model, 'evpn').filter(([, state]) => state === 'unmet').map(([id, , actual]) => [id, actual])).toEqual([
                ['frr-provider', 'None'],
                ['route-advertisements-enabled', 'Disabled'],
                ['routing-via-host', 'false'],
                ['ip-forwarding-global', 'Restricted'],
                ['platform-bare-metal', 'AWS'],
                ['ipsec-disabled', 'Full'],
            ]);
            expect(capabilityOf(model, 'evpn').notes[0]).toMatch(/^VTEPs could not be listed/);
            expect(capabilityOf(model, 'ipsec')).toMatchObject({ status: 'ready' });
            expect(capabilityOf(model, 'ipsec').notes[0]).toBe('East-west and north-south; encapsulation Auto');
        });

        it('warns that RouteAdvertisements resources are ignored while the setting is off', () => {
            const model = buildCnoConfigModel(inputsOf(fixture(), { routeAdvertisements: [{ metadata: { name: 'a' } }] }), NOW);
            expect(capabilityOf(model, 'route-advertisements').notes).toEqual([
                '1 RouteAdvertisements resource, 0 accepted; they are ignored while route advertisements are not Enabled',
            ]);
        });

        it('names the feature gate a gated feature needs, whether off, unlisted or unreadable', () => {
            const model = buildCnoConfigModel(inputsOf(fixture()), NOW);
            expect(capabilityOf(model, 'no-overlay').prerequisites[0]).toMatchObject({
                label: 'Feature gate NoOverlayMode is enabled', state: 'unmet', actual: 'Disabled', source: 'FeatureGate cluster',
            });

            const unlisted = fixture();
            unlisted.featureGate.status!.featureGates![0].disabled = [];
            expect(capabilityOf(buildCnoConfigModel(inputsOf(unlisted), NOW), 'uplink-optional').prerequisites[0])
                .toMatchObject({ state: 'unmet', actual: 'Not listed in this release' });

            const hidden = buildCnoConfigModel(inputsOf(fixture(), { featureGate: { status: 'forbidden' }, infrastructure: { status: 'forbidden' } }), NOW);
            expect(capabilityOf(hidden, 'no-overlay').prerequisites[0]).toMatchObject({ state: 'unknown', actual: 'The FeatureGate could not be read' });
            expect(capabilityOf(hidden, 'evpn').prerequisites[4]).toMatchObject({ state: 'unknown', actual: 'The Infrastructure could not be read' });
        });

        it('is unknown, not ready, when all that is left is something it could not read', () => {
            const data = fixture();
            const gateway = data.operatorNetwork.spec!.defaultNetwork!.ovnKubernetesConfig!.gatewayConfig!;
            gateway.routingViaHost = true;
            gateway.uplinkMode = 'Optional';
            const model = buildCnoConfigModel(inputsOf(data, { featureGate: { status: 'forbidden' } }), NOW);
            expect(capabilityOf(model, 'uplink-optional')).toMatchObject({ status: 'unknown', statusText: '2 of 3 prerequisites met' });
        });

        it('asks for the managed BGP configuration only when no-overlay routing is Managed', () => {
            const data = fixture();
            data.featureGate.status!.featureGates![0] = { version: '4.22.0', enabled: [{ name: 'NoOverlayMode' }], disabled: [] };
            const spec = data.operatorNetwork.spec!;
            spec.additionalRoutingCapabilities = { providers: ['FRR'] };
            const ovn = spec.defaultNetwork!.ovnKubernetesConfig!;
            ovn.routeAdvertisements = 'Enabled';
            ovn.transport = 'NoOverlay';
            ovn.noOverlayConfig = { outboundSNAT: 'Enabled', routing: 'Unmanaged' };
            expect(capabilityOf(buildCnoConfigModel(inputsOf(data), NOW), 'no-overlay')).toMatchObject({ status: 'ready' });
            expect(capabilityOf(buildCnoConfigModel(inputsOf(data), NOW), 'no-overlay').prerequisites).toHaveLength(4);

            ovn.noOverlayConfig.routing = 'Managed';
            expect(states(buildCnoConfigModel(inputsOf(data), NOW), 'no-overlay')[4]).toEqual(['bgp-managed-config', 'unmet', 'Not set']);
            ovn.bgpManagedConfig = { asNumber: 65001 };
            expect(states(buildCnoConfigModel(inputsOf(data), NOW), 'no-overlay')[4]).toEqual(['bgp-managed-config', 'met', 'AS 65001, FullMesh']);
        });

        it('reads MultiNetworkPolicy and hybrid overlay', () => {
            const data = fixture();
            data.operatorNetwork.spec!.useMultiNetworkPolicy = true;
            data.operatorNetwork.spec!.defaultNetwork!.ovnKubernetesConfig!.hybridOverlayConfig = { hybridClusterNetwork: [{ cidr: '10.132.0.0/14', hostPrefix: 23 }] };
            const model = buildCnoConfigModel(inputsOf(data), NOW);
            expect(capabilityOf(model, 'multi-network-policy').status).toBe('ready');
            expect(states(model, 'hybrid-overlay')).toEqual([['hybrid-overlay-config', 'met', '10.132.0.0/14']]);

            data.operatorNetwork.spec!.disableMultiNetwork = true;
            expect(states(buildCnoConfigModel(inputsOf(data), NOW), 'multi-network-policy')[0]).toEqual(['multi-network-enabled', 'unmet', 'true']);
        });
    });
});
