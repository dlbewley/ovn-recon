import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';

import { BASE_PATH, overviewPath } from '../routes';
import { NETWORKS_GROUP_ID, NODES_GROUP_ID } from './explorerTreeModel';
import OvnReconApp, { TREE_PANEL_ID } from './OvnReconApp';
import {
    DEFAULT_TREE_PREFERENCES,
    OPEN_GROUPS_STORAGE_KEY,
    TreePreferences,
} from './treePreferencesModel';

/**
 * What the tree remembers (ovn-recon-gbr.9). The console's user settings are stood in
 * for by a store that outlives the component, so an unmount and mount again is a
 * reload; sessionStorage is jsdom's own. The shell's watches are empty: the tree's
 * groups and panel are all these tests look at.
 */

const mockStore: { value: TreePreferences; writes: TreePreferences[] } = {
    value: DEFAULT_TREE_PREFERENCES,
    writes: [],
};

jest.mock('./useTreePreferences', () => {
    const ReactActual = jest.requireActual('react');
    return {
        useTreePreferences: () => {
            const [value, setValue] = ReactActual.useState(mockStore.value);
            const update = ReactActual.useCallback((change: Partial<TreePreferences>) => {
                mockStore.value = { ...mockStore.value, ...change };
                mockStore.writes.push(mockStore.value);
                setValue(mockStore.value);
            }, []);
            return [value, update, true];
        },
    };
});

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    DocumentTitle: () => null,
    useK8sWatchResource: () => [[], true, undefined],
}));

jest.mock('./useOvnCollectorFeatureGate', () => ({
    useOvnCollectorFeatureGate: () => ({ enabled: false, loaded: true, loadError: null }),
}));

/** Widths jsdom cannot measure: the shell's container and the tree's panel. */
const sizes = { shell: 0, panel: 0 };
const box = (width: number): DOMRect => ({
    width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
});

