import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { LauncherVmIndex, launcherVmOf, NO_LAUNCHER_VMS, VmiLike } from './launcherVm';

const mockWatch = jest.fn();

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    useK8sWatchResource: (resource: unknown) => mockWatch(resource),
}));

// jest.setup.js replaces the hook for every suite; this one tests the real thing.
const { useLauncherVmIndex } = jest.requireActual('./useLauncherVmIndex') as {
    useLauncherVmIndex: (enabled: boolean) => LauncherVmIndex;
};

const vmi = (name: string, phase = 'Running'): VmiLike & { status: { phase: string } } => ({
    metadata: {
        namespace: 'shop',
        name,
        ownerReferences: [{ apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine', name, controller: true }],
    },
    status: { phase },
});

describe('useLauncherVmIndex (ovn-recon-zdt.5)', () => {
    let root: Root;
    let seen: LauncherVmIndex[];

    const Probe: React.FC<{ enabled: boolean }> = ({ enabled }) => {
        seen.push(useLauncherVmIndex(enabled));
        return null;
    };
    const render = (enabled: boolean) => act(() => root.render(<Probe enabled={enabled} />));
    const latest = () => seen[seen.length - 1];

    beforeEach(() => {
        seen = [];
        mockWatch.mockReset();
        root = createRoot(document.createElement('div'));
    });

    afterEach(() => act(() => root.unmount()));

    it('watches nothing when it is not enabled', () => {
        mockWatch.mockReturnValue([undefined, false, undefined]);
        render(false);
        expect(mockWatch).toHaveBeenCalledWith(null);
        expect(latest()).toBe(NO_LAUNCHER_VMS);
    });

    it('lists VirtualMachineInstances across the cluster when enabled', () => {
        mockWatch.mockReturnValue([[vmi('db-1')], true, undefined]);
        render(true);
        expect(mockWatch).toHaveBeenCalledWith({
            groupVersionKind: { group: 'kubevirt.io', version: 'v1', kind: 'VirtualMachineInstance' },
            isList: true,
        });
        expect(launcherVmOf(latest(), 'shop', 'virt-launcher-db-1-x7k2p')?.name).toBe('db-1');
    });

    it('resolves nothing while loading or when the list is refused', () => {
        mockWatch.mockReturnValue([[], false, undefined]);
        render(true);
        expect(latest().size).toBe(0);
        mockWatch.mockReturnValue([[vmi('db-1')], true, new Error('forbidden')]);
        render(true);
        expect(latest().size).toBe(0);
    });

    it('keeps the same index through a status change, and replaces it for a new VM', () => {
        mockWatch.mockReturnValue([[vmi('db-1')], true, undefined]);
        render(true);
        const first = latest();

        mockWatch.mockReturnValue([[vmi('db-1', 'Migrating')], true, undefined]);
        render(true);
        expect(latest()).toBe(first);

        mockWatch.mockReturnValue([[vmi('db-1'), vmi('db-2')], true, undefined]);
        render(true);
        expect(latest()).not.toBe(first);
        expect(latest().size).toBe(2);
    });
});
