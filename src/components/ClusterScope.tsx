import * as React from 'react';
import { useNavigate } from 'react-router';
import { Badge, Flex, FlexItem, PageSection, Spinner, Tab, Tabs, TabTitleText, Title } from '@patternfly/react-core';
import { DocumentTitle } from '@openshift-console/dynamic-plugin-sdk';

import FindingsCard from '../insights/ui/FindingsCard';
import {
    ClusterTab,
    clusterFindingsPath,
    clusterLogicalPath,
    networksPath,
    overviewPath,
    searchPath,
} from '../routes';
import { ClusterSearchResultsPanel, ClusterSearchState } from './ClusterSearch';
import NetworksTable from './NetworksTable';
import NodesTable from './NodesTable';
import type { ExplorerData } from './useExplorerData';

/**
 * The Cluster scope of the explorer (ovn-recon-gbr.4), its landing selection: a
 * header, tabs that are links, and one body per tab. Everything is drawn from the
 * shell's data (`useExplorerData`); only the logical topology, which reads the
 * collector itself, is loaded when its tab is opened.
 */

const ClusterLogicalTopologyBody = React.lazy(() => import('./ClusterLogicalTopologyDetails')
    .then((module) => ({ default: module.ClusterLogicalTopologyBody })));

const subtle: React.CSSProperties = { color: 'var(--pf-t--global--text--color--subtle)' };

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** A plain click: anything else (a new tab or window) is left to the browser. */
const isPlainClick = (event: React.MouseEvent | React.KeyboardEvent | MouseEvent): boolean => {
    const { button, metaKey, ctrlKey, shiftKey, altKey } = event as MouseEvent;
    return !(metaKey || ctrlKey || shiftKey || altKey) && (button === undefined || button === 0);
};

interface TabSpec {
    key: ClusterTab;
    title: string;
    path: string;
    count?: number;
}

export interface ClusterScopeHeaderProps {
    tab: ClusterTab;
    data: ExplorerData;
    /** The search text, for the Search results tab's link. */
    query?: string;
}

/**
 * The scope's header and its tabs. Each tab is a link to its own URL, so the tab is
 * in the address bar, Back returns to it, and a middle click opens it in a new tab.
 * The Search results tab is there only while a search is open; the Logical topology
 * tab only while the collector is on (or its URL is open).
 */
export const ClusterScopeHeader: React.FC<ClusterScopeHeaderProps> = ({ tab, data, query }) => {
    const navigate = useNavigate();
    const tabs: TabSpec[] = [
        { key: 'nodes', title: 'Nodes', path: overviewPath(), count: data.nodeNetworkStatesSettled ? data.summaries.length : undefined },
        { key: 'networks', title: 'Networks', path: networksPath(), count: data.networksLoaded ? data.networkRows.length : undefined },
        { key: 'findings', title: 'Findings', path: clusterFindingsPath(), count: data.nodeNetworkStatesSettled ? data.findings.length : undefined },
    ];
    if (data.showLogical || tab === 'logical') {
        tabs.push({ key: 'logical', title: 'Logical topology', path: clusterLogicalPath() });
    }
    if (tab === 'search') tabs.push({ key: 'search', title: 'Search results', path: searchPath(query ?? '') });

    return (
        <PageSection padding={{ default: 'noPadding' }} style={{ paddingInline: 'var(--pf-t--global--spacer--lg)', paddingBlockStart: 'var(--pf-t--global--spacer--md)' }}>
            <Flex alignItems={{ default: 'alignItemsBaseline' }} spaceItems={{ default: 'spaceItemsMd' }}>
                <FlexItem><Title headingLevel="h2" size="xl">Cluster</Title></FlexItem>
                <FlexItem>
                    <span style={subtle}>
                        Physical and logical network topology across {plural(data.summaries.length, 'node')}
                    </span>
                </FlexItem>
            </Flex>
            <Tabs
                activeKey={tab}
                aria-label="Cluster views"
                component="nav"
                data-testid="cluster-tabs"
                onSelect={(event, key) => {
                    const target = tabs.find((candidate) => candidate.key === key);
                    if (!target || !isPlainClick(event)) return;
                    event.preventDefault();
                    if (key !== tab) navigate(target.path);
                }}
            >
                {tabs.map(({ key, title, path, count }) => (
                    <Tab
                        key={key}
                        eventKey={key}
                        href={path}
                        data-testid={`cluster-tab-${key}`}
                        title={(
                            <TabTitleText>
                                {title}
                                {count !== undefined && (
                                    <Badge isRead style={{ marginInlineStart: 'var(--pf-t--global--spacer--sm)' }}>{count}</Badge>
                                )}
                            </TabTitleText>
                        )}
                    />
                ))}
            </Tabs>
        </PageSection>
    );
};

const TabBody: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
    <>
        <DocumentTitle>{title}</DocumentTitle>
        <PageSection isFilled>{children}</PageSection>
    </>
);

/** Nodes: the table, and the landing view. */
export const ClusterNodesTab: React.FC<{ data: ExplorerData }> = ({ data }) => (
    <TabBody title="OVN Recon">
        <NodesTable
            summaries={data.summaries}
            roles={data.roles}
            findingCounts={data.findingCounts}
            loaded={data.nodeNetworkStatesLoaded && data.collector.gateLoaded}
            error={data.nodeNetworkStatesError}
            showLogical={data.showLogical}
        />
    </TabBody>
);

/** Networks: every network, findings first, with what the networks page listed. */
export const ClusterNetworksTab: React.FC<{ data: ExplorerData }> = ({ data }) => (
    <TabBody title="OVN Recon - Networks">
        <p style={subtle}>
            Every ClusterUserDefinedNetwork, UserDefinedNetwork, and NetworkAttachmentDefinition that neither of
            them generated.
        </p>
        <NetworksTable rows={data.networkRows} loaded={data.networksLoaded} inputs={data.networkInputs} />
    </TabBody>
);

/** Findings: what the overview's findings card showed. Scoped by selection in ovn-recon-gbr.7. */
export const ClusterFindingsTab: React.FC<{ data: ExplorerData }> = ({ data }) => (
    <TabBody title="OVN Recon - Findings">
        <FindingsCard
            findings={data.findings}
            allFindings={data.allFindings}
            hideInfo={data.hideInfo}
            onHideInfoChange={data.setHideInfo}
            nodeNames={data.nodeNames}
            loaded={data.nodeNetworkStatesSettled}
            unavailable={data.nodeNetworkStatesError
                ? 'NodeNetworkStates could not be read, so node findings are unknown.'
                : undefined}
        />
    </TabBody>
);

/** Logical topology: the cluster ladder, behind the collector gate as its page was. */
export const ClusterLogicalTab: React.FC = () => (
    <>
        <DocumentTitle>OVN Recon - Cluster Logical Topology</DocumentTitle>
        <React.Suspense fallback={<PageSection><Spinner size="lg" aria-label="Loading the logical topology" /></PageSection>}>
            {/* Its "Filter by host" select stays: it narrows this view, which the tree does not. */}
            <ClusterLogicalTopologyBody />
        </React.Suspense>
    </>
);

/** Search results: temporary, until search gets its own place (ovn-recon-gbr.8). */
export const ClusterSearchTab: React.FC<{ search: ClusterSearchState }> = ({ search }) => (
    <TabBody title={search.submitted ? `OVN Recon - Search: ${search.submitted}` : 'OVN Recon - Search'}>
        <ClusterSearchResultsPanel search={search} />
    </TabBody>
);
