import * as React from 'react';
import { EmptyState, EmptyStateBody, ExpandableSection, Spinner } from '@patternfly/react-core';

import { CollectorFailure } from './collectorApi';

/**
 * What the collector-backed views show while they wait and when a request fails
 * (ovn-recon-nt4.4): a spinner with what is being assembled in place of an empty
 * canvas, and a failure's routes tried behind "Details" rather than in its title.
 */

/** "Assembling 6 node snapshots…", or without a count while the Nodes are unknown. */
export const assemblingTitle = (nodeCount: number): string =>
    nodeCount > 0
        ? `Assembling ${nodeCount} node snapshot${nodeCount === 1 ? '' : 's'}…`
        : 'Assembling node snapshots…';

/** Drawn inside a ladder's canvas until the first payload arrives. */
export const CollectorLoadingState: React.FC<{ title: string; children?: React.ReactNode }> = ({
    title,
    children,
}) => (
    <EmptyState
        titleText={title}
        headingLevel="h4"
        icon={Spinner}
        variant="sm"
        data-testid="collector-loading"
    >
        {children && <EmptyStateBody>{children}</EmptyStateBody>}
    </EmptyState>
);

/** What was tried, behind "Details": one line per proxy route, or the error itself. */
export const CollectorFailureDetails: React.FC<{ failure: CollectorFailure }> = ({ failure }) => {
    const [expanded, setExpanded] = React.useState(false);
    return (
        <ExpandableSection
            toggleText="Details"
            isExpanded={expanded}
            onToggle={(_event, value) => setExpanded(value)}
            data-testid="collector-failure-details"
        >
            {failure.attempts.length > 0 ? (
                <ul style={{ overflowWrap: 'anywhere' }}>
                    {failure.attempts.map((attempt) => <li key={attempt}><code>{attempt}</code></li>)}
                </ul>
            ) : (
                <div style={{ overflowWrap: 'anywhere' }}>{failure.message}</div>
            )}
        </ExpandableSection>
    );
};
