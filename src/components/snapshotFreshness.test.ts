import { freshnessFromAge, oldestSnapshotAgeMs, parseSnapshotAgeMs } from './snapshotFreshness';

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

    it('takes the oldest zone age across snapshots', () => {
        const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
        const oldest = oldestSnapshotAgeMs([at(5000), at(90000), at(1000)]);
        expect(oldest).not.toBeNull();
        expect(oldest ?? 0).toBeGreaterThanOrEqual(90000);
        expect(oldest ?? 0).toBeLessThan(95000);
    });

    it('ignores missing or unparseable timestamps and reports unknown when none remain', () => {
        const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
        expect(oldestSnapshotAgeMs([undefined, 'garbage', at(3000)] as (string | undefined)[])).toBeGreaterThanOrEqual(3000);
        expect(oldestSnapshotAgeMs([])).toBeNull();
        expect(oldestSnapshotAgeMs([undefined, 'garbage'])).toBeNull();
    });
});
