import * as React from 'react';
import { useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';

import { kindReference } from '../../linkOut/registry';
import { useConsoleCapabilities } from '../../linkOut/useConsoleCapabilities';
import type { MultiNetworkPolicy, NetworkAttachmentDefinition, Pod } from '../../types';
import type { LogicalClusterInputs } from '../types';

/**
 * The watches the logical rules need beside the collector snapshot (ovn-recon-7i6.3).
 * Each yields undefined until it has loaded, so a rule needing it stays quiet.
 */

const POD = { group: '', version: 'v1', kind: 'Pod' };
const NAD = { group: 'k8s.cni.cncf.io', version: 'v1', kind: 'NetworkAttachmentDefinition' };
const MULTI_NETWORK_POLICY = { group: 'k8s.cni.cncf.io', version: 'v1beta1', kind: 'MultiNetworkPolicy' };

/**
 * The pods scheduled on one node, for lsp-down: a field-selected watch, not a
 * cluster-wide pod list. Undefined while loading, when refused, and for no node,
 * so the rule stays quiet rather than reading "no pods".
 */
export const useNodePods = (node: string | undefined): Pod[] | undefined => {
    const [pods, loaded, error] = useK8sWatchResource<Pod[]>(node ? {
        groupVersionKind: POD,
        isList: true,
        fieldSelector: `spec.nodeName=${node}`
    } : null);
    return node && loaded && !error && Array.isArray(pods) ? pods : undefined;
};

/**
 * The NADs and MultiNetworkPolicies for mnp-missing-nad. Watches nothing when either
 * CRD is absent (or not yet known), and is undefined until both lists have loaded.
 */
export const useLogicalClusterInputs = (): LogicalClusterInputs | undefined => {
    const { crds } = useConsoleCapabilities();
    const served = crds[kindReference({ apiVersion: 'k8s.cni.cncf.io/v1', kind: 'NetworkAttachmentDefinition' })] === true
        && crds[kindReference({ apiVersion: 'k8s.cni.cncf.io/v1beta1', kind: 'MultiNetworkPolicy' })] === true;
    const [nads, nadsLoaded, nadsError] = useK8sWatchResource<NetworkAttachmentDefinition[]>(
        served ? { groupVersionKind: NAD, isList: true } : null
    );
    const [policies, policiesLoaded, policiesError] = useK8sWatchResource<MultiNetworkPolicy[]>(
        served ? { groupVersionKind: MULTI_NETWORK_POLICY, isList: true } : null
    );
    const ready = served && nadsLoaded && policiesLoaded && !nadsError && !policiesError
        && Array.isArray(nads) && Array.isArray(policies);
    return React.useMemo(
        () => (ready ? { nads, multiNetworkPolicies: policies } : undefined),
        [ready, nads, policies]
    );
};
