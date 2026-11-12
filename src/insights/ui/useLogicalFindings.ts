import * as React from 'react';

import type { LogicalDatabase, LogicalTopologySnapshot, Pod } from '../../types';
import { compareFindings, evaluateLogical, LogicalEvaluator } from '../evaluate';
import { isZoneFinding } from '../logical';
import { findingsForConstruct } from '../selectors';
import type { Finding, LogicalClusterInputs, LogicalContext } from '../types';

/**
 * The hooks between the logical rules and the logical surfaces (ovn-recon-7i6.3):
 * the ladder's badges, the drawer's Findings section, the construct detail page and
 * the zone findings above a node's ladder.
 *
 * Evaluation runs in a useMemo keyed on the snapshot the page already holds and the
 * inputs from useLogicalInputs.ts, never in ladder layout. The evaluator memoises by
 * identity on top. No console SDK import here, so the drawer's suites need no SDK mock.
 */

/** The evaluator the logical surfaces use; a test provides one with its own rules. */
export const LogicalFindingsEvaluatorContext = React.createContext<LogicalEvaluator>(evaluateLogical);

export interface LogicalFindingsInput {
    nodeName: string;
    snapshot: LogicalTopologySnapshot | null | undefined;
    pods?: Pod[];
    cluster?: LogicalClusterInputs;
}

/**
 * Every logical finding for one zone. Empty without a snapshot. The caller passes a
 * snapshot fetched for `nodeName` only; its own metadata.nodeName is not compared,
 * since a fallback snapshot from the collector's files may name another node.
 */
export const useLogicalFindings = ({ nodeName, snapshot, pods, cluster }: LogicalFindingsInput): Finding[] => {
    const evaluate = React.useContext(LogicalFindingsEvaluatorContext);
    return React.useMemo(() => {
        if (!snapshot || !nodeName) return [];
        const ctx: LogicalContext = { domain: 'logical', nodeName, snapshot, pods, cluster, now: Date.now() };
        return evaluate(ctx);
    }, [evaluate, nodeName, snapshot, pods, cluster]);
};

/**
 * The section rules' findings over a database that carries a section the page's
 * snapshot does not (the drawer and the detail page load them on their own).
 */
export const useSectionFindings = (database: LogicalDatabase | undefined, nodeName: string | undefined): Finding[] => {
    const evaluate = React.useContext(LogicalFindingsEvaluatorContext);
    return React.useMemo(
        () => (database && nodeName ? evaluate.sections(database, nodeName) : []),
        [evaluate, database, nodeName]
    );
};

/** Findings on one construct of one zone, merged from several lists, each once. */
export const constructFindings = (
    lists: Finding[][],
    construct: { kind: string; name: string },
    nodeName: string | undefined
): Finding[] => {
    const byKey = new Map<string, Finding>();
    lists.forEach((findings) => findingsForConstruct(findings, construct.kind, construct.name, nodeName)
        .forEach((finding) => {
            if (!byKey.has(finding.key)) byKey.set(finding.key, finding);
        }));
    return Array.from(byKey.values()).sort(compareFindings);
};

/** The findings a logical page lists above its ladder: those on no one construct. */
export const zoneFindings = (findings: Finding[]): Finding[] =>
    findings.filter((finding) => isZoneFinding(finding.subject));
