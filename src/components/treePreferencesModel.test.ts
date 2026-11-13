import {
    clampTreeWidth,
    DEFAULT_TREE_PREFERENCES,
    OPEN_GROUPS_STORAGE_KEY,
    readOpenGroups,
    sanitizeTreePreferences,
    writeOpenGroups,
} from './treePreferencesModel';

describe('treePreferencesModel (ovn-recon-gbr.9)', () => {
    it('clamps widths to the tree bounds in whole pixels', () => {
        expect(clampTreeWidth(287.6)).toBe('288px');
        expect(clampTreeWidth('100px')).toBe('200px');
        expect(clampTreeWidth('9000px')).toBe('480px');
        expect(clampTreeWidth('wide')).toBe('240px');
        expect(clampTreeWidth(null)).toBe('240px');
    });

    it('makes whatever user settings held safe to draw', () => {
        expect(sanitizeTreePreferences(undefined)).toEqual(DEFAULT_TREE_PREFERENCES);
        expect(sanitizeTreePreferences('collapsed')).toEqual(DEFAULT_TREE_PREFERENCES);
        expect(sanitizeTreePreferences({ width: '300px', collapsed: true })).toEqual({ width: '300px', collapsed: true });
        expect(sanitizeTreePreferences({ width: 1000, collapsed: 'yes', extra: 1 })).toEqual({ width: '480px', collapsed: false });
        expect(sanitizeTreePreferences({ collapsed: true })).toEqual({ width: '240px', collapsed: true });
    });

    it('reads and writes the open groups, falling back when storage is empty, garbled or refused', () => {
        expect([...readOpenGroups(['nodes'])]).toEqual(['nodes']);
        writeOpenGroups(new Set(['networks', 'nodes']));
        expect(window.sessionStorage.getItem(OPEN_GROUPS_STORAGE_KEY)).toBe('["networks","nodes"]');
        expect([...readOpenGroups(['nodes'])].sort()).toEqual(['networks', 'nodes']);

        window.sessionStorage.setItem(OPEN_GROUPS_STORAGE_KEY, '{not json');
        expect([...readOpenGroups(['nodes'])]).toEqual(['nodes']);
        window.sessionStorage.setItem(OPEN_GROUPS_STORAGE_KEY, '[1,"networks"]');
        expect([...readOpenGroups(['nodes'])]).toEqual(['networks']);

        jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('refused'); });
        jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('refused'); });
        expect([...readOpenGroups(['nodes'])]).toEqual(['nodes']);
        expect(() => writeOpenGroups(new Set(['nodes']))).not.toThrow();
        jest.restoreAllMocks();
    });
});
