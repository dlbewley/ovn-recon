import * as React from 'react';
import { useUserSettings } from '@openshift-console/dynamic-plugin-sdk';

import {
    DEFAULT_TREE_PREFERENCES,
    sanitizeTreePreferences,
    TREE_SETTINGS_KEY,
    TreePreferences,
    TreePreferencesState,
} from './treePreferencesModel';

/**
 * The explorer tree's width and collapsed state, kept per user in the console's user
 * settings (ovn-recon-gbr.9): the `user-settings-<uid>` ConfigMap in
 * `openshift-console-user-settings`, or the browser's localStorage where the user
 * cannot write that ConfigMap. Either way it survives a reload and a new browser
 * session.
 *
 * `useUserSettings` is the SDK's older name for `useUserPreference`; it is the one
 * every console from 4.20 on exports, so the plugin does not depend on the rename.
 * Jest replaces this module with `useMemoryTreePreferences` (jest.setup.js).
 */
export const useTreePreferences = (): TreePreferencesState => {
    const [stored, setStored, loaded] = useUserSettings<TreePreferences>(
        TREE_SETTINGS_KEY,
        DEFAULT_TREE_PREFERENCES,
    );
    const preferences = React.useMemo(() => sanitizeTreePreferences(stored), [stored]);
    const update = React.useCallback(
        (change: Partial<TreePreferences>) =>
            setStored((current) => ({ ...sanitizeTreePreferences(current), ...change })),
        [setStored],
    );
    return [preferences, update, loaded];
};
