import fs from 'fs';
import path from 'path';

import type {
    ClusterOperator, ConfigMap, ConfigNetwork, FeatureGate, Infrastructure, OperatorNetwork, RouteAdvertisements,
} from '../types';
import { buildCnoConfigModel, CnoConfigInputs, CnoConfigModel, ConfigRow, Source } from './cnoConfigModel';

/**
 * The Network config model against a sanitised capture of a real OpenShift 4.22 cluster
 * (test/fixtures/network-config/ocp-4.22-capture.json, ovn-recon-n7r.5): local gateway
 * mode, FRR with route advertisements on, one accepted RouteAdvertisements, bare metal,
 * MultiNetworkPolicy on; the ConfigMaps ovn-kubernetes-config-overrides and
 * gateway-mode-config were absent there.
 */

interface Capture {
    operatorNetwork: OperatorNetwork;
    configNetwork: ConfigNetwork;
    clusterOperator: ClusterOperator;
    featureGate: FeatureGate;
    infrastructure: Infrastructure;
    configMaps: { appliedCluster: ConfigMap; mtu: ConfigMap };
    routeAdvertisements: RouteAdvertisements[];
}

const capture = (): Capture => JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'network-config', 'ocp-4.22-capture.json'), 'utf-8'),
);

const ok = <T,>(data: T): Source<T> => ({ status: 'ok', data });
const ABSENT: Source<never> = { status: 'absent' };
const NOW = Date.parse('2026-02-01T00:00:00Z');

const inputsOf = (data: Capture): CnoConfigInputs => ({
    operatorNetwork: ok(data.operatorNetwork),
    configNetwork: ok(data.configNetwork),
    clusterOperator: ok(data.clusterOperator),
    featureGate: ok(data.featureGate),
    infrastructure: ok(data.infrastructure),
    configMaps: { appliedCluster: ok(data.configMaps.appliedCluster), mtu: ok(data.configMaps.mtu), overrides: ABSENT, gatewayMode: ABSENT },
    nodes: [],
    routeAdvertisements: data.routeAdvertisements,
    vteps: [],
});

const rowOf = (model: CnoConfigModel, id: string): ConfigRow | undefined =>
    model.sections.flatMap((section) => section.rows).find((row) => row.id === id);

describe('the Network config model against a captured 4.22 cluster', () => {
    const model = buildCnoConfigModel(inputsOf(capture()), NOW);

    it('reads every source', () => {
        expect(model.sources.filter((source) => !source.optional).map((source) => source.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
        expect(model.loading).toBe(false);
    });

    it('summarises it', () => {
        expect(model.summary.map(({ id, value }) => [id, value])).toEqual([
            ['network-type', 'OVNKubernetes'],
            ['gateway-mode', 'Local'],
            ['transport', 'Geneve'],
            ['mtu', '1400'],
            ['ipsec', 'Disabled'],
            ['routing', 'FRR + route advertisements'],
        ]);
    });

    it('raises no notices: nothing is pending and no override is present', () => {
        expect(model.notices).toEqual([]);
        expect(model.applied).toEqual({ status: 'match', differences: [], text: 'Matches the spec' });
        expect(rowOf(model, 'applied-configuration')).toMatchObject({ value: 'Matches the spec', origin: 'reported', source: 'ConfigMap applied-cluster' });
    });

    it('reads the written-back defaults as set, and the MTUs from where they are reported', () => {
        expect(rowOf(model, 'mtu')).toMatchObject({ value: '1400', origin: 'set' });
        expect(rowOf(model, 'geneve-port')).toMatchObject({ value: '6081', origin: 'set' });
        expect(rowOf(model, 'audit-destination')).toMatchObject({ value: 'null', origin: 'set' });
        expect(rowOf(model, 'cluster-mtu')).toMatchObject({ value: '1400', origin: 'reported' });
        expect(rowOf(model, 'cluster-mtu')?.note).toBeUndefined();
        expect(rowOf(model, 'host-mtu')).toMatchObject({ value: '1500', source: 'ConfigMap mtu' });
    });

    it('reads empty sub-objects (gatewayConfig.ipv4, egressIPConfig) as defaults, not as set', () => {
        expect(rowOf(model, 'masquerade-subnet-ipv4')).toMatchObject({ value: '169.254.0.0/17', origin: 'default' });
        expect(rowOf(model, 'egress-ip-timeout')).toMatchObject({ origin: 'default' });
        expect(rowOf(model, 'join-subnet-ipv6')).toBeUndefined();
    });

    it('reads the empty external IP policy the installer writes as refusing external IPs', () => {
        expect(rowOf(model, 'external-ip')).toMatchObject({ value: 'No CIDRs allowed (external IPs are refused)', origin: 'set' });
        expect(rowOf(model, 'network-diagnostics')).toMatchObject({ origin: 'unset' });
    });

    it('takes the feature gates of the running version, and says which gate this release does not list', () => {
        expect(rowOf(model, 'feature-set')).toMatchObject({ value: 'Default', origin: 'default' });
        expect(rowOf(model, 'gate-NoOverlayMode')?.value).toBe('Disabled');
        expect(rowOf(model, 'gate-OVNKubernetesUplinkMode')?.value).toBe('Not listed in this release');
        expect(rowOf(model, 'cluster-operator-version')?.value).toBe('4.22.22');
        expect(rowOf(model, 'platform')?.value).toBe('BareMetal');
    });

    it('ticks route advertisements and EVPN, counting the accepted RouteAdvertisements by their real condition', () => {
        const status = Object.fromEntries(model.capabilities.map((capability) => [capability.id, capability.status]));
        expect(status).toEqual({
            'route-advertisements': 'ready',
            evpn: 'ready',
            'no-overlay': 'not-ready',
            'uplink-optional': 'not-ready',
            'multi-network-policy': 'ready',
            ipsec: 'not-ready',
            'hybrid-overlay': 'not-ready',
        });
        expect(model.capabilities[0].notes).toEqual(['1 RouteAdvertisements resource, 1 accepted']);
    });

    it('reads the ClusterOperator conditions, which carry no reason or message, as healthy', () => {
        expect(model.conditions.every((condition) => condition.severity === 'none')).toBe(true);
        expect(model.conditions.filter((condition) => condition.source === 'ClusterOperator network').map((condition) => condition.reason))
            .toEqual(['', '', '', '', '']);
    });
});
