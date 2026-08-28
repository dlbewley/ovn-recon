import { freshnessFromAge, parseSnapshotAgeMs } from './snapshotFreshness';

describe('snapshotFreshness', () => {
    it('maps age to freshness states at the warning and critical thresholds', () => {
        expect(freshnessFromAge(null)).toBe('unknown');
        expect(freshnessFromAge(0)).toBe('fresh');
        expect(freshnessFromAge(2 * 60 * 1000 - 1)).toBe('fresh');
        expect(freshnessFromAge(2 * 60 * 1000)).toBe('warning');
        expect(freshnessFromAge(10 * 60 * 1000)).toBe('critical');
    });

    it('parses ages from ISO timestamps and rejects garbage', () => {
        expect(parseSnapshotAgeMs('not-a-date')).toBeNull();
        const age = parseSnapshotAgeMs(new Date(Date.now() - 5000).toISOString());
        expect(age).not.toBeNull();
        expect(age ?? 0).toBeGreaterThanOrEqual(5000);
    });
});
