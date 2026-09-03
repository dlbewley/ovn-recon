/**
 * Route inside the console without a router handle.
 *
 * Plugin components render under the console's router but do not own it; pushing
 * history state and raising popstate is what makes its BrowserRouter re-read the
 * location, so useParams in the per-node pages picks up the new node. Shared by
 * the physical and logical per-node views so both navigate the same way.
 */
export const navigateToPath = (path: string): void => {
    window.history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
};
