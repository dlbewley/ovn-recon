import * as React from 'react';
import {
    Button, DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm
} from '@patternfly/react-core';
import { CodeEditor, Language } from '@patternfly/react-code-editor';
import { ExternalLinkAltIcon } from '@patternfly/react-icons';
import * as yaml from 'js-yaml';

import { TopologyEdge } from '../components/nodeVisualizationModel';
import { GraphContext } from './context';
import { baseFacts, FactList, ProvenanceLabel } from './facts';
import { nodeKindRegistry } from './registry';
import { DrawerTabDefinition, DrawerTabId } from './types';

/**
 * The three drawer tabs (ovn-recon-s3t.13).
 *
 * Overview is the facts -- Summary was a near-strict subset of Details, so the
 * split earned nothing and is gone. Relationships lists the selected node's
 * neighbors as clickable entries that move the selection, turning the drawer
 * from a leaf view into a navigation instrument. Config is the YAML plus the
 * console resource link.
 */
export const DRAWER_TAB_IDS: DrawerTabId[] = ['overview', 'relationships', 'config'];

/**
 * What the tabs need from the rendering component: the edges of the current
 * view, a way to name a node id, and the selection to drive. Passed in rather
 * than derived here so the tabs stay in lockstep with what the canvas shows.
 */
export interface DrawerTabHooks {
    edges: TopologyEdge[];
    labelFor: (id: string) => string;
    onSelectNode: (id: string) => void;
}

const subtle: React.CSSProperties = { color: 'var(--pf-t--global--text--color--subtle)' };

interface Neighbor {
    id: string;
    edge: TopologyEdge;
}

/**
 * Each neighbour says WHY the line exists (ovn-recon-s3t.30): the rationale
 * names the fields the edge was read from, and an inferred edge wears the same
 * chip an inferred fact does. The rule slug and kind survive as a tooltip.
 */
const neighborGroup = (title: string, neighbors: Neighbor[], hooks: DrawerTabHooks) => (
    <DescriptionListGroup>
        <DescriptionListTerm>{title}</DescriptionListTerm>
        <DescriptionListDescription>
            <ul className="pf-v6-c-list">
                {neighbors.map(({ id, edge }, index) => (
                    <li key={`${id}-${edge.rule}-${index}`}>
                        <Button variant="link" isInline onClick={() => hooks.onSelectNode(id)}>
                            {hooks.labelFor(id)}
                        </Button>
                        <ProvenanceLabel provenance={edge.provenance} hint={`${edge.rule} (${edge.kind})`} />
                        <div style={{ ...subtle, fontSize: '0.9em' }} title={`${edge.rule} (${edge.kind})`}>
                            {edge.rationale}
                        </div>
                    </li>
                ))}
            </ul>
        </DescriptionListDescription>
    </DescriptionListGroup>
);

export const buildDrawerTabs = (
    ctx: GraphContext,
    hooks: DrawerTabHooks
): Record<DrawerTabId, DrawerTabDefinition> => ({
    overview: {
        id: 'overview',
        title: 'Overview',
        render: (node) => {
            const facts = nodeKindRegistry[node.kind]?.facts?.(node, ctx);
            return (
                <div style={{ padding: '16px', overflow: 'auto', flex: 1 }}>
                    <FactList facts={facts ?? baseFacts(node)} />
                </div>
            );
        }
    },
    relationships: {
        id: 'relationships',
        title: 'Relationships',
        render: (node) => {
            // Upstream reads toward the hardware, downstream toward the overlay --
            // the same left-to-right direction the canvas draws.
            const upstream = hooks.edges
                .filter((edge) => edge.target === node.id)
                .map((edge): Neighbor => ({ id: edge.source, edge }));
            const downstream = hooks.edges
                .filter((edge) => edge.source === node.id)
                .map((edge): Neighbor => ({ id: edge.target, edge }));

            return (
                <div style={{ padding: '16px', overflow: 'auto', flex: 1 }}>
                    {upstream.length === 0 && downstream.length === 0 ? (
                        <span style={subtle}>No relationships derived for this node.</span>
                    ) : (
                        <DescriptionList isCompact>
                            {upstream.length > 0 && neighborGroup('Upstream', upstream, hooks)}
                            {downstream.length > 0 && neighborGroup('Downstream', downstream, hooks)}
                        </DescriptionList>
                    )}
                </div>
            );
        }
    },
    config: {
        id: 'config',
        title: 'Config',
        render: (node) => (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                {node.raw && (
                    <>
                        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', borderBottom: '1px solid var(--pf-t--global--border--color--default)' }}>
                            <CodeEditor
                                isDarkTheme
                                isLineNumbersVisible
                                isReadOnly
                                code={yaml.dump(node.raw)}
                                language={Language.yaml}
                                height="100%"
                                style={{ height: '100%' }}
                            />
                        </div>
                        <div style={{ flex: '0 0 auto', padding: 'var(--pf-t--global--spacer--md)', backgroundColor: 'var(--pf-t--global--background--color--primary--default)' }}>
                            <ExternalLinkAltIcon style={{ marginRight: 'var(--pf-t--global--spacer--sm)' }} />
                            <a
                                href={(() => {
                                    if (node.resourceRef) {
                                        const resourceId = node.resourceRef.apiVersion
                                            ? `${node.resourceRef.apiVersion.replace('/', '~')}~${node.resourceRef.kind}`
                                            : node.resourceRef.kind;
                                        const base = node.resourceRef.namespace
                                            ? `/k8s/ns/${node.resourceRef.namespace}`
                                            : '/k8s/cluster';
                                        return `${window.location.origin}${base}/${resourceId}/${node.resourceRef.name}/yaml`;
                                    }
                                    const namespace = node.raw?.metadata?.namespace;
                                    const resourceId = node.kind === 'other' || node.kind === 'interface' || node.kind === 'ovn-mapping'
                                        ? 'nodenetworkstates.nmstate.io'
                                        : 'clusteruserdefinednetworks.k8s.cni.cncf.io';
                                    const base = namespace ? `/k8s/ns/${namespace}` : '/k8s/cluster';
                                    return `${window.location.origin}${base}/${resourceId}/${node.raw.metadata?.name}/yaml`;
                                })()}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                View Resource in Console
                            </a>
                        </div>
                    </>
                )}
                {!node.raw && (
                    <span style={{ fontSize: '0.9em', color: 'var(--pf-t--global--text--color--subtle)', padding: '16px' }}>No YAML content available.</span>
                )}
            </div>
        )
    }
});

/** Every kind shows the same three tabs; the per-kind `tabs` knob is gone. */
export const getDrawerTabs = (
    tabsById: Record<DrawerTabId, DrawerTabDefinition>
): DrawerTabDefinition[] => DRAWER_TAB_IDS.map((tabId) => tabsById[tabId]);
