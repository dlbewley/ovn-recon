import * as React from 'react';
import { useNavigate } from 'react-router';
import {
    Flex,
    FlexItem,
    MenuToggle,
    PageSection,
    Select,
    SelectList,
    SelectOption,
    Spinner,
    Title,
} from '@patternfly/react-core';
import { DocumentTitle } from '@openshift-console/dynamic-plugin-sdk';

import { findingsForNode } from '../insights/selectors';
import FindingsPanel from '../insights/ui/FindingsPanel';
import { LinkOutProvider, SecondaryLinks } from '../linkOut/LinkOut';
import { resourceTarget } from '../linkOut/registry';
import { nnsResourcePath } from './NodesTable';
import { activeNodeTab, NodeView, nodeSwitchPath, nodeTabs } from './nodeScopeModel';
import ScopeTabs from './ScopeTabs';
import type { ExplorerData } from './useExplorerData';

/**
 * The node scope of the explorer (ovn-recon-gbr.5): a header whose node name is a
 * switcher, with the node's role, counts and console links, over tabs for its
 * Physical topology, Logical topology, Routes and Findings (ovn-recon-gbr.7). The
 * construct page belongs to Logical topology. The graph bodies under the tabs are the
 * existing views without their page chrome, each loaded when first opened so the
 * shell's own chunk carries no graph code; Findings is drawn from the shell's one
 * evaluation, as the node table's Findings column is.
 */

const NodeNetworkStateBody = React.lazy(() => import('./NodeNetworkStateDetails')
    .then((module) => ({ default: module.NodeNetworkStateBody })));
const NodeRoutesBody = React.lazy(() => import('./NodeNetworkStateDetails')
    .then((module) => ({ default: module.NodeRoutesBody })));
const NodeLogicalTopologyBody = React.lazy(() => import('./NodeLogicalTopologyDetails')
    .then((module) => ({ default: module.NodeLogicalTopologyBody })));
const ConstructExplorerBody = React.lazy(() => import('./ConstructDetails')
    .then((module) => ({ default: module.ConstructExplorerBody })));

const subtle: React.CSSProperties = { color: 'var(--pf-t--global--text--color--subtle)' };

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** The node name as a menu of every node with a NodeNetworkState; picking one keeps the tab. */
const NodeSwitcher: React.FC<{ view: NodeView; data: ExplorerData }> = ({ view, data }) => {
    const navigate = useNavigate();
    const [open, setOpen] = React.useState(false);
    const node = view.params.node;
    return (
        <Select
            isOpen={open}
            selected={node}
            onOpenChange={setOpen}
            onSelect={(_event, value) => {
                setOpen(false);
                if (typeof value === 'string' && value !== node) navigate(nodeSwitchPath(view, value));
            }}
            isScrollable
            maxMenuHeight="24rem"
            shouldFocusToggleOnSelect
            toggle={(ref) => (
                <MenuToggle
                    ref={ref}
                    variant="plainText"
                    isExpanded={open}
                    onClick={() => setOpen((value) => !value)}
                    aria-label={`Node ${node}: switch node`}
                    data-testid="node-switcher"
                    style={{ fontSize: 'var(--pf-t--global--font--size--heading--h3)', fontWeight: 'var(--pf-t--global--font--weight--heading--default)', paddingInline: 0 }}
                >
                    {node}
                </MenuToggle>
            )}
        >
            <SelectList aria-label="Nodes">
                {data.summaries.map((summary) => (
                    <SelectOption
                        key={summary.name}
                        value={summary.name}
                        description={data.roles.get(summary.name) || undefined}
                        data-testid={`node-switcher-${summary.name}`}
                    >
                        {summary.name}
                    </SelectOption>
                ))}
            </SelectList>
        </Select>
    );
};

/** The node's findings are known: its NodeNetworkState list loaded and was readable. */
const nodeFindingsKnown = (data: ExplorerData): boolean =>
    data.nodeNetworkStatesLoaded && !data.nodeNetworkStatesError;

