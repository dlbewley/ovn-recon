import * as React from 'react';
import { Button, Popover, Title } from '@patternfly/react-core';

import { NODE_TYPES } from '../topology/descriptors';
import { EDGE_KIND_STYLES, PROVENANCE_STYLES } from '../topology/edgeStyles';
import { ProvenanceLabel } from '../topology/facts';
import { NodeStatus, STATUS_STYLE, SURFACE } from '../topology/palette';
import { NodeStatusIcon } from '../topology/statusIcon';
import type { EdgeKind } from './nodeVisualizationModel';
import type { Provenance } from '../topology/types';
import type { ConstructRole } from './logicalClassification';
import type { LadderEdgeKind } from './logicalLadderModel';
import {
    constructCornerRadius,
    LADDER_EDGE_STYLES,
    NETWORK_SLOTS,
    ROLE_DESCRIPTIONS,
    roleIcon,
    roleLabel,
} from './LogicalLadderView';
import { makeFinding, nodeRef } from '../insights/refs';
import { FindingsBadge, findingsBadgeWidth } from '../insights/ui/FindingsViews';
import type { Finding } from '../insights/types';

/**
 * The graph legends (ovn-recon-nt4.2): what each node kind, line, colour and mark on
 * the canvas means.
 *
 * GENERATED, NOT WRITTEN. Every row comes off the table the canvas itself draws from --
 * the node descriptors, the edge and provenance styles, the status styles, the ladder's
 * role and edge tables and its band palette -- so the legend cannot show a kind the
 * canvas lacks or a stroke it no longer draws. GraphLegend.test.tsx checks that every
 * registered kind has its row.
 */

const subtle: React.CSSProperties = { color: SURFACE.subtleText, fontSize: '0.85em' };

const Section: React.FC<{ title: string; testId: string; children: React.ReactNode }> = ({ title, testId, children }) => (
    <section data-testid={testId} style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}>
        <Title headingLevel="h4" size="md" style={{ marginBottom: 'var(--pf-t--global--spacer--sm)' }}>{title}</Title>
        <div
            style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(17rem, 1fr))',
                gap: 'var(--pf-t--global--spacer--sm) var(--pf-t--global--spacer--md)',
            }}
        >
            {children}
        </div>
    </section>
);

const Entry: React.FC<{ swatch: React.ReactNode; label: React.ReactNode; description?: string; entry: string }> = ({
    swatch, label, description, entry
}) => (
    <div data-legend-entry={entry} style={{ display: 'flex', gap: 'var(--pf-t--global--spacer--sm)', alignItems: 'flex-start' }}>
        <span style={{ flex: 'none', width: 48, display: 'inline-flex', justifyContent: 'center', paddingTop: 2 }}>{swatch}</span>
        <span style={{ minWidth: 0 }}>
            <strong>{label}</strong>
            {description && <div style={subtle}>{description}</div>}
        </span>
    </div>
);

/** A node card in miniature: neutral surface, accent stripe, icon in the accent. */
const CardSwatch: React.FC<{ accent: string; icon: React.ReactNode; radius?: number; dashed?: boolean; border?: string }> = ({
    accent, icon, radius = 4, dashed, border
}) => (
    <span
        data-swatch-accent={accent}
        style={{
            width: 40,
            height: 24,
            boxSizing: 'border-box',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: SURFACE.card,
            // Longhands only (ovn-recon-nt4.14): a border shorthand holding a var()
            // beside a borderLeft that React clears with '' loses its left side.
            borderStyle: dashed ? 'dashed' : 'solid',
            borderWidth: border ? 1.5 : 1,
            borderColor: border ?? SURFACE.border,
            // The physical cards' accent stripe; logical cards have none, only a border.
            ...(border ? {} : { borderLeftWidth: 4, borderLeftStyle: 'solid', borderLeftColor: accent }),
            borderRadius: radius,
            color: accent,
            fontSize: 14,
            lineHeight: 1,
        }}
    >
        {icon}
    </span>
);

const LineSwatch: React.FC<{ dashArray?: string; opacity?: number; stroke?: string; width?: number }> = ({
    dashArray, opacity = 1, stroke = 'currentColor', width = 2
}) => (
    <svg width={44} height={12} aria-hidden="true" style={{ color: SURFACE.text, overflow: 'visible' }}>
        <line x1={2} y1={6} x2={42} y2={6} stroke={stroke} strokeWidth={width} strokeDasharray={dashArray} opacity={opacity} />
    </svg>
);

