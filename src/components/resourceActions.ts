import * as React from 'react';
import { Action, K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import { ovnReconPathFor } from './consoleIntegration';

/**
 * "Open in OVN Recon" kebab actions (ovn-recon-zdt.2), each a
 * console.action/resource-provider hook gated on OVN_RECON_RESOURCE_ACTIONS.
 * A Node opens its physical topology; a CUDN, UDN or NAD opens its network page.
 */

export const OPEN_IN_OVN_RECON = 'Open in OVN Recon';

type ActionsResult = [Action[], boolean, undefined];

const useOpenAction = (resource: K8sResourceCommon | undefined, kind: string, id: string): ActionsResult => {
    const href = ovnReconPathFor(resource, resource?.kind ?? kind);
    const actions = React.useMemo<Action[]>(
        () => (href ? [{ id, label: OPEN_IN_OVN_RECON, cta: { href } }] : []),
        [href, id],
    );
    return [actions, true, undefined];
};

export const useNodeActions = (node: K8sResourceCommon): ActionsResult =>
    useOpenAction(node, 'Node', 'ovn-recon-open-node');

export const useClusterUserDefinedNetworkActions = (network: K8sResourceCommon): ActionsResult =>
    useOpenAction(network, 'ClusterUserDefinedNetwork', 'ovn-recon-open-network');

export const useUserDefinedNetworkActions = (network: K8sResourceCommon): ActionsResult =>
    useOpenAction(network, 'UserDefinedNetwork', 'ovn-recon-open-network');

export const useNetworkAttachmentDefinitionActions = (network: K8sResourceCommon): ActionsResult =>
    useOpenAction(network, 'NetworkAttachmentDefinition', 'ovn-recon-open-network');
