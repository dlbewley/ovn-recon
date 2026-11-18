import { ConsoleCapabilities, kindReference, VIRTUAL_MACHINE, VIRTUAL_MACHINE_INSTANCE } from './registry';

/**
 * Which VirtualMachine a virt-launcher pod runs (ovn-recon-zdt.5). Pure.
 *
 * The places that name a launcher pod read it from a collector snapshot, which
 * holds the pod's namespace and name and no Pod object, so the pod's labels and
 * owner are out of reach there. What links the name to a VM is KubeVirt's own
 * naming, checked against the VirtualMachineInstances that exist:
 *
 * - The pod is created with generateName `virt-launcher-<VMI name>-`. The API
 *   server cuts that base to 58 characters and appends 5 random ones, so a long
 *   VMI name loses its tail and the separator. Comparing bases covers both cases;
 *   stripping the affixes from the pod name would not, and could not tell a VM
 *   name from a guess.
 * - A VMI started by a VM has that VM as its controller owner. A VMI with no such
 *   owner (created directly, or by a replica set) has no VM page to link.
 * - Two VMIs in a namespace can share a cut base. Such a pod resolves to nothing.
 *
 * The pod's `vm.kubevirt.io/name` label is not used even where a Pod is at hand:
 * KubeVirt sets it to the VMI's hostname, which `spec.hostname` can change.
 */

const LAUNCHER_PREFIX = 'virt-launcher-';
const GENERATED_SUFFIX_LENGTH = 5;
const MAX_GENERATED_BASE_LENGTH = 58;

export interface LauncherVm {
    namespace: string;
    name: string;
}

/** The parts of a VirtualMachineInstance the lookup reads. */
export interface VmiLike {
    metadata?: {
        namespace?: string;
        name?: string;
        ownerReferences?: ReadonlyArray<{
            apiVersion?: string;
            kind?: string;
            name?: string;
            controller?: boolean;
        }>;
    };
}

/** By namespace and generated base; null where no one VM can be named. */
export type LauncherVmIndex = ReadonlyMap<string, LauncherVm | null>;

export const NO_LAUNCHER_VMS: LauncherVmIndex = new Map();

/** Named like a launcher pod. Says nothing about whether it is one. */
export const isLauncherPodName = (pod: string | undefined): boolean =>
    !!pod && pod.startsWith(LAUNCHER_PREFIX) && pod.length > LAUNCHER_PREFIX.length + GENERATED_SUFFIX_LENGTH;

const indexKey = (namespace: string, base: string): string => `${namespace}/${base}`;

const vmOfVmi = (namespace: string, vmi: VmiLike): LauncherVm | null => {
    const owner = vmi.metadata?.ownerReferences?.find((reference) =>
        reference.controller === true
        && reference.kind === VIRTUAL_MACHINE.kind
        && reference.apiVersion?.startsWith('kubevirt.io/'));
    return owner?.name ? { namespace, name: owner.name } : null;
};

export const launcherVmIndex = (vmis: readonly VmiLike[]): LauncherVmIndex => {
    const index = new Map<string, LauncherVm | null>();
    for (const vmi of vmis) {
        const { namespace, name } = vmi.metadata ?? {};
        if (!namespace || !name) continue;
        const base = `${LAUNCHER_PREFIX}${name}-`.slice(0, MAX_GENERATED_BASE_LENGTH);
        const key = indexKey(namespace, base);
        index.set(key, index.has(key) ? null : vmOfVmi(namespace, vmi));
    }
    return index;
};

/** The VM a pod runs, or undefined for any pod that cannot be tied to exactly one. */
export const launcherVmOf = (
    index: LauncherVmIndex,
    namespace: string | undefined,
    pod: string | undefined,
): LauncherVm | undefined => {
    if (!namespace || !pod || !isLauncherPodName(pod)) return undefined;
    return index.get(indexKey(namespace, pod.slice(0, -GENERATED_SUFFIX_LENGTH))) ?? undefined;
};

/** Both kinds are needed: the VMI to resolve a pod, the VM for the page it opens. */
export const launcherVmsServed = ({ crds }: ConsoleCapabilities): boolean =>
    crds[kindReference(VIRTUAL_MACHINE)] === true && crds[kindReference(VIRTUAL_MACHINE_INSTANCE)] === true;
