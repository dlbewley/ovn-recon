import * as React from 'react';

import { LogicalDatabase, SnapshotSection } from '../types';
import { fetchCollectorSnapshot, normalizeSections } from './collectorApi';

export interface OptionalSectionsState {
    /**
     * The node's database including the requested sections, once loaded. A
     * section key that is still undefined on it was not collected, and keeps
     * its "not collected" rendering.
     */
    database?: LogicalDatabase;
    loading: boolean;
    error?: string;
}

/**
 * Second fetch for the views that render the optional snapshot sections
 * (policy, services). The topology pages keep their own ladder fetch and
 * render first; a drawer tab that needs a section calls this with the node
 * whose snapshot it reads (the representative node on the cluster view).
 *
 * Nothing is fetched while `nodeName` is unset or `sections` is empty, so a
 * caller can pass an empty list until its tab is opened. Changing
 * `refreshKey` (the ladder snapshot's generatedAt, say) refetches, keeping the
 * last good database on screen while the request is in flight or fails.
 */
export const useOptionalSections = (
    nodeName: string | undefined,
    sections: readonly SnapshotSection[],
    refreshKey?: string | number,
): OptionalSectionsState => {
    // The sorted, joined names are the stable identity of the request:
    // callers may pass a fresh array literal on every render.
    const sectionKey = normalizeSections(sections).join(',');
    const requestKey = nodeName && sectionKey ? `${nodeName}?${sectionKey}` : '';

    const [state, setState] = React.useState<OptionalSectionsState & { requestKey: string }>({
        loading: false,
        requestKey: '',
    });

    React.useEffect(() => {
        if (!nodeName || !requestKey) return undefined;

        let cancelled = false;
        // A different node or section set must not show the previous one's
        // rows; a refresh of the same request keeps them.
        setState((previous) => ({
            database: previous.requestKey === requestKey ? previous.database : undefined,
            loading: true,
            requestKey,
        }));

        const include = sectionKey.split(',') as SnapshotSection[];
        fetchCollectorSnapshot(nodeName, { include })
            .then((snapshot) => {
                if (cancelled) return;
                setState({ database: snapshot.database, loading: false, requestKey });
            })
            .catch((error: unknown) => {
                if (cancelled) return;
                setState((previous) => ({
                    database: previous.database,
                    loading: false,
                    error: error instanceof Error ? error.message : 'Failed to load snapshot sections',
                    requestKey,
                }));
            });

        return () => {
            cancelled = true;
        };
    }, [nodeName, sectionKey, requestKey, refreshKey]);

    if (!requestKey || state.requestKey !== requestKey) {
        // Idle, or the effect for a new request has not run yet.
        return { loading: Boolean(requestKey) };
    }
    return { database: state.database, loading: state.loading, error: state.error };
};
