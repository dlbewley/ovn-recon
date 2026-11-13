import { renderHook } from './testHookHarness';
import { OvnRecon } from '../types';

let watchedInstances: OvnRecon[] = [];

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    useK8sWatchResource: () => [watchedInstances, true, null],
}));

import { collectorDeploymentOf, useOvnCollectorFeatureGate } from './useOvnCollectorFeatureGate';

describe('useOvnCollectorFeatureGate', () => {
    it('defaults to enabled when spec.collector.enabled is unset', () => {
        watchedInstances = [{ spec: {} } as OvnRecon];
        expect(renderHook(() => useOvnCollectorFeatureGate()).enabled).toBe(true);
    });

    it('honors an explicit disable', () => {
        watchedInstances = [{ spec: { collector: { enabled: false } } } as OvnRecon];
        expect(renderHook(() => useOvnCollectorFeatureGate()).enabled).toBe(false);
    });

    it('ignores unrelated spec fields left over from older schemas', () => {
        watchedInstances = [
            { spec: { featureGates: { 'ovn-collector': false } } } as unknown as OvnRecon,
        ];
        expect(renderHook(() => useOvnCollectorFeatureGate()).enabled).toBe(true);
    });

    it('stays disabled when no OvnRecon exists at all', () => {
        watchedInstances = [];
        expect(renderHook(() => useOvnCollectorFeatureGate()).enabled).toBe(false);
        expect(renderHook(() => useOvnCollectorFeatureGate()).collectorDeployment).toBeUndefined();
    });

    // ovn-recon-nt4.4: where to look when the collector does not answer, by the
    // operator's naming: <name>-collector in the target namespace.
    describe('the collector Deployment', () => {
        const instance = (name: string, creationTimestamp: string, extra: Partial<OvnRecon> = {}): OvnRecon =>
            ({ metadata: { name, creationTimestamp }, ...extra }) as OvnRecon;

        it('is the primary OvnRecon\'s, in the default namespace when none is set', () => {
            watchedInstances = [instance('newer', '2026-02-01T00:00:00Z'), instance('ovn-recon', '2026-01-01T00:00:00Z')];
            expect(collectorDeploymentOf(watchedInstances[1])).toEqual({ namespace: 'ovn-recon', name: 'ovn-recon-collector' });
            expect(renderHook(() => useOvnCollectorFeatureGate()).collectorDeployment)
                .toEqual({ namespace: 'ovn-recon', name: 'ovn-recon-collector' });
        });

        it('reads the namespace from status.effective first, then the spec', () => {
            expect(collectorDeploymentOf(instance('a', '', { spec: { targetNamespace: 'from-spec' } })))
                .toEqual({ namespace: 'from-spec', name: 'a-collector' });
            expect(collectorDeploymentOf(instance('a', '', {
                spec: { targetNamespace: 'from-spec' },
                status: { effective: { targetNamespace: 'resolved' } },
            }))).toEqual({ namespace: 'resolved', name: 'a-collector' });
            expect(collectorDeploymentOf(undefined)).toBeUndefined();
        });
    });
});
