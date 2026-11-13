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
    Spinner,
} from '@patternfly/react-core';

import { ClusterLogicalTopology } from '../types';
import { COLLECTOR_WARMING } from '../insights/rules/collectorDegraded';
import { ConsoleLink } from '../linkOut/LinkOut';
import { LinkTarget } from '../linkOut/registry';
import {
    CollectorFailure,
    describeCollectorFailure,
    fetchClusterTopology,
    rememberedClusterTopology,
} from './collectorApi';
import { CollectorFailureDetails } from './collectorViewStates';
import { snapshotAges } from './overviewModel';
import { freshnessFromAge } from './snapshotFreshness';
import SnapshotStatusLine, { formatAge, ovnReleaseOf, summarizeOvnZones } from './SnapshotStatusLine';
import { CollectorDeploymentRef, useOvnCollectorFeatureGate } from './useOvnCollectorFeatureGate';

/**
 * The collector in one line (ovn-recon-nt4.9), and the hook that reads what the line
 * says. Lifted out of the overview (ovn-recon-gbr.3) so a host other than the
 * overview page can own the state and place the line.
 *
 * Its states (ovn-recon-nt4.4): not enabled; waiting for the first answer; not
 * answering, with the HTTP status of the likeliest route, links to the collector's
 * Deployment, pods and events, and the routes tried behind "Details"; warming its
 * cache after start-up (any zone snapshot marked COLLECTOR_WARMING); and the freshness
 * line. The collector reports no warm-up progress, so the line cannot say "k of N
 * nodes"; that waits for a status endpoint (ovn-recon-1zx).
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
    /** The same failure, for the status line and its details; absent after one that worked. */
    failure?: CollectorFailure | null;
    /** The collector's Deployment, once the OvnRecon resource is read. */
    deployment?: CollectorDeploymentRef;
    loading: boolean;
}

export interface CollectorStatusProps {
    collector: CollectorState;
    /** Drawn first on the line, before the status: what the host calls the line. */
    label?: React.ReactNode;
    /** Drawn last, at the far end of the line: a host's own link or button. */
    action?: React.ReactNode;
}

/** Whether any zone in the aggregate was served while the collector's start-up sweep ran. */
export const collectorIsWarming = (topology: ClusterLogicalTopology | null | undefined): boolean =>
    (topology?.snapshots ?? []).some((snapshot) =>
        (snapshot.warnings ?? []).some((warning) => warning.code === COLLECTOR_WARMING));

const Detail: React.FC<{ term: string; children: React.ReactNode }> = ({ term, children }) => (
    <DescriptionListGroup>
        <DescriptionListTerm>{term}</DescriptionListTerm>
        <DescriptionListDescription>{children}</DescriptionListDescription>
    </DescriptionListGroup>
);

const deploymentTarget = (
    deployment: CollectorDeploymentRef,
    view: 'details' | 'pods' | 'events',
): LinkTarget => ({
    type: 'resource',
    ref: { apiVersion: 'apps/v1', kind: 'Deployment', namespace: deployment.namespace, name: deployment.name },
    view,
});

/** Where to look next: the collector's Deployment, its pods and its events. */
const CollectorLinks: React.FC<{ deployment?: CollectorDeploymentRef }> = ({ deployment }) => {
    if (!deployment) return null;
    return (
        <Flex spaceItems={{ default: 'spaceItemsMd' }} data-testid="collector-links">
            <FlexItem>
                <ConsoleLink target={deploymentTarget(deployment, 'details')}>Collector Deployment</ConsoleLink>
            </FlexItem>
            <FlexItem><ConsoleLink target={deploymentTarget(deployment, 'pods')}>Pods</ConsoleLink></FlexItem>
            <FlexItem><ConsoleLink target={deploymentTarget(deployment, 'events')}>Events</ConsoleLink></FlexItem>
        </Flex>
    );
};

/** A failure from an error string alone, for a host that passes no `failure`. */
const failureOf = (collector: CollectorState): CollectorFailure | null => {
    if (collector.failure) return collector.failure;
    if (!collector.error) return null;
    return { summary: 'Collector is not answering', attempts: [], message: collector.error };
};

/**
 * Freshness, how many node databases the cluster view is assembled from, and anything
 * degraded, with the rest behind "Collector details". Only what the aggregate response
 * and the feature gate already say is shown here.
 */
