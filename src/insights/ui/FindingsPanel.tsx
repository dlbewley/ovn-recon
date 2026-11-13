import * as React from 'react';

import type { FindingGroup } from '../../components/overviewModel';
import { groupFindingsByRule } from '../../components/overviewModel';
import { getRule } from '../registry';
import { countBySeverity } from '../selectors';
import type { Finding, Severity } from '../types';
import { FindingSubjectAnchor, HideInfoSwitch, SeverityIcon } from './FindingsViews';

/**
 * Findings as a list grouped by rule, each entry linked to its subject with ?select=
 * so the page opens with the object selected and its drawer showing the finding.
 *
 * `FindingsPanel` is the explorer's Findings tab (ovn-recon-gbr.7), at cluster or
 * node scope: counts, every group open, and the hide-info switch.
 */

const subtle: React.CSSProperties = { color: 'var(--pf-t--global--text--color--subtle)' };

const COUNT_LABEL: Record<Severity, [string, string]> = {
    warning: ['warning', 'warnings'],
    info: ['info', 'info'],
};

/** One severity's count, large enough to read from across the page. */
export const SeverityCount: React.FC<{ severity: Severity; count: number }> = ({ severity, count }) => (
    <span
        data-testid={`count-${severity}`}
        style={{ display: 'inline-flex', alignItems: 'baseline', gap: '0.35em', ...(severity === 'info' ? subtle : {}) }}
    >
        <SeverityIcon severity={severity} size="md" />
        <span style={{ fontSize: 'var(--pf-t--global--font--size--2xl)', fontWeight: 'var(--pf-t--global--font--weight--heading--default)', lineHeight: 1 }}>
            {count}
        </span>
        {/* A real space: the gap is only visual, and "4warnings" is what would be read out. */}
        {' '}
        <span>{COUNT_LABEL[severity][count === 1 ? 0 : 1]}</span>
    </span>
);

/** Warning and info counts side by side; nothing for none. */
export const SeverityCountsRow: React.FC<{ findings: Finding[] }> = ({ findings }) => {
    const counts = countBySeverity(findings);
    if (counts.total === 0) return null;
    return (
        <div data-testid="findings-counts" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--pf-t--global--spacer--lg)' }}>
            {counts.warning > 0 && <SeverityCount severity="warning" count={counts.warning} />}
            {counts.info > 0 && <SeverityCount severity="info" count={counts.info} />}
        </div>
    );
};

/** The groups, warnings' rules first; each opens to its entries when `expanded`. */
export const FindingGroupList: React.FC<{
    id?: string;
    groups: FindingGroup[];
    expanded: boolean;
    /** Leave out "on worker-1": the list is one node's. */
    hideWhere?: boolean;
}> = ({ id, groups, expanded, hideWhere }) => (
    <div id={id} style={{ marginTop: 'var(--pf-t--global--spacer--md)' }}>
        {groups.map((group) => (
            <section
                key={group.ruleId}
                data-testid={`findings-group-${group.ruleId}`}
                aria-label={group.title}
                style={{ marginTop: 'var(--pf-t--global--spacer--sm)' }}
            >
                <div style={{ display: 'flex', gap: '0.5em', alignItems: 'baseline' }}>
                    <SeverityIcon severity={group.severity} />
                    <span style={{ flex: '1 1 auto', fontWeight: expanded ? 'bold' : undefined }}>{group.title}</span>
                    <span style={subtle} data-testid="findings-group-count">{group.entries.length}</span>
                </div>
                {expanded && (
                    <ul style={{ listStyle: 'none', margin: '0.25em 0 0 1.5em', padding: 0 }}>
                        {group.entries.map(({ finding, link, where }) => (
                            <li
                                key={finding.key}
                                data-testid="findings-entry"
                                style={finding.severity === 'info' ? subtle : undefined}
                            >
                                <FindingSubjectAnchor to={link.to} href={link.href}>
                                    {finding.summary}
                                </FindingSubjectAnchor>
                                {!hideWhere && <span style={{ ...subtle, fontSize: '0.85em' }}> {where}</span>}
                                {link.secondary && (
                                    <span style={{ fontSize: '0.85em' }} data-testid="findings-entry-secondary">
                                        {' · '}
                                        <FindingSubjectAnchor to={link.secondary.to}>
                                            {link.secondary.label}
                                        </FindingSubjectAnchor>
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        ))}
    </div>
);

export interface FindingsPanelProps {
    /** What to show: in scope, and without info when hidden. */
    findings: Finding[];
    /** The same scope before the hide-info choice, so the switch knows whether to appear. */
    allFindings: Finding[];
    hideInfo: boolean;
    onHideInfoChange: (hide: boolean) => void;
    /** Node names, to pick a node page on which a cluster-wide network can be selected. */
    nodeNames: string[];
    /** False while NodeNetworkStates are loading: the counts would be partial. */
    loaded: boolean;
    /** Set when NodeNetworkStates could not be read: what that leaves unknown. */
    unavailable?: string;
    /** What an empty list says. */
    emptyText?: string;
    /** The list is one node's: entries leave out "on <node>". */
    node?: string;
    /** Prefix for the switch's id, unique on the page. */
    idPrefix: string;
}

export const FindingsPanel: React.FC<FindingsPanelProps> = ({
    findings, allFindings, hideInfo, onHideInfoChange, nodeNames, loaded, unavailable, emptyText = 'No findings.', node, idPrefix,
}) => {
    const groups = React.useMemo(
        () => groupFindingsByRule(findings, nodeNames, (ruleId) => getRule(ruleId)?.title),
        [findings, nodeNames],
    );
    return (
        <div data-testid="findings-panel">
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--pf-t--global--spacer--md)' }}>
                {!loaded && <span style={subtle}>Loading...</span>}
                {loaded && unavailable && (
                    <span style={subtle} data-testid="findings-unavailable">{unavailable}</span>
                )}
                {loaded && !unavailable && findings.length === 0 && (
                    <span style={subtle} data-testid="findings-none">{emptyText}</span>
                )}
                {loaded && <SeverityCountsRow findings={findings} />}
                <span style={{ marginInlineStart: 'auto' }}>
                    <HideInfoSwitch
                        id={`${idPrefix}-hide-info-findings`}
                        findings={allFindings}
                        hideInfo={hideInfo}
                        onChange={onHideInfoChange}
                    />
                </span>
            </div>
            {loaded && groups.length > 0 && <FindingGroupList groups={groups} expanded hideWhere={node !== undefined} />}
        </div>
    );
};

export default FindingsPanel;
