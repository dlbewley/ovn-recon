import { buildCnoConfigModel, CnoConfigInputs, Source } from '../components/cnoConfigModel';
import type { ClusterOperator, ConfigMap, ConfigNetwork, FeatureGate, Infrastructure, OperatorNetwork } from '../types';
import { clone, loadFixture } from './testing';
import type { ClusterNetworkConfig } from './types';

/*
 * Fixtures for the cno-* rule tests (ovn-recon-n7r.3). The base is the healthy
 * default cluster of test/fixtures/network-config/default.json, which a test varies
 * on a fresh copy. Not imported by any shipped module.
 */

export interface CnoFixture {
    operatorNetwork: OperatorNetwork;
    configNetwork: ConfigNetwork;
    clusterOperator: ClusterOperator;
    featureGate: FeatureGate;
    infrastructure: Infrastructure;
}

/** A fresh copy of the default cluster's network configuration. */
export const cnoFixture = (): CnoFixture => clone(loadFixture<CnoFixture>('network-config', 'default.json'));

/** Well after every lastTransitionTime in the fixture. */
export const CNO_NOW = Date.parse('2026-02-01T00:00:00Z');

const ok = <T,>(data: T | undefined): Source<T> => (data ? { status: 'ok', data } : { status: 'absent' });
const ABSENT: Source<ConfigMap> = { status: 'absent' };

/** The sources a fixture stands for, every optional ConfigMap absent unless `extra` says otherwise. */
export const cnoSourcesOf = (data: CnoFixture, extra: Partial<CnoConfigInputs> = {}): CnoConfigInputs => ({
    operatorNetwork: ok(data.operatorNetwork),
    configNetwork: ok(data.configNetwork),
    clusterOperator: ok(data.clusterOperator),
    featureGate: ok(data.featureGate),
    infrastructure: ok(data.infrastructure),
    configMaps: { appliedCluster: ABSENT, mtu: ABSENT, overrides: ABSENT, gatewayMode: ABSENT },
    nodes: [],
    routeAdvertisements: [],
    vteps: [],
    ...extra
});

/** What the shell hands the findings: the sources and the model built from them. */
export const networkConfigOf = (
    data: CnoFixture = cnoFixture(), extra: Partial<CnoConfigInputs> = {}, now: number = CNO_NOW
): ClusterNetworkConfig => {
    const sources = cnoSourcesOf(data, extra);
    return { sources, model: buildCnoConfigModel(sources, now) };
};

/** A fixture changed by `change`, for a one-line variation in a test. */
export const cnoWith = (change: (data: CnoFixture) => void): CnoFixture => {
    const data = cnoFixture();
    change(data);
    return data;
};
