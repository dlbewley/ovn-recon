import * as React from 'react';
import { Button, Card, CardBody, CardTitle } from '@patternfly/react-core';

import { groupFindingsByRule } from '../../components/overviewModel';
import { getRule } from '../registry';
import { countBySeverity } from '../selectors';
import type { Finding } from '../types';
import { FindingGroupList, SeverityCountsRow } from './FindingsPanel';
import { HideInfoSwitch } from './FindingsViews';

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
                {loaded && <SeverityCountsRow findings={findings} />}
                {loaded && groups.length > 0 && <FindingGroupList id={listId} groups={groups} expanded={expanded} />}
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
