import * as React from 'react';
import { Card, CardBody, CardTitle, ExpandableSection } from '@patternfly/react-core';

import { groupFindingsByRule } from '../../components/overviewModel';
import { getRule } from '../registry';
import { countBySeverity } from '../selectors';
import type { Finding } from '../types';
import { FindingSubjectAnchor, HideInfoSwitch, SeverityCountsInline, SeverityIcon } from './FindingsViews';

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

/**
 * The overview's findings card (ovn-recon-7i6.1): warning and info counts, opening a
 * list grouped by rule whose entries link to their subject with ?select=, so the node
 * page opens with the object selected and its drawer showing the finding.
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
                    <div data-testid="findings-counts">
                        <SeverityCountsInline counts={counts} />
                        <span style={{ ...subtle, marginLeft: '0.75em' }}>
                            {counts.warning} warning{counts.warning === 1 ? '' : 's'}, {counts.info} info
                        </span>
                    </div>
                )}
                <div style={{ marginTop: 'var(--pf-t--global--spacer--sm)' }}>
                    <HideInfoSwitch
                        id="overview-hide-info-findings"
                        findings={allFindings}
                        hideInfo={hideInfo}
                        onChange={onHideInfoChange}
                    />
                </div>
                {loaded && groups.length > 0 && (
                    <ExpandableSection
                        toggleText={expanded ? 'Hide findings' : 'Show findings'}
                        isExpanded={expanded}
                        onToggle={(_event, isExpanded) => setExpanded(isExpanded)}
                        style={{ marginTop: 'var(--pf-t--global--spacer--sm)' }}
                    >
                        {groups.map((group) => (
                            <section key={group.ruleId} data-testid={`findings-group-${group.ruleId}`} aria-label={group.title}>
                                <div style={{ fontWeight: 'bold', marginTop: 'var(--pf-t--global--spacer--sm)' }}>
                                    <SeverityIcon severity={group.severity} /> {group.title}{' '}
                                    <span style={{ ...subtle, fontWeight: 'normal' }}>({group.entries.length})</span>
                                </div>
                                <ul style={{ listStyle: 'none', margin: '0.25em 0 0 1.25em', padding: 0 }}>
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
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        ))}
                    </ExpandableSection>
                )}
            </CardBody>
        </Card>
    );
};

export default FindingsCard;
