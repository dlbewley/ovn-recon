import { renderHook } from './testHookHarness';
import { OvnRecon } from '../types';

let watchedInstances: OvnRecon[] = [];

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    useK8sWatchResource: () => [watchedInstances, true, null],
}));

import { useOvnCollectorFeatureGate } from './useOvnCollectorFeatureGate';

describe('useOvnCollectorFeatureGate', () => {
    it('defaults to enabled when spec.collector.enabled is unset', () => {
        watchedInstances = [{ spec: {} } as OvnRecon];
        expect(renderHook(() => useOvnCollectorFeatureGate()).enabled).toBe(true);
    });

    it('honors an explicit disable', () => {
        watchedInstances = [{ spec: { collector: { enabled: false } } } as OvnRecon];
        expect(renderHook(() => useOvnCollectorFeatureGate()).enabled).toBe(false);
    });

    it('ignores the legacy gate’s materialized false', () => {
        watchedInstances = [
            { spec: { featureGates: { 'ovn-collector': false } } } as OvnRecon,
        ];
        expect(renderHook(() => useOvnCollectorFeatureGate()).enabled).toBe(true);
    });

    it('stays disabled when no OvnRecon exists at all', () => {
        watchedInstances = [];
        expect(renderHook(() => useOvnCollectorFeatureGate()).enabled).toBe(false);
    });
});