describe('OvnReconApp, remembered tree state', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        mockStore.value = DEFAULT_TREE_PREFERENCES;
        mockStore.writes = [];
        sizes.shell = 0;
        sizes.panel = 0;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        global.fetch = jest.fn().mockRejectedValue(new Error('no collector')) as unknown as typeof fetch;
        const original = Element.prototype.getBoundingClientRect;
        jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
            if (this.id === TREE_PANEL_ID) return box(sizes.panel);
            if (this.querySelector(':scope > .pf-v6-c-drawer')) return box(sizes.shell);
            return original.call(this);
        });
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    const settle = async () => {
        for (let round = 0; round < 3; round += 1) {
            await act(async () => {
                await Promise.resolve();
            });
        }
    };

    const mount = async () => {
        await act(async () => {
            root.render(
                <MemoryRouter initialEntries={[overviewPath()]}>
                    <Routes>
                        <Route path={`${BASE_PATH}/*`} element={<OvnReconApp />} />
                    </Routes>
                </MemoryRouter>,
            );
        });
        await settle();
    };

    /** A reload, as far as the shell can tell: unmounted, then mounted afresh. */
    const reload = async () => {
        act(() => root.unmount());
        root = createRoot(container);
        await mount();
    };

    const byTestId = (id: string): HTMLElement | null =>
        container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    const click = async (element: Element | null) => {
        expect(element).not.toBeNull();
        await act(async () => {
            (element as HTMLElement).click();
        });
        await settle();
    };
    const groupExpanded = (id: string): string | null | undefined =>
        byTestId(`explorer-tree-${id}`)?.closest('[role="treeitem"]')?.getAttribute('aria-expanded');

    it('draws the stored width and collapse, and keeps a collapse across a reload', async () => {
        mockStore.value = { width: '320px', collapsed: false };
        await mount();
        expect(byTestId('explorer-tree-panel')?.getAttribute('style')).toContain('320px');

        await click(byTestId('explorer-tree-collapse'));
        expect(mockStore.value).toEqual({ width: '320px', collapsed: true });

        await reload();
        expect(byTestId('explorer-tree-panel')).toBeNull();
        expect(byTestId('explorer-rail')).not.toBeNull();

        await click(byTestId('explorer-tree-expand'));
        expect(mockStore.value.collapsed).toBe(false);
        await reload();
        expect(byTestId('explorer-tree-panel')?.getAttribute('style')).toContain('320px');
    });

    it('keeps the width the arrow keys gave the divider, once they rest', async () => {
        jest.useFakeTimers();
        await mount();
        const splitter = byTestId('explorer-tree-panel')!.querySelector<HTMLElement>('[role="separator"]')!;
        // PatternFly measures the panel on every press; jsdom lays nothing out, so the
        // stand-in width follows each 16 px step.
        for (let press = 0; press < 3; press += 1) {
            sizes.panel = 240 + press * 16;
            act(() => {
                splitter.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
                splitter.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
            });
        }
        expect(byTestId('explorer-tree-panel')?.getAttribute('style')).toContain('288px');
        // Nothing is written per press.
        expect(mockStore.writes).toEqual([]);

        sizes.panel = 288;
        act(() => {
            jest.advanceTimersByTime(500);
        });
        expect(mockStore.writes).toEqual([{ width: '288px', collapsed: false }]);
    });

    it('ignores keys that do not resize, and keys anywhere but the divider', async () => {
        jest.useFakeTimers();
        await mount();
        const panel = byTestId('explorer-tree-panel')!;
        sizes.panel = 300;
        act(() => {
            panel.querySelector('[role="separator"]')!.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', bubbles: true }));
            panel.querySelector('input')!.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
            jest.advanceTimersByTime(500);
        });
        expect(mockStore.writes).toEqual([]);
    });

    it('starts collapsed on a narrow shell without changing what is stored', async () => {
        sizes.shell = 900;
        await mount();
        expect(byTestId('explorer-rail')).not.toBeNull();
        expect(mockStore.writes).toEqual([]);

        // Expanding is the user's choice, and is kept.
        await click(byTestId('explorer-tree-expand'));
        expect(byTestId('explorer-tree-panel')).not.toBeNull();
        expect(mockStore.value.collapsed).toBe(false);
    });

    it('stays expanded on a wide shell', async () => {
        sizes.shell = 1100;
        await mount();
        expect(byTestId('explorer-tree-panel')).not.toBeNull();
    });

    it('keeps the open groups for the browser tab across a reload', async () => {
        await mount();
        expect(groupExpanded(NODES_GROUP_ID)).toBe('true');
        expect(groupExpanded(NETWORKS_GROUP_ID)).toBe('false');

        const toggle = (id: string) => byTestId(`explorer-tree-${id}`)!
            .closest('[role="treeitem"]')!.querySelector<HTMLElement>('.pf-v6-c-tree-view__node-toggle, .pf-v6-c-tree-view__node');
        await click(toggle(NETWORKS_GROUP_ID));
        await click(toggle(NODES_GROUP_ID));
        expect(JSON.parse(window.sessionStorage.getItem(OPEN_GROUPS_STORAGE_KEY)!)).toEqual([NETWORKS_GROUP_ID]);

        await reload();
        expect(groupExpanded(NODES_GROUP_ID)).toBe('false');
        expect(groupExpanded(NETWORKS_GROUP_ID)).toBe('true');
    });

    it('puts the tree before the scope in the document, so focus reaches it first', async () => {
        await mount();
        const order = (a: Element, b: Element) =>
            Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        const search = byTestId('explorer-search')!;
        const collapse = byTestId('explorer-tree-collapse')!;
        const splitter = byTestId('explorer-tree-panel')!.querySelector('[role="separator"]')!;
        const tree = byTestId('explorer-tree')!;
        const content = container.querySelector('.pf-v6-c-drawer__content')!;
        expect(order(search, collapse)).toBe(true);
        expect(order(collapse, splitter)).toBe(true);
        expect(order(splitter, tree)).toBe(true);
        expect(order(tree, content)).toBe(true);

        // Collapsed, the rail's expand button still comes before the scope.
        await click(collapse);
        expect(order(byTestId('explorer-tree-expand')!, container.querySelector('.pf-v6-c-drawer__content')!)).toBe(true);
    });

    it('labels the tree as a landmark and reads group counts as shown', async () => {
        await mount();
        const nav = container.querySelector('nav[aria-label="OVN Recon explorer"]');
        expect(nav?.getAttribute('data-testid')).toBe('explorer-tree');
        const badge = byTestId(`explorer-tree-${NODES_GROUP_ID}`)!
            .closest('[role="treeitem"]')!.querySelector('.pf-v6-c-tree-view__node-count .pf-v6-screen-reader');
        expect(badge?.textContent).toBe('shown');
    });
});
