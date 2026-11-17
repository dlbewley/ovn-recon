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

import { CollectorStatusResponse } from '../types';
import { COLLECTOR_WARMING } from '../insights/rules/collectorDegraded';
import { ConsoleLink } from '../linkOut/LinkOut';
import { LinkTarget } from '../linkOut/registry';
import {
    CollectorFailure,
    describeCollectorFailure,
    fetchCollectorStatus,
    rememberedCollectorStatus,
} from './collectorApi';
import { CollectorFailureDetails } from './collectorViewStates';
import { snapshotAges } from './overviewModel';
import { freshnessFromAge } from './snapshotFreshness';
import SnapshotStatusLine, { formatAge, ovnReleaseOf } from './SnapshotStatusLine';
import { CollectorDeploymentRef, useOvnCollectorFeatureGate } from './useOvnCollectorFeatureGate';

/**
 * The collector in one line (ovn-recon-nt4.9), and the hook that reads what the line
 * says. Lifted out of the overview (ovn-recon-gbr.3) so a host other than the
 * overview page can own the state and place the line.
 *
 * Its states (ovn-recon-nt4.4): not enabled; waiting for the first answer; not
 * answering, with the HTTP status of the likeliest route, links to the collector's
 * Deployment, pods and events, and the routes tried behind "Details"; warming its
 * cache after start-up (any zone snapshot marked COLLECTOR_WARMING, or the status's
 * warmUp, which says "k of N nodes"); and the freshness line.
 *
 * It reads the collector's status (ovn-recon-1zx), the aggregate's envelope without
 * its databases, so a page left open no longer downloads every node's database a
 * minute; a collector older than that route answers with the aggregate instead.
 */

// Same cadence as the cluster view: the status resolves every zone as the
// aggregate does (a cold cache means live probes), so it is not something to
// hammer from a page people leave open.
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
    /** The last status the collector answered with. */
    status: CollectorStatusResponse | null;
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

/** Whether the collector's start-up sweep runs: it says so, or a zone was served meanwhile. */
export const collectorIsWarming = (status: CollectorStatusResponse | null | undefined): boolean =>
    Boolean(status?.warmUp)
    || (status?.zones ?? []).some((zone) =>
        (zone.warnings ?? []).some((warning) => warning.code === COLLECTOR_WARMING));

/** "3 of 7 nodes" while the sweep reports its progress, else ''. */
export const warmUpProgress = (status: CollectorStatusResponse | null | undefined): string => {
    const warmUp = status?.warmUp;
    if (!warmUp || warmUp.nodes <= 0) return '';
    return `${Math.min(warmUp.done, warmUp.nodes)} of ${plural(warmUp.nodes, 'node')}`;
};

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
 * degraded, with the rest behind "Collector details". Only what the status response
 * and the feature gate already say is shown here.
 */
const CollectorStatus: React.FC<CollectorStatusProps> = ({ collector, label, action }) => {
    const { enabled, gateLoaded, status, loading, deployment } = collector;

    // Keep the age text moving between refetches.
    const [ageTick, setAgeTick] = React.useState(0);
    React.useEffect(() => {
        const timer = window.setInterval(() => setAgeTick((tick) => tick + 1), 30000);
        return () => window.clearInterval(timer);
    }, []);
    const ages = React.useMemo(
        () => snapshotAges((status?.zones ?? []).map((zone) => zone.generatedAt)),
        // ageTick is a deliberate extra dependency: it forces the ages to recompute.
        [status, ageTick],
    );
    const releases = React.useMemo(
        () => [...new Set((status?.zones ?? [])
            .map((zone) => zone.ovnVersion)
            .filter((version): version is string => Boolean(version))
            .map(ovnReleaseOf))],
        [status],
    );

    const active = gateLoaded && enabled;
    const failure = active ? failureOf(collector) : null;
    const unreachable = Boolean(failure) && !status;
    const waiting = active && !failure && !status;
    const warming = active && collectorIsWarming(status);
    const progress = warmUpProgress(status);
    const warnings = status?.warnings ?? [];

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
    } else if (!status) {
        details = (
            <p>
                Waiting for the collector&apos;s first answer. It reads every node&apos;s OVN databases, which
                takes a while when its cache is cold.
            </p>
        );
    } else {
        details = (
            <DescriptionList isCompact isHorizontal horizontalTermWidthModifier={{ default: '16ch' }}>
                <Detail term="Source health">{status.metadata.sourceHealth || 'unknown'}</Detail>
                <Detail term="Node databases">{status.zones.length}</Detail>
                {warming && (
                    <Detail term="Cache">
                        Warming after start-up{progress ? ` (${progress} collected)` : ''}; node snapshots may
                        be collected live
                    </Detail>
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
            {active && status && (
                <FlexItem>
                    <SnapshotStatusLine
                        freshness={freshnessFromAge(ages.oldestMs)}
                        ageMs={ages.oldestMs}
                        ageQualifier="oldest node "
                        zoneCount={status.zones.length}
                        sourceHealth={status.metadata.sourceHealth}
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
                        {progress ? `Warming cache: ${progress}` : 'Warming cache'}
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
 * The collector's status (ovn-recon-1zx), polled while the gate is on. A disabled
 * collector is never asked. The last status this browser tab knows paints first
 * (ovn-recon-nt4.4), including the one implied by an aggregate the cluster ladder
 * fetched, so a remount after a trip to another console page does not start from
 * "Waiting for the collector".
 *
 * It no longer fetches the aggregate, so it no longer fills the aggregate the cluster
 * ladder paints from on first open; the ladder fetches its own, from a collector cache
 * this poll keeps warm.
 */
export const useCollectorState = (): CollectorState => {
    const { enabled, loaded: gateLoaded, collectorDeployment } = useOvnCollectorFeatureGate();
    const [status, setStatus] = React.useState<CollectorStatusResponse | null>(rememberedCollectorStatus);
    const [failure, setFailure] = React.useState<CollectorFailure | null>(null);
    const [loading, setLoading] = React.useState<boolean>(false);
    React.useEffect(() => {
        if (!enabled) return undefined;
        let cancelled = false;
        const load = async () => {
            setLoading(true);
            try {
                const payload = await fetchCollectorStatus();
                if (!cancelled) {
                    setStatus(payload);
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
        () => ({ enabled, gateLoaded, status, error, failure, deployment: collectorDeployment, loading }),
        [enabled, gateLoaded, status, error, failure, collectorDeployment, loading],
    );
};

export default CollectorStatus;
