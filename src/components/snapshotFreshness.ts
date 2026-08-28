export type SnapshotFreshnessState = 'fresh' | 'warning' | 'critical' | 'unknown';

const STALE_WARNING_MS = 2 * 60 * 1000;
const STALE_CRITICAL_MS = 10 * 60 * 1000;

export const parseSnapshotAgeMs = (generatedAt: string): number | null => {
    const generated = new Date(generatedAt).getTime();
    if (Number.isNaN(generated)) return null;
    return Math.max(0, Date.now() - generated);
};

export const freshnessFromAge = (ageMs: number | null): SnapshotFreshnessState => {
    if (ageMs == null) return 'unknown';
    if (ageMs >= STALE_CRITICAL_MS) return 'critical';
    if (ageMs >= STALE_WARNING_MS) return 'warning';
    return 'fresh';
};
