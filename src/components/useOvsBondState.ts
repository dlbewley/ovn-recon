import * as React from 'react';

import { OvsBondRuntimeState } from '../topology/context';
import { OvsBondsResponse } from '../types';
import { describeCollectorFailure, fetchOvsBondState } from './collectorApi';

/**
 * The collector's bond/show answer as the drawer reads it (ovn-recon-1tw.7): bonds
 * keyed by name, since bond/show names bonds and not their bridges, and OVS keeps
 * a bond's name unique on its node.
 */
export const ovsBondRuntimeState = (response: OvsBondsResponse, nodeName: string): OvsBondRuntimeState => ({
    byBond: new Map((response.bonds ?? []).map((bond) => [bond.name, bond])),
    nodeName: response.metadata?.nodeName || nodeName,
    generatedAt: response.metadata?.generatedAt ?? '',
    sourceHealth: response.metadata?.sourceHealth ?? '',
    warnings: response.warnings ?? [],
});

/**
 * One node's OVS bond runtime state from the collector (ovn-recon-1tw.7), or
 * undefined. The caller passes `enabled` only with the collector gate on AND an OVS
 * bond on the node, so a node without one, or a cluster without the collector, never
 * sends a request. Fetched when the view mounts, the node changes or `enabled` turns
 * on; the physical view reads Kubernetes watches and has no refresh control to hang a
 * refetch on. A failure is kept as its one-line summary (describeCollectorFailure),
 * so the drawer can say why the state is missing.
 */
export const useOvsBondState = (nodeName: string, enabled: boolean): OvsBondRuntimeState | undefined => {
    const [state, setState] = React.useState<{ key: string; value: OvsBondRuntimeState } | undefined>(undefined);
    const key = enabled && nodeName ? nodeName : '';

    React.useEffect(() => {
        if (!key) return undefined;
        let cancelled = false;
        fetchOvsBondState(key)
            .then((response) => {
                if (!cancelled) setState({ key, value: ovsBondRuntimeState(response, key) });
            })
            .catch((error: unknown) => {
                if (!cancelled) setState({ key, value: { error: describeCollectorFailure(error).summary } });
            });
        return () => {
            cancelled = true;
        };
    }, [key]);

    // An answer for another node, or one left from before the gate closed, is not shown.
    return key && state?.key === key ? state.value : undefined;
};
