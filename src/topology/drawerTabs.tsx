import * as React from 'react';
import {
    DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm
} from '@patternfly/react-core';
import { CodeEditor, Language } from '@patternfly/react-code-editor';
import { ExternalLinkAltIcon } from '@patternfly/react-icons';
import * as yaml from 'js-yaml';

import { GraphContext } from './context';
import { nodeKindRegistry, renderBaseSummary } from './registry';
import { DrawerTabDefinition, DrawerTabId, NodeKind, NodeViewModel } from './types';

export const DEFAULT_DRAWER_TABS: DrawerTabId[] = ['summary', 'details', 'links', 'yaml'];

/**
 * The four drawer tabs. ovn-recon-s3t.13 replaces this split with Overview /
 * Relationships / Config; the `tabs` knob on NodeKindDefinition that would let a
 * kind choose its own set is declared but populated by nobody.
 */
export const buildDrawerTabs = (ctx: GraphContext): Record<DrawerTabId, DrawerTabDefinition> => ({
        summary: {
            id: 'summary',
            title: 'Summary',
            render: (node) => (
                <div style={{ padding: '16px', overflow: 'auto', flex: 1 }}>
                    {nodeKindRegistry[node.kind]?.renderSummary?.(node, ctx) || renderBaseSummary(node)}
                </div>
            )
        },
        details: {
            id: 'details',
            title: 'Details',
            render: (node) => (
                <div style={{ padding: '16px', overflow: 'auto', flex: 1 }}>
                    {nodeKindRegistry[node.kind]?.renderDetails?.(node, ctx) || (
                        <DescriptionList isCompact>
                            <DescriptionListGroup>
                                <DescriptionListTerm>No details available</DescriptionListTerm>
                            </DescriptionListGroup>
                        </DescriptionList>
                    )}
                </div>
            )
        },
        links: {
            id: 'links',
            title: 'Links',
            render: (node) => (
                <div style={{ padding: '16px', overflow: 'auto', flex: 1 }}>
                    {node.links && node.links.length > 0 ? (
                        <DescriptionList isCompact>
                            <DescriptionListGroup>
                                <DescriptionListTerm>Available Links</DescriptionListTerm>
                                <DescriptionListDescription>
                                    <ul className="pf-v6-c-list">
                                        {node.links.map((link) => (
                                            <li key={link.href}>
                                                <a href={link.href} target="_blank" rel="noopener noreferrer">
                                                    {link.label}
                                                </a>
                                            </li>
                                        ))}
                                    </ul>
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        </DescriptionList>
                    ) : (
                        <div style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>No links available.</div>
                    )}
                </div>
            )
        },
        yaml: {
            id: 'yaml',
            title: 'YAML',
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

export const getDrawerTabsForKind = (
    kind: NodeKind,
    tabsById: Record<DrawerTabId, DrawerTabDefinition>
): DrawerTabDefinition[] =>
    (nodeKindRegistry[kind]?.tabs || DEFAULT_DRAWER_TABS).map((tabId) => tabsById[tabId]);

export const getDrawerTabsForNode = (
    node: NodeViewModel,
    tabsById: Record<DrawerTabId, DrawerTabDefinition>
): DrawerTabDefinition[] => getDrawerTabsForKind(node.kind, tabsById);
