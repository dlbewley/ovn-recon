import * as React from 'react';
import { K8sResourceCommon, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';

/** Node annotation carrying the SB Chassis name OVN-Kubernetes registered for the node. */
export const NODE_CHASSIS_ID_ANNOTATION = 'k8s.ovn.org/node-chassis-id';

/**
 * Map SB chassis names (UUID strings, as they appear in NB rows such as
 * Logical_Router_Port status:hosting-chassis, Gateway_Chassis.chassis_name
 * and the requested-chassis option) to node names, from the Node annotation
 * k8s.ovn.org/node-chassis-id. Pure, so model code and tests can use it
 * without the watch.
 */
export const chassisNodeNamesFrom = (nodes: K8sResourceCommon[] | undefined): Map<string, string> => {
    const byChassis = new Map<string, string>();
    for (const node of nodes ?? []) {
        const chassisId = node.metadata?.annotations?.[NODE_CHASSIS_ID_ANNOTATION];
        const name = node.metadata?.name;
        if (chassisId && name) byChassis.set(chassisId, name);
    }
    return byChassis;
};

/**
 * Watch Nodes and resolve chassis names to node names. Returns a resolver
 * that yields undefined for chassis no Node claims (a node that left the
 * cluster, or Nodes not yet loaded), so callers fall back to the raw id.
 */
export const useChassisNodeNames = (): ((chassisName: string) => string | undefined) => {
    const [nodes] = useK8sWatchResource<K8sResourceCommon[]>({
        groupVersionKind: { version: 'v1', kind: 'Node' },
        isList: true,
    });
    const byChassis = React.useMemo(() => chassisNodeNamesFrom(nodes), [nodes]);
    return React.useCallback((chassisName: string) => byChassis.get(chassisName), [byChassis]);
};
