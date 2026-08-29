import * as React from 'react';
import { Flex, FlexItem, Label, Spinner } from '@patternfly/react-core';

import { SnapshotFreshnessState } from './snapshotFreshness';

/**
 * One slim row of labels replacing the old stack of always-on alerts, so the
 * canvas gets the vertical room back. Problems (errors, collector warnings)
 * still render as real alerts next to this line — this row only carries the
 * healthy-path status a user glances at.
 */

export interface SnapshotStatusLineProps {
    freshness: SnapshotFreshnessState;
    ageMs: number | null;
    /** Cluster view: number of node databases assembled. */
    zoneCount?: number;
    /** Degraded/unknown source health shows a label; healthy shows nothing. */
    sourceHealth?: string;
    isLoading?: boolean;
}

export const formatAge = (ageMs: number): string => {
    if (ageMs < 1000) return 'just now';
    const minutes = Math.floor(ageMs / 60000);
    const seconds = Math.floor((ageMs % 60000) / 1000);
    if (minutes <= 0) return `${seconds}s ago`;
    return `${minutes}m ${seconds}s ago`;
};

const freshnessColor = (state: SnapshotFreshnessState): 'green' | 'yellow' | 'red' | 'grey' => {
    if (state === 'critical') return 'red';
    if (state === 'warning') return 'yellow';
    if (state === 'unknown') return 'grey';
    return 'green';
};

const freshnessText = (state: SnapshotFreshnessState, ageMs: number | null): string => {
    const age = ageMs != null ? ` · ${formatAge(ageMs)}` : '';
    if (state === 'critical') return `Stale${age}`;
    if (state === 'warning') return `Aging${age}`;
    if (state === 'unknown') return 'Freshness unknown';
    return `Fresh${age}`;
};

const SnapshotStatusLine: React.FC<SnapshotStatusLineProps> = ({
    freshness,
    ageMs,
    zoneCount,
    sourceHealth,
    isLoading,
}) => (
    <Flex spaceItems={{ default: 'spaceItemsSm' }} alignItems={{ default: 'alignItemsCenter' }}>
        <FlexItem>
            <Label isCompact color={freshnessColor(freshness)}>
                {freshnessText(freshness, ageMs)}
            </Label>
        </FlexItem>
        {zoneCount != null && (
            <FlexItem>
                <Label isCompact color="blue">Assembled from {zoneCount} node{zoneCount === 1 ? '' : 's'}</Label>
            </FlexItem>
        )}
        {sourceHealth && sourceHealth !== 'healthy' && (
            <FlexItem>
                <Label isCompact color="yellow">Source: {sourceHealth}</Label>
            </FlexItem>
        )}
        {isLoading && (
            <FlexItem>
                <Spinner size="sm" aria-label="Refreshing snapshot" />
            </FlexItem>
        )}
    </Flex>
);

export default SnapshotStatusLine;
