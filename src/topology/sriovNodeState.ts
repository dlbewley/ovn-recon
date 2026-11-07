import {
    SriovNetworkNodeState, SriovNodeStateSpecInterface, SriovNodeStateStatusInterface, SriovNodeStateVf, SriovVfGroup
} from '../types';

/**
 * Reading SriovNetworkNodeState (ovn-recon-s3t.66).
 *
 * NodeNetworkState says a PF has VFs and which of them are host interfaces. It cannot
 * say what the others are for. The SR-IOV Network Operator's per-node record can:
 * spec.interfaces[].vfGroups[] carves each PF's VFs into pools, one per device-plugin
 * resource, and status.interfaces[].Vfs[] names the driver each VF is bound to. Every
 * function here is pure and tolerates a resource that is absent or trimmed.
 */

/** The extended-resource prefix the operator uses; a NAD's annotation carries it, the node state does not. */
const DEFAULT_RESOURCE_PREFIX = 'openshift.io';

/** A pool of VFs on one PF, as one vfGroup describes it. */
export interface SriovVfPool {
    pfName: string;
    group: SriovVfGroup;
    /** The VF ids in `vfRange`, in order. Empty when the range does not parse. */
    vfIds: number[];
}

/** "0-3" -> [0, 1, 2, 3]; "2-2" -> [2]; a bare "4" -> [4]. Anything else -> []. */
export const parseVfRange = (range: unknown): number[] => {
    if (typeof range !== 'string') return [];
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(range);
    if (!match) return [];
    const first = Number(match[1]);
    const last = match[2] == null ? first : Number(match[2]);
    if (last < first) return [];
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
};

const specInterfaces = (state: SriovNetworkNodeState | undefined): SriovNodeStateSpecInterface[] =>
    (Array.isArray(state?.spec?.interfaces) ? state!.spec!.interfaces! : []).filter((pf) => pf && typeof pf === 'object');

const statusInterfaces = (state: SriovNetworkNodeState | undefined): SriovNodeStateStatusInterface[] =>
    (Array.isArray(state?.status?.interfaces) ? state!.status!.interfaces! : []).filter((pf) => pf && typeof pf === 'object');

/** Every pool on this node, PF by PF, in the order the spec lists them. */
export const getSriovVfPools = (state: SriovNetworkNodeState | undefined): SriovVfPool[] =>
    specInterfaces(state).flatMap((pf) => {
        const pfName = pf.name;
        if (!pfName) return [];
        return (Array.isArray(pf.vfGroups) ? pf.vfGroups : [])
            .filter((group) => group && typeof group === 'object')
            .map((group) => ({ pfName, group, vfIds: parseVfRange(group.vfRange) }));
    });

/** The pools carved out of one PF. */
export const getSriovVfPoolsForPf = (state: SriovNetworkNodeState | undefined, pfName: string): SriovVfPool[] =>
    getSriovVfPools(state).filter((pool) => pool.pfName === pfName);

/** The pool one VF of a PF belongs to, if any group's range covers it. */
export const findSriovPoolForVf = (
    state: SriovNetworkNodeState | undefined, pfName: string, vfId: number
): SriovVfPool | undefined =>
    getSriovVfPoolsForPf(state, pfName).find((pool) => pool.vfIds.includes(vfId));

/**
 * A NAD names its resource as `openshift.io/vm_igb`; the node state names the pool
 * `vm_igb`. The prefix is the operator's resource prefix and may be customised per
 * policy, so match on the part after the last `/` and let a bare name through as is.
 */
export const resourceNameMatches = (annotated: string | undefined, poolResource: string | undefined): boolean => {
    if (!annotated || !poolResource) return false;
    const bare = annotated.includes('/') ? annotated.slice(annotated.lastIndexOf('/') + 1) : annotated;
    const poolBare = poolResource.includes('/') ? poolResource.slice(poolResource.lastIndexOf('/') + 1) : poolResource;
    return bare === poolBare;
};

/** The qualified name a pool is requested by, for display beside a NAD's annotation. */
export const qualifiedResourceName = (poolResource: string): string =>
    poolResource.includes('/') ? poolResource : `${DEFAULT_RESOURCE_PREFIX}/${poolResource}`;

/** The pools, on whichever PFs, that feed a device-plugin resource. */
export const findSriovPoolsForResource = (
    state: SriovNetworkNodeState | undefined, resourceName: string | undefined
): SriovVfPool[] =>
    getSriovVfPools(state).filter((pool) => resourceNameMatches(resourceName, pool.group.resourceName));

/** What the config daemon found for one VF of a PF: its driver, PCI address and host name. */
export const getSriovVfState = (
    state: SriovNetworkNodeState | undefined, pfName: string, vfId: number
): SriovNodeStateVf | undefined => {
    const pf = statusInterfaces(state).find((candidate) => candidate.name === pfName);
    const vfs = Array.isArray(pf?.Vfs) ? pf!.Vfs! : [];
    return vfs.find((vf) => vf && typeof vf === 'object' && vf.vfID === vfId);
};

/** The status entry for a PF, for what nmstate does not report: the eSwitch mode, say. */
export const getSriovPfState = (
    state: SriovNetworkNodeState | undefined, pfName: string
): SriovNodeStateStatusInterface | undefined =>
    statusInterfaces(state).find((pf) => pf.name === pfName);

/** "VFs 0-3" or "VF 2", from the ids a range parsed to. */
export const describeVfIds = (vfIds: number[]): string => {
    if (vfIds.length === 0) return 'no VFs';
    if (vfIds.length === 1) return `VF ${vfIds[0]}`;
    return `VFs ${vfIds[0]}-${vfIds[vfIds.length - 1]}`;
};
