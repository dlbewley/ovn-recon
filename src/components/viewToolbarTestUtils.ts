import { act } from 'react';

/**
 * Test helpers for `ViewToolbar` (ovn-recon-nt4.3). The display toggles sit in the
 * "View options" menu, which PatternFly renders into `document.body` rather than the
 * test's container, so an option is found by its id in the document once the menu
 * is open.
 */

/** A toolbar button by its accessible name: "Zoom in", "Zoom out", "Reset view", "Refresh now", "More actions". */
export const toolbarButton = (root: ParentNode, label: string): HTMLButtonElement | null =>
    root.querySelector<HTMLButtonElement>(`[data-testid="view-toolbar"] button[aria-label="${label}"]`);

const optionsToggle = (root: ParentNode): HTMLButtonElement | null =>
    root.querySelector<HTMLButtonElement>('[data-testid="view-options-toggle"]');

const isOpen = (root: ParentNode): boolean => optionsToggle(root)?.getAttribute('aria-expanded') === 'true';

/** The option's checkbox, opening the menu if it is closed; null when the view offers no such option. */
export const viewOptionInput = (root: ParentNode, id: string): HTMLInputElement | null => {
    const toggle = optionsToggle(root);
    if (!toggle) return null;
    if (!isOpen(root)) act(() => toggle.click());
    const option = document.getElementById(id);
    return option?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;
};

/** Whether the view offers the option at all; leaves the menu closed. */
export const hasViewOption = (root: ParentNode, id: string): boolean => {
    const found = viewOptionInput(root, id) !== null;
    closeViewOptions(root);
    return found;
};

/** Flips a view option, as a click in the menu does, and closes the menu. */
export const toggleViewOption = (root: ParentNode, id: string): void => {
    const input = viewOptionInput(root, id);
    if (!input) throw new Error(`No view option #${id}`);
    act(() => (document.getElementById(id) as HTMLElement).click());
    closeViewOptions(root);
};

export const closeViewOptions = (root: ParentNode): void => {
    const toggle = optionsToggle(root);
    if (toggle && isOpen(root)) act(() => toggle.click());
};
