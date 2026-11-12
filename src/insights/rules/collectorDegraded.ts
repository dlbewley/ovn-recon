import { snapshotFact, zoneSubject } from '../logical';
import { makeFinding, nodeRef } from '../refs';
import type { LogicalRule } from '../types';

export const LIVE_PROBE_FAILED = 'LIVE_PROBE_FAILED';
export const SNAPSHOT_STALE = 'SNAPSHOT_STALE';
/**
 * Set by the collector on every zone snapshot it serves while its start-up cache
 * sweep runs (collector/internal/server/server.go). An upgrade restarts the
 * collector and ovnkube-node together, so a failed probe then is expected.
 */
export const COLLECTOR_WARMING = 'COLLECTOR_WARMING';

const DEGRADED_CODES = [LIVE_PROBE_FAILED, SNAPSHOT_STALE];

/**
 * collector-degraded: the node's snapshot carries LIVE_PROBE_FAILED or
 * SNAPSHOT_STALE, so the view is not this node's current database. Quiet while the
 * same snapshot carries COLLECTOR_WARMING. One finding per zone.
 */
export const collectorDegraded: LogicalRule = {
    id: 'collector-degraded',
    severity: 'warning',
    scope: 'node',
    domain: 'logical',
    title: 'Collector could not read OVN',
    evaluate: ({ nodeName, snapshot }) => {
        const warnings = snapshot.warnings ?? [];
        if (warnings.some((warning) => warning.code === COLLECTOR_WARMING)) return [];
        const degraded = warnings.filter((warning) => DEGRADED_CODES.includes(warning.code));
        if (degraded.length === 0) return [];
        const stale = degraded.some((warning) => warning.code === SNAPSHOT_STALE);
        const generatedAt = snapshot.metadata?.generatedAt;
        const showing = stale
            ? `the last snapshot it collected${generatedAt ? `, from ${generatedAt}` : ''}`
            : 'a fallback snapshot from its own files, not this node\'s database';
        return [makeFinding({
            ruleId: collectorDegraded.id,
            severity: collectorDegraded.severity,
            subject: zoneSubject(nodeName),
            scope: { node: nodeName },
            summary: `The collector could not read OVN on ${nodeName}; this view shows ${showing}.`,
            evidence: degraded.map((warning) => ({
                ...snapshotFact(nodeName, `${warning.code}: ${warning.message}`, 'warnings'),
                origin: `the collector's snapshot of node ${nodeName}`
            })),
            remedy: {
                text: `Check that the ovnkube-node pod on ${nodeName} is running and ready, then the ovn-collector `
                    + 'pod\'s log for the probe error.',
                target: nodeRef(nodeName),
                verb: 'view'
            }
        })];
    }
};
