import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import { renderHook } from './testHookHarness';

let watchedNodes: K8sResourceCommon[] = [];

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    useK8sWatchResource: () => [watchedNodes, true, null],
}));

import { chassisNodeNamesFrom, useChassisNodeNames } from './useChassisNodeNames';

const node = (name: string, chassisId?: string): K8sResourceCommon => ({
    metadata: {
        name,
        annotations: chassisId ? { 'k8s.ovn.org/node-chassis-id': chassisId } : {},
    },
});

describe('useChassisNodeNames', () => {
    it('resolves a chassis id to the node carrying the annotation', () => {
        watchedNodes = [node('cnv-1', 'chassis-a'), node('ctrl-1', 'chassis-b')];
        const resolve = renderHook(() => useChassisNodeNames());
        expect(resolve('chassis-a')).toBe('cnv-1');
        expect(resolve('chassis-b')).toBe('ctrl-1');
    });

    it('yields undefined for chassis no Node claims', () => {
        watchedNodes = [node('cnv-1', 'chassis-a'), node('unannotated')];
        const resolve = renderHook(() => useChassisNodeNames());
        expect(resolve('chassis-gone')).toBeUndefined();
    });

    it('tolerates an empty or unloaded node list', () => {
        watchedNodes = [];
        expect(renderHook(() => useChassisNodeNames())('chassis-a')).toBeUndefined();
        expect(chassisNodeNamesFrom(undefined).size).toBe(0);
    });
});
