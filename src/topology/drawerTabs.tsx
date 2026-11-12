import * as React from 'react';
import { Button } from '@patternfly/react-core';
import { CodeEditor, Language } from '@patternfly/react-code-editor';
import * as yaml from 'js-yaml';

import type { InterfaceSelector } from '../components/KernelRouteTable';
import { TopologyEdge } from '../components/nodeVisualizationModel';
import { useIsDarkTheme } from '../components/useIsDarkTheme';
import type { Finding } from '../insights/types';
import { FindingsSection } from '../insights/ui/FindingsViews';
import { ConsoleLink, LinkOutProvider, SecondaryLinks } from '../linkOut/LinkOut';
import { LinkTarget, resourceTarget } from '../linkOut/registry';
import { Interface } from '../types';
import { GraphContext } from './context';
import {
    FactRow, FactRows, IdentifiersSection, InferredLabel, InfoPopover, ValueList
} from '../components/drawerKit';
import { physicalIdentifiers } from './drawerIdentity';
import { baseFacts, FactList } from './facts';
import { resolveInterfaceLinkRef } from './ids';
import { nodeKindRegistry } from './registry';
import { DrawerTabDefinition, DrawerTabId, NodeViewModel } from './types';

/**
 * The three drawer tabs (ovn-recon-s3t.13).
 *
 * Overview is the facts -- Summary was a near-strict subset of Details, so the
 * split earned nothing and is gone. Relationships lists the selected node's
 * neighbors as clickable entries that move the selection, turning the drawer
 * from a leaf view into a navigation instrument. Config is the YAML. Overview
 * and Config both end with the links out to the console pages that own the
 * selection, resolved by the link-out registry.
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
    /**
     * Whether the canvas draws this node. Selecting one it does not draw
     * clears the selection, so links are offered only to drawn nodes. When
     * absent, every resolvable node is treated as drawn.
     */
    isDrawn?: (id: string) => boolean;
    /**
     * The findings to show for a node (ovn-recon-7i6.1), already gated and filtered
     * for the hide-info choice. When absent, or empty for a node, the Overview tab
     * draws exactly what it did before.
     */
    findingsFor?: (id: string) => Finding[];
}

/**
 * An interface name in a drawer table (a route's next-hop interface) as a
 * link that moves the selection the way the Relationships tab does, when the
 * graph draws that interface.
 */
export const interfaceSelector = (ctx: GraphContext, hooks: DrawerTabHooks, selfId?: string): InterfaceSelector =>
    (name) => {
        const id = resolveInterfaceLinkRef(name, ctx);
        // A management port resolves to its owner; in the owner's own drawer that
        // would be a link to the node already open, so it stays plain text.
        if (!id || id === selfId || (hooks.isDrawn && !hooks.isDrawn(id))) return undefined;
        return () => hooks.onSelectNode(id);
    };

const subtle: React.CSSProperties = { color: 'var(--pf-t--global--text--color--subtle)' };

/**
 * Monaco does not inherit CSS variables, so the YAML view follows the console
 * theme explicitly — it used to hardcode dark and read wrong in light mode
 * (ovn-recon-ehy). A component rather than inline JSX so the hook can run.
 */
const ThemedYamlEditor: React.FC<{ code: string }> = ({ code }) => {
    const isDarkTheme = useIsDarkTheme();
    return (
        <CodeEditor
            isDarkTheme={isDarkTheme}
            isLineNumbersVisible
            isReadOnly
            code={code}
            language={Language.yaml}
            height="100%"
            style={{ height: '100%' }}
        />
    );
};

/** Kinds whose raw item is one interface of the node's NodeNetworkState. */
const NNS_BACKED_KINDS = new Set(['interface', 'vrf', 'ovn-mapping', 'other']);

/**
 * The console page that owns the selection (ovn-recon-zdt.4). A network or a
 * NAD is its own resource. An interface, a VRF and a bridge mapping are entries
 * in the node's NodeNetworkState, so that is the resource they open.
 */
export const ownerTarget = (node: NodeViewModel, ctx: GraphContext): LinkTarget | undefined => {
    if (node.resourceRef) return resourceTarget(node.resourceRef);
    const nodeName = ctx.nns?.metadata?.name;
    return nodeName && NNS_BACKED_KINDS.has(node.kind)
        ? resourceTarget({ apiVersion: 'nmstate.io/v1beta1', kind: 'NodeNetworkState', name: nodeName })
        : undefined;
};