const CollectorStatus: React.FC<CollectorStatusProps> = ({ collector, label, action }) => {
    const { enabled, gateLoaded, topology, loading, deployment } = collector;

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
    const failure = active ? failureOf(collector) : null;
    const unreachable = Boolean(failure) && !topology;
    const waiting = active && !failure && !topology;
    const warming = active && collectorIsWarming(topology);
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
    } else if (unreachable && failure) {
        details = (
            <>
                <p><strong>{failure.summary}</strong></p>
                <CollectorLinks deployment={deployment} />
                <CollectorFailureDetails failure={failure} />
                <p style={subtle}>Retried every {COLLECTOR_REFRESH_MS / 1000} seconds.</p>
            </>
        );
    } else if (!topology) {
        details = (
            <p>
                Waiting for the collector&apos;s first answer. It reads every node&apos;s OVN databases, which
                takes a while when its cache is cold.
            </p>
        );
    } else {
        details = (
            <DescriptionList isCompact isHorizontal horizontalTermWidthModifier={{ default: '16ch' }}>
                <Detail term="Source health">{topology.metadata.sourceHealth || 'unknown'}</Detail>
                <Detail term="Node databases">{topology.snapshots.length}</Detail>
                {warming && (
                    <Detail term="Cache">Warming after start-up; node snapshots may be collected live</Detail>
                )}
                {ages.oldestMs != null && <Detail term="Oldest snapshot">{formatAge(ages.oldestMs)}</Detail>}
                {ages.newestMs != null && <Detail term="Newest snapshot">{formatAge(ages.newestMs)}</Detail>}
                {releases.length > 0 && <Detail term="OVN version">{releases.join(', ')}</Detail>}
                <Detail term="Refreshed">every {COLLECTOR_REFRESH_MS / 1000} seconds</Detail>
                {failure && (
                    <Detail term="Last refresh failed">
                        {failure.summary}
                        <CollectorLinks deployment={deployment} />
                        <CollectorFailureDetails failure={failure} />
                    </Detail>
                )}
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
            {waiting && (
                <FlexItem>
                    <Flex spaceItems={{ default: 'spaceItemsSm' }} alignItems={{ default: 'alignItemsCenter' }}>
                        <FlexItem><Label isCompact color="grey">Waiting for the collector</Label></FlexItem>
                        {loading && (
                            <FlexItem><Spinner size="sm" aria-label="Waiting for the collector" /></FlexItem>
                        )}
                    </Flex>
                </FlexItem>
            )}
            {active && topology && (
                <FlexItem>
                    <SnapshotStatusLine
                        freshness={freshnessFromAge(ages.oldestMs)}
                        ageMs={ages.oldestMs}
                        ageQualifier="oldest node "
                        zoneCount={topology.snapshots.length}
                        sourceHealth={topology.metadata.sourceHealth}
                        isLoading={false}
                    />
                </FlexItem>
            )}
            {warming && (
                <FlexItem>
                    <Label
                        isCompact
                        color="blue"
                        title="The collector restarted and is collecting every node's snapshot into its cache"
                    >
                        Warming cache
                    </Label>
                </FlexItem>
            )}
            {failure && (
                <FlexItem><Label isCompact status="warning">{failure.summary}</Label></FlexItem>
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
 * never asked. The last aggregate this browser tab received paints first
 * (ovn-recon-nt4.4), so a remount after a trip to another console page does not
 * start from "Waiting for the collector".
 */
export const useCollectorState = (): CollectorState => {
    const { enabled, loaded: gateLoaded, collectorDeployment } = useOvnCollectorFeatureGate();
    const [topology, setTopology] = React.useState<ClusterLogicalTopology | null>(rememberedClusterTopology);
    const [failure, setFailure] = React.useState<CollectorFailure | null>(null);
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
                    setFailure(null);
                }
            } catch (caught) {
                if (!cancelled) setFailure(describeCollectorFailure(caught));
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
    const error = failure?.message ?? '';
    return React.useMemo(
        () => ({ enabled, gateLoaded, topology, error, failure, deployment: collectorDeployment, loading }),
        [enabled, gateLoaded, topology, error, failure, collectorDeployment, loading],
    );
};

export default CollectorStatus;
