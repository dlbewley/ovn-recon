import * as React from 'react';

/**
 * Whether the console is showing its dark theme, so embedded monaco editors
 * (which do not inherit CSS variables) can match it (ovn-recon-ehy).
 *
 * The console stamps `pf-v6-theme-dark` on the root element — including when
 * the user's setting is "system" — so the class is the authoritative signal;
 * prefers-color-scheme only breaks ties when neither theme class is present
 * (e.g. tests, or a future console that stops stamping for system theme).
 */
const isDarkNow = (): boolean => {
    const classes = document.documentElement.classList;
    // Both PF6 and the older PF5-era class names, so a console version drift
    // cannot silently flip the editors to the wrong theme.
    if (classes.contains('pf-v6-theme-dark') || classes.contains('pf-theme-dark')) return true;
    if (classes.contains('pf-v6-theme-light') || classes.contains('pf-theme-light')) return false;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
};

export const useIsDarkTheme = (): boolean => {
    const [dark, setDark] = React.useState<boolean>(isDarkNow);

    React.useEffect(() => {
        const update = () => setDark(isDarkNow());
        // Live theme switches: the console rewrites the root class list.
        const observer = new MutationObserver(update);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        const media = window.matchMedia?.('(prefers-color-scheme: dark)');
        media?.addEventListener?.('change', update);
        return () => {
            observer.disconnect();
            media?.removeEventListener?.('change', update);
        };
    }, []);

    return dark;
};
