import * as React from 'react';
import { Flex, FlexItem, Label, Spinner } from '@patternfly/react-core';

import { NBGlobalRow } from '../types';
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
    /** Prefixed to the age, e.g. "oldest node " → "Fresh · oldest node 45s ago". */
    ageQualifier?: string;
    /** Cluster view: number of node databases assembled. */
    zoneCount?: number;
    /** Degraded/unknown source health shows a label; healthy shows nothing. */
    sourceHealth?: string;
    /**
     * Zone identity from NB_Global: the OVN version northd reports and, for
     * a single zone, its name. Absent on snapshots from collectors older
     * than the field. The cluster view passes the summary across zones.
     */
    ovn?: OvnZoneSummary;
    isLoading?: boolean;
}

export interface OvnZoneSummary {
    /** Distinct northd_internal_version values seen (one on a healthy cluster). */
    versions: string[];
    /** Zone name, when the summary covers one zone. */
    zoneName?: string;
    /** Zones whose chassis lag the NB configuration (hv_cfg < nb_cfg). */
    laggingZones: string[];
}

/**
 * northd_internal_version reads like "26.03.4-57.el9fdp-21.8.0-82.14": the
 * OVN release, then the package build and the northd internal version.
 * The release is what a user compares against release notes.
 */
export const ovnReleaseOf = (northdInternalVersion: string): string =>
    northdInternalVersion.split('-')[0] || northdInternalVersion;

/** Summarize the NB_Global rows of the zones a view is showing. */
export const summarizeOvnZones = (rows: Array<NBGlobalRow | undefined>): OvnZoneSummary | undefined => {
    const present = rows.filter((row): row is NBGlobalRow => row != null);
    if (present.length === 0) return undefined;
    const versions = [...new Set(present.map((row) => row.options?.northd_internal_version).filter(Boolean))] as string[];
    const laggingZones = present
        .filter((row) => row.hvCfg < row.nbCfg)
        .map((row) => row.name || row.options?.name || '')
        .filter(Boolean);
    return {
        versions,
        zoneName: present.length === 1 ? present[0].name || present[0].options?.name : undefined,
        laggingZones,
    };
};

const ovnLabelText = (ovn: OvnZoneSummary): string => {
    const releases = [...new Set(ovn.versions.map(ovnReleaseOf))];
    const version = releases.length === 0 ? 'OVN' : releases.length === 1 ? `OVN ${releases[0]}` : `OVN ${releases.join(' / ')}`;
    return ovn.zoneName ? `${version} · zone ${ovn.zoneName}` : version;
};

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

const freshnessText = (state: SnapshotFreshnessState, ageMs: number | null, ageQualifier = ''): string => {
    const age = ageMs != null ? ` · ${ageQualifier}${formatAge(ageMs)}` : '';
    if (state === 'critical') return `Stale${age}`;
    if (state === 'warning') return `Aging${age}`;
    if (state === 'unknown') return 'Freshness unknown';
    return `Fresh${age}`;
};

const SnapshotStatusLine: React.FC<SnapshotStatusLineProps> = ({
    freshness,
    ageMs,
    ageQualifier,
    zoneCount,
    sourceHealth,
    ovn,
    isLoading,
}) => (
    <Flex spaceItems={{ default: 'spaceItemsSm' }} alignItems={{ default: 'alignItemsCenter' }}>
        <FlexItem>
            <Label isCompact color={freshnessColor(freshness)}>
                {freshnessText(freshness, ageMs, ageQualifier)}
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
        {ovn && (
            <FlexItem>
                <Label isCompact color="grey" title={ovn.versions.join(', ')}>
                    {ovnLabelText(ovn)}
                </Label>
            </FlexItem>
        )}
        {ovn && ovn.versions.length > 1 && (
            <FlexItem>
                <Label isCompact color="yellow" title={ovn.versions.join(', ')}>
                    Mixed OVN versions
                </Label>
            </FlexItem>
        )}
        {ovn && ovn.laggingZones.length > 0 && (
            <FlexItem>
                <Label
                    isCompact
                    color="yellow"
                    title={`Chassis have not applied the latest NB configuration (hv_cfg behind nb_cfg): ${ovn.laggingZones.join(', ')}`}
                >
                    {ovn.laggingZones.length === 1 && ovn.zoneName
                        ? 'Chassis behind NB config'
                        : `Chassis behind NB config on ${ovn.laggingZones.length} node${ovn.laggingZones.length === 1 ? '' : 's'}`}
                </Label>
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
