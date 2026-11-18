import * as React from 'react';
import { K8sResourceCommon, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';

import { LauncherVmIndex, launcherVmIndex, NO_LAUNCHER_VMS, VmiLike } from './launcherVm';

const VMI_WATCH = {
    groupVersionKind: { group: 'kubevirt.io', version: 'v1', kind: 'VirtualMachineInstance' },
    isList: true,
};

/**
 * The launcher pod lookup, from one cluster-wide VirtualMachineInstance watch
 * (ovn-recon-zdt.5). Watches nothing unless `enabled`. A user who may not list
 * VMIs across the cluster gets an empty index, and pods stay pods.
 *
 * VMI status changes often and the index does not depend on it, so the index
 * keeps its identity until its content changes and open tables do not redraw.
 */
export const useLauncherVmIndex = (enabled: boolean): LauncherVmIndex => {
    const [vmis, loaded, error] = useK8sWatchResource<(K8sResourceCommon & VmiLike)[]>(enabled ? VMI_WATCH : null);
    const ready = enabled && loaded && !error && Array.isArray(vmis);
    const index = React.useMemo(() => (ready ? launcherVmIndex(vmis) : NO_LAUNCHER_VMS), [ready, vmis]);
    const content = React.useMemo(() => JSON.stringify([...index]), [index]);
    // `content` stands for `index` here.
    return React.useMemo(() => index, [content]);
};