/** The same badge the canvas draws, fed one finding of each severity. */
const SAMPLE_FINDINGS: Finding[] = (['warning', 'info'] as const).map((severity) => makeFinding({
    ruleId: `legend-${severity}`,
    severity,
    subject: { kind: 'graph-node', node: 'legend', graphNodeId: 'legend' },
    scope: { node: 'legend' },
    summary: '',
    evidence: [],
    remedy: { text: '', target: nodeRef('legend') },
}));

const BadgeSwatch: React.FC = () => (
    <svg width={findingsBadgeWidth(SAMPLE_FINDINGS)} height={20} aria-hidden="true" style={{ overflow: 'visible' }}>
        <FindingsBadge findings={SAMPLE_FINDINGS} x={0} y={1} />
    </svg>
);

const SELECTION_SWATCH = (
    <span
        style={{
            width: 40,
            height: 24,
            boxSizing: 'border-box',
            display: 'inline-block',
            background: SURFACE.card,
            border: `3px solid ${SURFACE.selected}`,
            borderRadius: 4,
        }}
    />
);

/** A card at the canvas's dimmed opacity. */
const dimmedSwatch = (accent: string, icon: React.ReactNode) => (
    <span style={{ opacity: 0.3, display: 'inline-flex' }}>
        <CardSwatch accent={accent} icon={icon} />
    </span>
);

const STATUS_DESCRIPTIONS: Record<NodeStatus, string> = {
    up: 'nmstate reports the device up.',
    down: 'nmstate reports the device down. Whether that matters is a finding\'s call: an unused NIC is often down on purpose.',
    unknown: 'nmstate reports ignore, absent or unknown: not managed, not a fault.',
};

/** Legend for the physical node graph. */
export const PhysicalLegend: React.FC = () => (
    <div data-testid="physical-legend">
        <Section title="Node kinds" testId="legend-node-kinds">
            {NODE_TYPES.map((descriptor) => (
                <Entry
                    key={descriptor.type}
                    entry={`node:${descriptor.type}`}
                    swatch={<CardSwatch accent={descriptor.color} icon={descriptor.icon} />}
                    label={descriptor.legend.label}
                    description={descriptor.legend.description}
                />
            ))}
        </Section>
        <Section title="Lines" testId="legend-edge-kinds">
            {(Object.keys(EDGE_KIND_STYLES) as EdgeKind[]).map((kind) => (
                <Entry
                    key={kind}
                    entry={`edge:${kind}`}
                    swatch={<LineSwatch dashArray={EDGE_KIND_STYLES[kind].dashArray} opacity={EDGE_KIND_STYLES[kind].opacity} />}
                    label={EDGE_KIND_STYLES[kind].label}
                    description={EDGE_KIND_STYLES[kind].description}
                />
            ))}
            <Entry
                entry="edge:highlight"
                swatch={<LineSwatch stroke={SURFACE.flow} width={4} />}
                label="Selected path"
                description="Everything the selected node connects to, end to end. The rest of the graph fades."
            />
        </Section>
        <Section title="Provenance" testId="legend-provenance">
            {(Object.keys(PROVENANCE_STYLES) as Provenance[]).map((provenance) => (
                <Entry
                    key={provenance}
                    entry={`provenance:${provenance}`}
                    swatch={<LineSwatch opacity={PROVENANCE_STYLES[provenance].opacity ?? 1} />}
                    label={(
                        <>
                            {PROVENANCE_STYLES[provenance].label}
                            <ProvenanceLabel provenance={provenance} hint={PROVENANCE_STYLES[provenance].description} />
                        </>
                    )}
                    description={PROVENANCE_STYLES[provenance].description}
                />
            ))}
        </Section>
        <Section title="State and findings" testId="legend-status">
            {(Object.keys(STATUS_STYLE) as NodeStatus[]).map((status) => (
                <Entry
                    key={status}
                    entry={`status:${status}`}
                    swatch={<NodeStatusIcon status={status} />}
                    label={STATUS_STYLE[status].label}
                    description={STATUS_DESCRIPTIONS[status]}
                />
            ))}
            <Entry
                entry="findings-badge"
                swatch={<BadgeSwatch />}
                label="Findings"
                description="Warnings and info findings on the node, counted. Select the node to read them."
            />
            <Entry entry="selected" swatch={SELECTION_SWATCH} label="Selected or focused" />
            <Entry
                entry="dimmed"
                swatch={dimmedSwatch(NODE_TYPES[0].color, NODE_TYPES[0].icon)}
                label="Off the selected path"
                description="Faded while a node is selected. Keyboard focus brings a faded node back to full strength."
            />
        </Section>
    </div>
);

