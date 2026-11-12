import type { LogicalTopologyWarning } from '../../types';
import { loadSnapshot, logicalContext } from '../testing';
import { collectorDegraded } from './collectorDegraded';

const PROBE: LogicalTopologyWarning = {
    code: 'LIVE_PROBE_FAILED',
    message: 'Live probe collection failed for node cnv-1: pod exec timed out'
};
const STALE: LogicalTopologyWarning = {
    code: 'SNAPSHOT_STALE',
    message: 'Serving cached snapshot generated at 2026-08-29T15:30:40Z; refresh failed'
};
const WARMING: LogicalTopologyWarning = {
    code: 'COLLECTOR_WARMING',
    message: 'The collector is warming its snapshot cache after start-up'
};

const withWarnings = (...warnings: LogicalTopologyWarning[]) => {
    const snapshot = loadSnapshot('cnv-1');
    snapshot.warnings = warnings;
    return logicalContext(snapshot);
};

describe('collector-degraded', () => {
    it('fires when the probe failed and the view is a fallback, citing the warning', () => {
        const findings = collectorDegraded.evaluate(withWarnings(PROBE));

        expect(findings).toHaveLength(1);
        expect(findings[0]).toEqual(expect.objectContaining({
            ruleId: 'collector-degraded',
            subject: { kind: 'k8s', ref: expect.objectContaining({ kind: 'Node', name: 'cnv-1' }) },
            summary: 'The collector could not read OVN on cnv-1; this view shows a fallback snapshot from its own files, not this node\'s database.'
        }));
        expect(findings[0].evidence.map((evidence) => evidence.fact)).toEqual([`LIVE_PROBE_FAILED: ${PROBE.message}`]);
    });

    it('says when the view is the last snapshot collected', () => {
        const [finding] = collectorDegraded.evaluate(withWarnings(PROBE, STALE));
        expect(finding.summary).toBe(
            'The collector could not read OVN on cnv-1; this view shows the last snapshot it collected, from 2026-08-29T15:30:40.909587Z.'
        );
        expect(finding.evidence).toHaveLength(2);
    });

    it('stays quiet on a healthy snapshot', () => {
        expect(collectorDegraded.evaluate(logicalContext(loadSnapshot('cnv-1')))).toEqual([]);
    });

    it('stays quiet while the collector reports it is warming', () => {
        expect(collectorDegraded.evaluate(withWarnings(PROBE, STALE, WARMING))).toEqual([]);
    });
});
