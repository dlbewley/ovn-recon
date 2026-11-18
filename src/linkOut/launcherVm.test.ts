import {
    isLauncherPodName, launcherVmIndex, launcherVmOf, launcherVmsServed, NO_LAUNCHER_VMS, VmiLike,
} from './launcherVm';
import { BARE, KUBEVIRT, NO_KUBEVIRT } from './testCapabilities';
import { NO_CAPABILITIES } from './registry';

const vmi = (namespace: string, name: string, owner: Partial<NonNullable<NonNullable<VmiLike['metadata']>['ownerReferences']>[number]> | null = {}): VmiLike => ({
    metadata: {
        namespace,
        name,
        ownerReferences: owner === null ? [] : [{
            apiVersion: 'kubevirt.io/v1',
            kind: 'VirtualMachine',
            name,
            controller: true,
            ...owner,
        }],
    },
});

/** What the API server makes of generateName `virt-launcher-<vmi>-`. */
const launcherPod = (vmiName: string, suffix = 'x7k2p'): string =>
    `${`virt-launcher-${vmiName}-`.slice(0, 58)}${suffix}`;

describe('launcher pod to VirtualMachine (ovn-recon-zdt.5)', () => {
    it('finds the VM of a launcher pod through its VMI', () => {
        const index = launcherVmIndex([vmi('shop', 'db-1')]);
        expect(launcherVmOf(index, 'shop', launcherPod('db-1'))).toEqual({ namespace: 'shop', name: 'db-1' });
    });

    it('takes the name from the owner, not from the pod', () => {
        const index = launcherVmIndex([vmi('shop', 'db-1', { name: 'the-owner' })]);
        expect(launcherVmOf(index, 'shop', launcherPod('db-1'))?.name).toBe('the-owner');
    });

    it('keeps hyphens that make the VM name ambiguous from the pod name alone', () => {
        const index = launcherVmIndex([vmi('shop', 'db'), vmi('shop', 'db-1')]);
        expect(launcherVmOf(index, 'shop', launcherPod('db'))?.name).toBe('db');
        expect(launcherVmOf(index, 'shop', launcherPod('db-1'))?.name).toBe('db-1');
    });

    it('does not cross namespaces', () => {
        const index = launcherVmIndex([vmi('shop', 'db-1')]);
        expect(launcherVmOf(index, 'other', launcherPod('db-1'))).toBeUndefined();
    });

    it('resolves a VM whose name the generated pod name cuts short', () => {
        const name = `vm-${'a'.repeat(60)}`;
        const pod = launcherPod(name);
        expect(pod).toHaveLength(63);
        expect(launcherVmOf(launcherVmIndex([vmi('shop', name)]), 'shop', pod)?.name).toBe(name);
    });

    it('resolves nothing when two VMIs share the cut name', () => {
        const shared = 'a'.repeat(50);
        const index = launcherVmIndex([vmi('shop', `${shared}-one`), vmi('shop', `${shared}-two`)]);
        expect(launcherVmOf(index, 'shop', launcherPod(`${shared}-one`))).toBeUndefined();
    });

    it('leaves a pod with no VMI unresolved, whatever its name suggests', () => {
        expect(launcherVmOf(launcherVmIndex([vmi('shop', 'db-1')]), 'shop', launcherPod('gone'))).toBeUndefined();
        expect(launcherVmOf(NO_LAUNCHER_VMS, 'shop', launcherPod('db-1'))).toBeUndefined();
    });

    it.each<[string, VmiLike]>([
        ['has no owner', vmi('shop', 'db-1', null)],
        ['is owned by something else', vmi('shop', 'db-1', { kind: 'VirtualMachineInstanceReplicaSet' })],
        ['is owned by another API group', vmi('shop', 'db-1', { apiVersion: 'example.com/v1' })],
        ['has a VM as a non-controller owner', vmi('shop', 'db-1', { controller: false })],
    ])('names no VM for a VMI that %s', (_title, row) => {
        expect(launcherVmOf(launcherVmIndex([row]), 'shop', launcherPod('db-1'))).toBeUndefined();
    });

    it('ignores every other pod', () => {
        const index = launcherVmIndex([vmi('shop', 'db-1')]);
        expect(launcherVmOf(index, 'shop', 'db-1-x7k2p')).toBeUndefined();
        expect(launcherVmOf(index, undefined, launcherPod('db-1'))).toBeUndefined();
        expect(launcherVmOf(index, 'shop', undefined)).toBeUndefined();
        expect(isLauncherPodName('virt-launcher-')).toBe(false);
        expect(isLauncherPodName('etcd-0')).toBe(false);
        expect(isLauncherPodName(undefined)).toBe(false);
        expect(isLauncherPodName(launcherPod('db-1'))).toBe(true);
    });

    it('needs both kubevirt.io kinds to be known to the console', () => {
        expect(launcherVmsServed(KUBEVIRT)).toBe(true);
        expect(launcherVmsServed(NO_KUBEVIRT)).toBe(false);
        expect(launcherVmsServed(BARE)).toBe(false);
        expect(launcherVmsServed(NO_CAPABILITIES)).toBe(false);
    });
});
