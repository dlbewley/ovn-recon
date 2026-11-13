import * as React from 'react';
import {
    Button,
    DescriptionList,
    DescriptionListDescription,
    DescriptionListGroup,
    DescriptionListTerm,
    Flex,
    FlexItem,
    Label,
    Popover,
} from '@patternfly/react-core';

import { ClusterLogicalTopology } from '../types';
import { fetchClusterTopology } from './collectorApi';
import { snapshotAges } from './overviewModel';
import { freshnessFromAge } from './snapshotFreshness';
import SnapshotStatusLine, { formatAge, ovnReleaseOf, summarizeOvnZones } from './SnapshotStatusLine';
import { useOvnCollectorFeatureGate } from './useOvnCollectorFeatureGate';

/**
 * The collector in one line (ovn-recon-nt4.9), and the hook that reads what the line
 * says. Lifted out of the overview (ovn-recon-gbr.3) so a host other than the
 * overview page can own the state and place the line.
 */

// Same cadence as the cluster view: the aggregate probes every zone, so it
// is not something to hammer from a page people leave open.
const COLLECTOR_REFRESH_MS = 60000;

const MAX_WARNINGS_SHOWN = 5;

const subtle: React.CSSProperties = { color: 'var(--pf-t--global--text--color--subtle)' };

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** What a page knows about the collector without asking it anything new. */
export interface CollectorState {
    /** `spec.collector.enabled` on the OvnRecon resource. */
    enabled: boolean;
    /** Whether `enabled` is known yet. */
    gateLoaded: boolean;
    /** The last aggregate the collector answered with. */
    topology: ClusterLogicalTopology | null;
    /** Why the last request failed; empty after one that worked. */
    error: string;
    loading: boolean;
}

export interface CollectorStatusProps {
    collector: CollectorState;
    /** Drawn first on the line, before the status: what the host calls the line. */
    label?: React.ReactNode;
    /** Drawn last, at the far end of the line: a host's own link or button. */
    action?: React.ReactNode;
}

const Detail: React.FC<{ term: string; children: React.ReactNode }> = ({ term, children }) => (
    <DescriptionListGroup>
        <DescriptionListTerm>{term}</DescriptionListTerm>
        <DescriptionListDescription>{children}</DescriptionListDescription>
    </DescriptionListGroup>
);

/**
 * Freshness, how many node databases the cluster view is assembled from, and anything
 * degraded, with the rest behind "Collector details". Only what the aggregate response
 * and the feature gate already say is shown here.
 */
