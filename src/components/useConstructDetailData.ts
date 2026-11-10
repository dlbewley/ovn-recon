import * as React from 'react';

import { LogicalTopologySnapshot, SnapshotSection } from '../types';
import { fetchCollectorSnapshot } from './collectorApi';
import { OptionalSectionsState, useOptionalSections } from './useOptionalSections';

export interface ConstructDetailData {
    /** The node's ladder snapshot (no sections), once loaded for this node. */
    snapshot: LogicalTopologySnapshot | null;
    loading: boolean;
    /** The ladder request's error; the last good snapshot stays. */
    error?: string;
    /** The section request for the tabs opened so far. */
    sections: OptionalSectionsState;
    /** The sections requested so far during this visit. */
    requested: readonly SnapshotSection[];
    /** Reissue the current requests. */
    refresh: () => void;
}

/**
 * The detail page's data (ovn-recon-e2b.8, decisions 4 and 5).
 *
 * First the node's snapshot with no sections, exactly the ladder's request,
 * so the collector answers from the same cache entry. Then one request for
 * the union of the sections the tabs opened during this visit need: the union
 * only grows, so going back to a tab refetches nothing, and landing on a tab
 * that needs a section issues both requests at once. No polling: Refresh
 * bumps one counter that keys both requests, and the last good rows stay on
 * screen meanwhile. The cluster aggregate is never requested.
 */
export const useConstructDetailData = (
    node: string | undefined,
    tabSections: readonly SnapshotSection[],
    enabled: boolean,
): ConstructDetailData => {
    const [refreshKey, setRefreshKey] = React.useState(0);
    const [state, setState] = React.useState<{
        node?: string;
        snapshot: LogicalTopologySnapshot | null;
        loading: boolean;
        error?: string;
    }>({ snapshot: null, loading: false });

    React.useEffect(() => {
        if (!enabled || !node) return undefined;
        let cancelled = false;
        setState((previous) =>
            previous.node === node ? { ...previous, loading: true, error: undefined } : { node, snapshot: null, loading: true },
        );
        fetchCollectorSnapshot(node)
            .then((snapshot) => {
                if (!cancelled) setState({ node, snapshot, loading: false });
            })
            .catch((error: unknown) => {
                if (cancelled) return;
                setState((previous) => ({
                    node,
                    snapshot: previous.node === node ? previous.snapshot : null,
                    loading: false,
                    error: error instanceof Error ? error.message : 'Failed to load logical topology',
                }));
            });
        return () => {
            cancelled = true;
        };
    }, [enabled, node, refreshKey]);

    // The sections every tab opened so far needs, in a stable order.
    const [opened, setOpened] = React.useState<readonly SnapshotSection[]>(() => [...new Set(tabSections)].sort());
    const tabKey = [...tabSections].sort().join(',');
    React.useEffect(() => {
        setOpened((current) => {
            const missing = tabSections.filter((section) => !current.includes(section));
            return missing.length === 0 ? current : [...current, ...missing].sort();
        });
        // tabKey stands for tabSections, which callers may rebuild every render.
    }, [tabKey]);

    const sections = useOptionalSections(enabled ? node : undefined, opened, refreshKey);
    const refresh = React.useCallback(() => setRefreshKey((key) => key + 1), []);

    const current = state.node === node;
    return {
        snapshot: current ? state.snapshot : null,
        loading: current ? state.loading : enabled && Boolean(node),
        error: current ? state.error : undefined,
        sections,
        requested: opened,
        refresh,
    };
};