/** A network band in miniature: the tint, the outline and the header swatch. */
const BandSwatch: React.FC<{ color: string }> = ({ color }) => (
    <svg width={40} height={24} aria-hidden="true">
        <rect x={0.5} y={0.5} width={39} height={23} rx={4} fill={color} fillOpacity={0.07} stroke={color} strokeOpacity={0.35} />
        <rect x={6} y={7} width={10} height={10} rx={2} fill={color} />
    </svg>
);

/** Every construct role, in the order the ladder reads them. */
const ROLE_ORDER = Object.keys(ROLE_DESCRIPTIONS) as ConstructRole[];

const isRouterRole = (role: ConstructRole): boolean => /router$/.test(role);

/** Legend for the logical ladder (node and cluster views). */
export const LogicalLegend: React.FC = () => (
    <div data-testid="logical-legend">
        <Section title="Constructs" testId="legend-roles">
            {ROLE_ORDER.map((role) => (
                <Entry
                    key={role}
                    entry={`role:${role}`}
                    swatch={(
                        <CardSwatch
                            accent={SURFACE.subtleText}
                            border={SURFACE.subtleText}
                            radius={constructCornerRadius(isRouterRole(role) ? 'router' : 'switch')}
                            icon={roleIcon(role)}
                        />
                    )}
                    label={roleLabel(role)}
                    description={`${ROLE_DESCRIPTIONS[role]}${isRouterRole(role) ? ' Routers are pill-shaped.' : ''}`}
                />
            ))}
            <Entry
                entry="aggregate"
                swatch={<CardSwatch accent={SURFACE.subtleText} border={SURFACE.subtleText} dashed icon={<span style={{ fontSize: 10, fontWeight: 700 }}>3×</span>} />}
                label="Group"
                description="Several constructs of one role, folded. Select it to expand."
            />
        </Section>
        <Section title="Lines" testId="legend-ladder-edges">
            {(Object.keys(LADDER_EDGE_STYLES) as LadderEdgeKind[]).map((kind) => (
                <Entry
                    key={kind}
                    entry={`ladder-edge:${kind}`}
                    swatch={<LineSwatch dashArray={LADDER_EDGE_STYLES[kind].dashArray} width={1.5} />}
                    label={LADDER_EDGE_STYLES[kind].label}
                    description={LADDER_EDGE_STYLES[kind].description}
                />
            ))}
        </Section>
        <Section title="Networks" testId="legend-bands">
            <Entry
                entry="band:default"
                swatch={<BandSwatch color={NETWORK_SLOTS[0].css} />}
                label="Default cluster network"
                description="Always neutral gray."
            />
            <Entry
                entry="band:others"
                swatch={(
                    <span style={{ display: 'inline-flex', gap: 2 }}>
                        {NETWORK_SLOTS.slice(1).map((slot) => (
                            <span key={slot.name} title={slot.name} style={{ width: 6, height: 24, background: slot.css, borderRadius: 1 }} />
                        ))}
                    </span>
                )}
                label="Every other network"
                description="One of six colours, chosen by the network's name, so it keeps its colour when you filter. A colour names a network; it never means healthy or failing."
            />
            <Entry entry="selected" swatch={SELECTION_SWATCH} label="Selected" description="Ringed, with a halo." />
            <Entry
                entry="dimmed"
                swatch={dimmedSwatch(SURFACE.subtleText, roleIcon('node-switch'))}
                label="Not a search match"
                description="Faded while a search is active."
            />
        </Section>
    </div>
);

/**
 * The toolbar's Legend button. A Popover, so the canvas keeps its full width; Escape
 * or a click outside closes it.
 */
export const LegendButton: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <Popover
        aria-label="Legend"
        headerContent="Legend"
        bodyContent={<div style={{ maxHeight: '65vh', overflowY: 'auto' }}>{children}</div>}
        position="bottom-end"
        minWidth="min(38rem, 90vw)"
        maxWidth="min(60rem, 90vw)"
    >
        <Button variant="link">Legend</Button>
    </Popover>
);
