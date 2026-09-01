export type SnapshotFreshnessState = 'fresh' | 'warning' | 'critical' | 'unknown';

const STALE_WARNING_MS = 2 * 60 * 1000;
const STALE_CRITICAL_MS = 10 * 60 * 1000;

export const parseSnapshotAgeMs = (generatedAt: string): number | null => {
    const generated = new Date(generatedAt).getTime();
    if (Number.isNaN(generated)) return null;
    return Math.max(0, Date.now() - generated);
};

/**
 * Oldest (max) age across zone snapshots. The cluster view is only as fresh
 * as its stalest zone, and each zone snapshot's own generatedAt is the real
 * signal — the aggregate envelope is stamped at assembly time on every
 * request, so its age is always ~0 and meaningless.
 */
export const oldestSnapshotAgeMs = (generatedAts: (string | undefined)[]): number | null => {
    let oldest: number | null = null;
    for (const generatedAt of generatedAts) {
        if (!generatedAt) continue;
        const age = parseSnapshotAgeMs(generatedAt);
        if (age == null) continue;
        if (oldest == null || age > oldest) oldest = age;
    }
    return oldest;
};

export const freshnessFromAge = (ageMs: number | null): SnapshotFreshnessState => {
    if (ageMs == null) return 'unknown';
    if (ageMs >= STALE_CRITICAL_MS) return 'critical';
    if (ageMs >= STALE_WARNING_MS) return 'warning';
    return 'fresh';
};