/** Pages beside the owner: nmstate's topology for an interface, Physical networks for a mapping. */
export const elsewhereTarget = (node: NodeViewModel, ctx: GraphContext): LinkTarget | undefined => {
    const nodeName = ctx.nns?.metadata?.name;
    if (node.kind === 'interface') {
        const raw = node.raw as Interface | undefined;
        return nodeName && raw?.name && raw.type
            ? { type: 'node-interface', node: nodeName, name: raw.name, interfaceType: raw.type }
            : undefined;
    }
    if (node.kind === 'ovn-mapping' && typeof node.raw?.localnet === 'string') {
        return { type: 'physical-network', name: node.raw.localnet };
    }
    return undefined;
};

/**
 * The foot of the Overview and Config tabs: where else in the console this
 * selection lives. Every link is in-app and absent when its page is not there.
 */
const ElsewhereLinks: React.FC<{ node: NodeViewModel; ctx: GraphContext }> = ({ node, ctx }) => {
    const owner = ownerTarget(node, ctx);
    const elsewhere = elsewhereTarget(node, ctx);
    if (!owner && !elsewhere) return null;
    return (
        <div
            data-testid="elsewhere-links"
            style={{
                flex: '0 0 auto',
                display: 'flex',
                flexWrap: 'wrap',
                gap: '0 1em',
                padding: 'var(--pf-t--global--spacer--md)',
                borderTop: '1px solid var(--pf-t--global--border--color--default)',
                backgroundColor: 'var(--pf-t--global--background--color--primary--default)'
            }}
        >
            <ConsoleLink target={owner} hideWhenAbsent data-testid="owner-link">View resource in console</ConsoleLink>
            {elsewhere?.type === 'physical-network'
                ? <ConsoleLink target={elsewhere} hideWhenAbsent>Open in Physical networks</ConsoleLink>
                : <SecondaryLinks target={elsewhere} />}
        </div>
    );
};

interface Neighbor {
    id: string;
    edge: TopologyEdge;
}

/**
 * Each neighbour says WHY the line exists (ovn-recon-s3t.30): the rationale
 * names the fields the edge was read from, and an inferred edge wears the same
 * chip an inferred fact does. The rule slug and kind sit behind an info button.
 */
const neighborRow = (title: string, neighbors: Neighbor[], hooks: DrawerTabHooks) => (
    <FactRow term={title}>
        <ValueList
            items={neighbors.map(({ id, edge }, index) => (
                <div key={`${id}-${edge.rule}-${index}`} data-testid="neighbor">
                    <Button variant="link" isInline onClick={() => hooks.onSelectNode(id)}>
                        {hooks.labelFor(id)}
                    </Button>
                    {edge.provenance === 'inferred' && <InferredLabel />}
                    <InfoPopover
                        subject={`the link to ${hooks.labelFor(id)}`}
                        hint={`${edge.rule} (${edge.kind})`}
                        header={edge.provenance === 'inferred' ? 'Inferred' : undefined}
                    />
                    <div style={{ ...subtle, fontSize: '0.9em' }}>{edge.rationale}</div>
                </div>
            ))}
        />
    </FactRow>
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
                <LinkOutProvider>
                    <div style={{ padding: '16px', overflow: 'auto', flex: 1 }}>
                        <FindingsSection findings={hooks.findingsFor?.(node.id) ?? []} />
                        <FactList facts={facts ?? baseFacts(node)} selectInterface={interfaceSelector(ctx, hooks, node.id)} />
                        <IdentifiersSection identifiers={physicalIdentifiers(node)} />
                    </div>
                    <ElsewhereLinks node={node} ctx={ctx} />
                </LinkOutProvider>
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
                        <FactRows ariaLabel="Relationships">
                            {upstream.length > 0 && neighborRow('Upstream', upstream, hooks)}
                            {downstream.length > 0 && neighborRow('Downstream', downstream, hooks)}
                        </FactRows>
                    )}
                </div>
            );
        }
    },
    config: {
        id: 'config',
        title: 'Config',
        render: (node) => (
            <LinkOutProvider>
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                    {node.raw && (
                        <>
                            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', borderBottom: '1px solid var(--pf-t--global--border--color--default)' }}>
                                <ThemedYamlEditor code={yaml.dump(node.raw)} />
                            </div>
                            <ElsewhereLinks node={node} ctx={ctx} />
                        </>
                    )}
                    {!node.raw && (
                        <span style={{ fontSize: '0.9em', color: 'var(--pf-t--global--text--color--subtle)', padding: '16px' }}>No YAML content available.</span>
                    )}
                </div>
            </LinkOutProvider>
        )
    }
});

/** Every kind shows the same three tabs; the per-kind `tabs` knob is gone. */
export const getDrawerTabs = (
    tabsById: Record<DrawerTabId, DrawerTabDefinition>
): DrawerTabDefinition[] => DRAWER_TAB_IDS.map((tabId) => tabsById[tabId]);