const CollectorStatus: React.FC<CollectorStatusProps> = ({ collector, label, action }) => {
    const { enabled, gateLoaded, topology, error, loading } = collector;

    // Keep the age text moving between refetches.
    const [ageTick, setAgeTick] = React.useState(0);
    React.useEffect(() => {
        const timer = window.setInterval(() => setAgeTick((tick) => tick + 1), 30000);
        return () => window.clearInterval(timer);
    }, []);
    const ages = React.useMemo(
        () => snapshotAges((topology?.snapshots ?? []).map((snapshot) => snapshot.metadata?.generatedAt)),
        // ageTick is a deliberate extra dependency: it forces the ages to recompute.
        [topology, ageTick],
    );
    const ovn = React.useMemo(
        () => summarizeOvnZones((topology?.snapshots ?? []).map((snapshot) => snapshot.database?.nbGlobal)),
        [topology],
    );

    const active = gateLoaded && enabled;
    const unreachable = active && Boolean(error) && !topology;
    const warnings = topology?.warnings ?? [];
    const releases = [...new Set((ovn?.versions ?? []).map(ovnReleaseOf))];

    let details: React.ReactNode;
    if (!active) {
        details = (
            <p>
                The logical topology views and the OVN part of search need the collector. It is switched on
                with <code>spec.collector.enabled</code> on the OvnRecon resource.
            </p>
        );
    } else if (unreachable) {
        details = (
            <>
                <p>The collector did not answer: {error}</p>
                <p style={subtle}>Retried every {COLLECTOR_REFRESH_MS / 1000} seconds.</p>
            </>
        );
    } else if (!topology) {
        details = <p>Waiting for the collector&apos;s first answer.</p>;
    } else {
        details = (
            <DescriptionList isCompact isHorizontal horizontalTermWidthModifier={{ default: '16ch' }}>
                <Detail term="Source health">{topology.metadata.sourceHealth || 'unknown'}</Detail>
                <Detail term="Node databases">{topology.snapshots.length}</Detail>
                {ages.oldestMs != null && <Detail term="Oldest snapshot">{formatAge(ages.oldestMs)}</Detail>}
                {ages.newestMs != null && <Detail term="Newest snapshot">{formatAge(ages.newestMs)}</Detail>}
                {releases.length > 0 && <Detail term="OVN version">{releases.join(', ')}</Detail>}
                <Detail term="Refreshed">every {COLLECTOR_REFRESH_MS / 1000} seconds</Detail>
                {error && <Detail term="Last refresh failed">{error}</Detail>}
                {warnings.length > 0 && (
                    <Detail term="Warnings">
                        {warnings.slice(0, MAX_WARNINGS_SHOWN).map((warning) => (
                            <div key={`${warning.code}:${warning.message}`} style={{ overflowWrap: 'anywhere' }}>
                                {warning.code}: {warning.message}
                            </div>
                        ))}
                        {warnings.length > MAX_WARNINGS_SHOWN && (
                            <div style={subtle}>and {warnings.length - MAX_WARNINGS_SHOWN} more</div>
                        )}
                    </Detail>
                )}
            </DescriptionList>
        );
    }

    return (
        <Flex
            spaceItems={{ default: 'spaceItemsMd' }}
            alignItems={{ default: 'alignItemsCenter' }}
            rowGap={{ default: 'rowGapSm' }}
        >
            {label && <FlexItem>{label}</FlexItem>}
            {!gateLoaded && <FlexItem><span style={subtle}>Loading...</span></FlexItem>}
            {gateLoaded && !enabled && (
                <FlexItem><Label isCompact color="grey">Collector not enabled</Label></FlexItem>
            )}
            {unreachable && (
                <FlexItem><Label isCompact status="warning">Collector unreachable</Label></FlexItem>
            )}
            {active && !unreachable && (
                <FlexItem>
                    <SnapshotStatusLine
                        freshness={freshnessFromAge(ages.oldestMs)}
                        ageMs={ages.oldestMs}
                        ageQualifier="oldest node "
                        zoneCount={topology?.snapshots.length}
                        sourceHealth={topology?.metadata.sourceHealth}
                        isLoading={loading && !topology}
                    />
                </FlexItem>
            )}
            {active && warnings.length > 0 && (
                <FlexItem>
                    <Label isCompact color="yellow">{plural(warnings.length, 'collector warning')}</Label>
                </FlexItem>
            )}
            {gateLoaded && (
                <FlexItem>
                    <Popover
                        aria-label="Collector details"
                        headerContent="Collector"
                        bodyContent={<div data-testid="overview-collector-details">{details}</div>}
                        minWidth="min(24rem, 90vw)"
                    >
                        <Button variant="link" isInline>Collector details</Button>
                    </Popover>
                </FlexItem>
            )}
            {action && <FlexItem align={{ default: 'alignRight' }}>{action}</FlexItem>}
        </Flex>
    );
};

/**
 * The collector's aggregate, polled while the gate is on. A disabled collector is
 * never asked.
 */
export const useCollectorState = (): CollectorState => {
    const { enabled, loaded: gateLoaded } = useOvnCollectorFeatureGate();
    const [topology, setTopology] = React.useState<ClusterLogicalTopology | null>(null);
    const [error, setError] = React.useState<string>('');
    const [loading, setLoading] = React.useState<boolean>(false);
    React.useEffect(() => {
        if (!enabled) return undefined;
        let cancelled = false;
        const load = async () => {
            setLoading(true);
            try {
                const payload = await fetchClusterTopology();
                if (!cancelled) {
                    setTopology(payload);
                    setError('');
                }
            } catch (caught) {
                if (!cancelled) {
                    setError(caught instanceof Error ? caught.message : 'Failed to reach the collector');
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        load();
        const timer = window.setInterval(load, COLLECTOR_REFRESH_MS);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
        };
    }, [enabled]);
    return React.useMemo(
        () => ({ enabled, gateLoaded, topology, error, loading }),
        [enabled, gateLoaded, topology, error, loading],
    );
};

export default CollectorStatus;