/** The node's header and tabs; nothing for a node view with no tab. */
export const NodeScopeHeader: React.FC<{ view: NodeView; data: ExplorerData }> = ({ view, data }) => {
    const node = view.params.node;
    const active = activeNodeTab(view);
    const summary = data.summaries.find((candidate) => candidate.name === node);
    const role = data.roles.get(node);
    if (active === null) return null;
    return (
        <PageSection
            padding={{ default: 'noPadding' }}
            style={{ paddingInline: 'var(--pf-t--global--spacer--lg)', paddingBlockStart: 'var(--pf-t--global--spacer--sm)' }}
            data-testid="node-scope-header"
        >
            <Flex alignItems={{ default: 'alignItemsCenter' }} spaceItems={{ default: 'spaceItemsMd' }} rowGap={{ default: 'rowGapSm' }}>
                <FlexItem>
                    <Title headingLevel="h2" size="xl">
                        <NodeSwitcher view={view} data={data} />
                    </Title>
                </FlexItem>
                <FlexItem>
                    <span style={subtle} data-testid="node-scope-facts">
                        {[
                            role,
                            summary && `${summary.interfacesUp} up / ${plural(summary.interfacesTotal, 'interface')}`,
                            summary && plural(summary.bridgeMappings, 'bridge mapping'),
                        ].filter(Boolean).join(' · ')}
                    </span>
                </FlexItem>
                {summary && (
                    <FlexItem>
                        <a href={nnsResourcePath(node)} target="_blank" rel="noopener noreferrer">NodeNetworkState</a>
                    </FlexItem>
                )}
                <FlexItem>
                    {/* The Node's link-outs, as the physical page's header had them ("View traffic"). */}
                    <LinkOutProvider>
                        <SecondaryLinks target={resourceTarget({ apiVersion: 'v1', kind: 'Node', name: node })} />
                    </LinkOutProvider>
                </FlexItem>
            </Flex>
            <ScopeTabs
                tabs={nodeTabs(
                    node,
                    data.showLogical,
                    active,
                    nodeFindingsKnown(data) ? data.findingCounts.get(node)?.total ?? 0 : undefined,
                )}
                active={active}
                aria-label={`Views of node ${node}`}
                testIdPrefix="node-tab"
            />
        </PageSection>
    );
};

const Loading: React.FC = () => (
    <PageSection><Spinner size="lg" aria-label="Loading" /></PageSection>
);

/** One node's findings: the cluster tab's list, narrowed to the node. */
const NodeFindingsTab: React.FC<{ node: string; data: ExplorerData }> = ({ node, data }) => {
    const findings = React.useMemo(() => findingsForNode(data.findings, node), [data.findings, node]);
    const allFindings = React.useMemo(() => findingsForNode(data.allFindings, node), [data.allFindings, node]);
    return (
        <>
            <DocumentTitle>{`OVN Recon - Findings (${node})`}</DocumentTitle>
            <PageSection isFilled>
                <FindingsPanel
                    idPrefix="node"
                    node={node}
                    findings={findings}
                    allFindings={allFindings}
                    hideInfo={data.hideInfo}
                    onHideInfoChange={data.setHideInfo}
                    nodeNames={data.nodeNames}
                    loaded={data.nodeNetworkStatesSettled}
                    emptyText={`No findings on ${node}.`}
                    unavailable={data.nodeNetworkStatesError
                        ? 'NodeNetworkStates could not be read, so this node\'s findings are unknown.'
                        : undefined}
                />
            </PageSection>
        </>
    );
};

/**
 * The view under the node's tabs. Physical topology and the ladder draw edge to
 * edge, without their cards, so with the tree collapsed they have the width the
 * routed pages gave them.
 */
export const NodeScopeBody: React.FC<{ view: NodeView; data: ExplorerData }> = ({ view, data }) => {
    const { node, kind, name } = view.params;
    let body: React.ReactNode;
    switch (view.tab) {
        case 'physical':
            body = <NodeNetworkStateBody name={node} inExplorer />;
            break;
        case 'routes':
            body = <NodeRoutesBody name={node} />;
            break;
        case 'logical':
            body = (
                <>
                    <DocumentTitle>{`OVN Recon - Logical OVN (${node})`}</DocumentTitle>
                    <NodeLogicalTopologyBody name={node} hideHostSelect flush />
                </>
            );
            break;
        case 'construct':
            body = <ConstructExplorerBody node={node} kind={kind ?? ''} name={name ?? ''} />;
            break;
        case 'findings':
            return <NodeFindingsTab node={node} data={data} />;
        default:
            body = null;
    }
    return <React.Suspense fallback={<Loading />}>{body}</React.Suspense>;
};
