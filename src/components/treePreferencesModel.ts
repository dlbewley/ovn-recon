import * as React from 'react';

/**
 * What the explorer remembers about its tree (ovn-recon-gbr.9), and where.
 *
 * - Width and whether the tree is collapsed are the user's preference: kept in the
 *   console's user settings (`useTreePreferences`), so they follow the user to a new
 *   browser session and another machine.
 * - Which groups are open is a detail of where the user is: kept in sessionStorage
 *   for the browser tab, so it survives the console's cold-load remount and a trip to
 *   another console page and back, but a new tab starts from the default (Nodes open).
 *   Writing it to user settings would cost a ConfigMap write per click for little.
 *
 * The name filter, the switches and the open search stay component state.
 */

export const TREE_SETTINGS_KEY = 'ovn-recon.explorer.tree';
export const OPEN_GROUPS_STORAGE_KEY = 'ovn-recon.explorer.openGroups';

// 240 px leaves the node table one line per row at 1440 px with the console nav open.
export const TREE_DEFAULT_SIZE = '240px';
export const TREE_MIN_SIZE = '200px';
export const TREE_MAX_SIZE = '480px';

/**
 * Below this width of the shell (the console's content area, not the window), the
 * tree leaves a graph and its detail drawer too little room, and the explorer starts
 * collapsed, whatever is stored. A 1280 px window with the console's nav open gives
 * the shell about 990 px and starts collapsed; 1440 px gives about 1150 and does not,
 * which is the width the tree's default is sized for. (Checked on the hub: a 1384 px
 * window gives 1062.)
 */
export const NARROW_SHELL_WIDTH = 1024;

export interface TreePreferences {
    /** The tree's width, in pixels, as a CSS length. */
    width: string;
    collapsed: boolean;
}

export const DEFAULT_TREE_PREFERENCES: TreePreferences = { width: TREE_DEFAULT_SIZE, collapsed: false };

const px = (size: string): number => parseInt(size, 10);

/** A width in whole pixels within the tree's bounds; anything unreadable is the default. */
export const clampTreeWidth = (width: unknown): string => {
    const value = typeof width === 'number' ? width : typeof width === 'string' ? parseFloat(width) : NaN;
    if (!Number.isFinite(value)) return TREE_DEFAULT_SIZE;
    const clamped = Math.min(px(TREE_MAX_SIZE), Math.max(px(TREE_MIN_SIZE), Math.round(value)));
    return `${clamped}px`;
};

/**
 * What came back from user settings, made safe to draw: the store is a ConfigMap the
 * user can edit, and an older or newer plugin may have written something else.
 */
export const sanitizeTreePreferences = (stored: unknown): TreePreferences => {
    if (!stored || typeof stored !== 'object') return DEFAULT_TREE_PREFERENCES;
    const value = stored as Partial<Record<keyof TreePreferences, unknown>>;
    return {
        width: value.width === undefined ? TREE_DEFAULT_SIZE : clampTreeWidth(value.width),
        collapsed: value.collapsed === true,
    };
};

/** The preferences, a setter that merges, and whether they have loaded. */
export type TreePreferencesState = [TreePreferences, (update: Partial<TreePreferences>) => void, boolean];

/**
 * The same contract held in component state: what jest uses in place of the console's
 * user settings (jest.setup.js), since the SDK does not load under jest.
 */
export const useMemoryTreePreferences = (): TreePreferencesState => {
    const [preferences, setPreferences] = React.useState<TreePreferences>(DEFAULT_TREE_PREFERENCES);
    const update = React.useCallback(
        (change: Partial<TreePreferences>) => setPreferences((current) => ({ ...current, ...change })),
        [],
    );
    return [preferences, update, true];
};

// --- Open groups, per browser tab -------------------------------------------------------

/**
 * The open groups remembered for this tab, or `fallback`. Storage can be absent or
 * refused (a private window, blocked site data); the tree works without it.
 */
export const readOpenGroups = (fallback: readonly string[]): Set<string> => {
    try {
        const raw = window.sessionStorage.getItem(OPEN_GROUPS_STORAGE_KEY);
        if (raw !== null) {
            const parsed: unknown = JSON.parse(raw);
            if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === 'string'));
        }
    } catch {
        // Unreadable or refused: start from the default.
    }
    return new Set(fallback);
};

export const writeOpenGroups = (groups: ReadonlySet<string>): void => {
    try {
        window.sessionStorage.setItem(OPEN_GROUPS_STORAGE_KEY, JSON.stringify([...groups].sort()));
    } catch {
        // Storage refused: the tree keeps its groups for this mount either way.
    }
};
