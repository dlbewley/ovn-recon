/** The findings engine (ovn-recon-7i6.4). Pure: no React, no hooks, no fetches. */
export * from './types';
export { ALL_RULES, LOGICAL_RULES, PHYSICAL_RULES, getRule } from './registry';
export { compareFindings, createPhysicalEvaluator, evaluatePhysical } from './evaluate';
export type { PhysicalEvaluator, PhysicalEvaluatorOptions } from './evaluate';
export {
    countBySeverity,
    findingsForConstruct,
    findingsForGraphNode,
    findingsForNetwork,
    findingsForNode,
    findingsForSubject,
    highestSeverity
} from './selectors';
export type { SeverityCounts } from './selectors';
export { findingKey, graphNodeIdForRef, refKey, subjectKey } from './refs';
