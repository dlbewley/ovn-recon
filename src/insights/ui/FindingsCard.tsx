import * as React from 'react';
import { Button, Card, CardBody, CardTitle } from '@patternfly/react-core';

import { groupFindingsByRule } from '../../components/overviewModel';
import { getRule } from '../registry';
import { countBySeverity } from '../selectors';
import type { Finding, Severity } from '../types';
import { FindingSubjectAnchor, HideInfoSwitch, SeverityIcon } from './FindingsViews';

const subtle: React.CSSProperties = { color: 'var(--pf-t--global--text--color--subtle)' };

interface FindingsCardProps {
    /** What to show: gated, and without info when hidden. */
    findings: Finding[];
    /** Every finding before the hide-info choice, so the toggle knows whether to appear. */
    allFindings: Finding[];
    hideInfo: boolean;
    onHideInfoChange: (hide: boolean) => void;
    /** Node names, to pick a node page on which a cluster-wide network can be selected. */
    nodeNames: string[];
    /** False while NodeNetworkStates are loading: the counts would be partial. */
    loaded: boolean;
    /** Set when NodeNetworkStates could not be read: nothing can be said about the nodes. */
    unavailable?: string;
}

const COUNT_LABEL: Record<Severity, [string, string]> = {
    warning: ['warning', 'warnings'],
    info: ['info', 'info'],
};

/** One severity's count, large enough to read from across the page. */
const SeverityCount: React.FC<{ severity: Severity; count: number }> = ({ severity, count }) => (
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

/**
 * The overview's findings summary (ovn-recon-7i6.1, laid out by ovn-recon-nt4.9):
 * warning and info counts, then the rules that fired with how often. "Show findings"
 * opens each rule's entries, which link to their subject with ?select=, so the page
 * opens with the object selected and its drawer showing the finding.
 */
const FindingsCard: React.FC<FindingsCardProps> = ({
    findings, allFindings, hideInfo, onHideInfoChange, nodeNames, loaded, unavailable
}) => {
    const [expanded, setExpanded] = React.useState(false);
    const counts = countBySeverity(findings);
    const groups = React.useMemo(
        () => groupFindingsByRule(findings, nodeNames, (ruleId) => getRule(ruleId)?.title),
        [findings, nodeNames]
    );
    const listId = 'overview-findings-list';

    return (
        <Card isFullHeight data-testid="overview-findings-card">
            <CardTitle>Findings</CardTitle>
            <CardBody>
                {!loaded && <span style={subtle}>Loading...</span>}
                {loaded && unavailable && counts.total === 0 && (
                    <span style={subtle} data-testid="findings-unavailable">{unavailable}</span>
                )}
                {loaded && !unavailable && counts.total === 0 && (
                    <span style={subtle} data-testid="findings-none">No findings.</span>
                )}
                {loaded && counts.total > 0 && (
                    <div
                        data-testid="findings-counts"
                        style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--pf-t--global--spacer--lg)' }}
                    >
                        {counts.warning > 0 && <SeverityCount severity="warning" count={counts.warning} />}
                        {counts.info > 0 && <SeverityCount severity="info" count={counts.info} />}
                    </div>
                )}
                {loaded && groups.length > 0 && (
                    <div id={listId} style={{ marginTop: 'var(--pf-t--global--spacer--md)' }}>
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
                                                <span style={{ ...subtle, fontSize: '0.85em' }}> {where}</span>
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
                )}
                <div
                    style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        gap: 'var(--pf-t--global--spacer--md)',
                        marginTop: 'var(--pf-t--global--spacer--md)',
                    }}
                >
                    {loaded && groups.length > 0 && (
                        <Button
                            variant="link"
                            isInline
                            aria-expanded={expanded}
                            aria-controls={listId}
                            onClick={() => setExpanded(!expanded)}
                        >
                            {expanded ? 'Hide findings' : 'Show findings'}
                        </Button>
                    )}
                    <HideInfoSwitch
                        id="overview-hide-info-findings"
                        findings={allFindings}
                        hideInfo={hideInfo}
                        onChange={onHideInfoChange}
                    />
                </div>
            </CardBody>
        </Card>
    );
};

export default FindingsCard;
