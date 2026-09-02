import { renderHook } from './testHookHarness';
import { useIsDarkTheme } from './useIsDarkTheme';

describe('useIsDarkTheme', () => {
    afterEach(() => {
        document.documentElement.classList.remove('pf-v6-theme-dark', 'pf-v6-theme-light');
    });

    it('reads dark from the console theme class', () => {
        document.documentElement.classList.add('pf-v6-theme-dark');
        expect(renderHook(() => useIsDarkTheme())).toBe(true);
    });

    it('reads light from the console theme class even if the OS prefers dark', () => {
        document.documentElement.classList.add('pf-v6-theme-light');
        expect(renderHook(() => useIsDarkTheme())).toBe(false);
    });

    it('defaults to light when nothing signals a theme (jsdom)', () => {
        expect(renderHook(() => useIsDarkTheme())).toBe(false);
    });
});
