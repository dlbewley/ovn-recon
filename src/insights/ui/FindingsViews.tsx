import * as React from 'react';
import { Icon, Switch, Title } from '@patternfly/react-core';
import { ExclamationTriangleIcon, ExternalLinkAltIcon, InfoCircleIcon } from '@patternfly/react-icons';
import { Link } from 'react-router';

import { consoleHrefForRef, refLabel } from '../links';
import { countBySeverity, highestSeverity, SeverityCounts } from '../selectors';
import type { Evidence, Finding, Severity } from '../types';
import { InferredLabel } from '../../components/drawerKit';

/**
 * Severity presentation shared by every findings surface (ovn-recon-7i6.1).
 *
 * PatternFly status colours only, through the Icon component's `status`: warning is
 * the triangle, info the circle -- never a triangle for info. Info findings are drawn
 * subdued (subtle text, no emphasis) so they never compete with a warning.
 */

const subtle: React.CSSProperties = { color: 'var(--pf-t--global--text--color--subtle)' };

export const SeverityIcon: React.FC<{ severity: Severity; size?: 'sm' | 'md' }> = ({ severity, size = 'sm' }) => (
    <Icon status={severity} size={size} isInline>
        {severity === 'warning' ? <ExclamationTriangleIcon /> : <InfoCircleIcon />}
    </Icon>
);

const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
    `${count} ${count === 1 ? singular : pluralForm}`;

/** "1 warning", "2 warnings, 1 info finding", or "no findings". */
export const describeCounts = (counts: SeverityCounts): string => {
    const parts = [
        ...(counts.warning > 0 ? [plural(counts.warning, 'warning')] : []),
        ...(counts.info > 0 ? [plural(counts.info, 'info finding')] : [])
    ];
    return parts.length > 0 ? parts.join(', ') : 'no findings';
};

/**
 * Counts by severity as icon-and-number pairs, warnings first. Renders nothing for
 * no findings, so a caller decides what an empty cell says.
 */
export const SeverityCountsInline: React.FC<{ counts: SeverityCounts }> = ({ counts }) => {
    if (counts.total === 0) return null;
    return (
        <span style={{ display: 'inline-flex', gap: '0.75em', alignItems: 'center' }}>
            {counts.warning > 0 && (
                <span data-testid="count-warning">
                    <SeverityIcon severity="warning" /> {counts.warning}
                </span>
            )}
            {counts.info > 0 && (
                <span data-testid="count-info" style={subtle}>
                    <SeverityIcon severity="info" /> {counts.info}
                </span>
            )}
        </span>
    );
};

/**
 * The one "Hide info findings" toggle. Shown only when there is an info finding to
 * hide, so it never appears as an unexplained control.
 */
export const HideInfoSwitch: React.FC<{
    id: string;
    findings: Finding[];
    hideInfo: boolean;
    onChange: (hide: boolean) => void;
}> = ({ id, findings, hideInfo, onChange }) => {
    if (!findings.some((finding) => finding.severity === 'info')) return null;
    return (
        <Switch
            id={id}
            label="Hide info findings"
            isChecked={hideInfo}
            onChange={(_event, checked) => onChange(checked)}
        />
    );
};

const MAX_SOURCES = 3;

/**
 * Where one evidence line was read from, with each object linked to its console page,
 * or, for a fact read from a collector snapshot, which node's database.
 */
const EvidenceProvenance: React.FC<{ evidence: Evidence }> = ({ evidence }) => {
    const shown = evidence.sources.slice(0, MAX_SOURCES);
    const more = evidence.sources.length - shown.length;
    const origin = shown.length === 0 ? evidence.origin : undefined;
    if (shown.length === 0 && !origin && !evidence.path) return null;
    return (
        <div style={{ ...subtle, fontSize: '0.85em' }} data-testid="finding-provenance">
            {shown.length > 0 && <>From </>}
            {shown.map((source, index) => (
                <React.Fragment key={`${source.kind}/${source.namespace ?? ''}/${source.name}`}>
                    {index > 0 && ', '}
                    <a href={consoleHrefForRef(source)}>{refLabel(source)}</a>
                </React.Fragment>
            ))}
            {more > 0 && <> and {more} more</>}
            {origin && <>From {origin}</>}
            {evidence.path && (
                <>
                    {shown.length > 0 || origin ? ', field ' : 'Field '}
                    <code>{evidence.path}</code>
                </>
            )}
        </div>
    );
};

const FindingEntry: React.FC<{ finding: Finding }> = ({ finding }) => {
    const isInfo = finding.severity === 'info';
    return (
        <li
            data-testid="finding"
            data-severity={finding.severity}
            data-rule={finding.ruleId}
            style={{ marginBottom: 'var(--pf-t--global--spacer--md)', ...(isInfo ? subtle : {}) }}
        >
            <div style={{ display: 'flex', gap: '0.5em', alignItems: 'baseline' }}>
                <SeverityIcon severity={finding.severity} />
                <span style={{ fontWeight: isInfo ? 'normal' : 'bold' }}>{finding.summary}</span>
            </div>
            {finding.evidence.length > 0 && (
                <ul style={{ margin: '0.25em 0 0 1.5em', listStyle: 'disc' }} aria-label="Evidence">
                    {finding.evidence.map((evidence, index) => (
                        <li key={`${index}-${evidence.fact}`}>
                            {evidence.fact}
                            {evidence.inferred && (
                                <InferredLabel />
                            )}
                            {evidence.inferred && (
                                <div style={{ ...subtle, fontSize: '0.85em' }}>Inferred: {evidence.inferred}</div>
                            )}
                            <EvidenceProvenance evidence={evidence} />
                        </li>
                    ))}
                </ul>
            )}
            <div style={{ margin: '0.25em 0 0 1.5em' }} data-testid="finding-remedy">
                <strong>Remedy:</strong> {finding.remedy.text}{' '}
                {finding.remedy.verb === 'view' ? (
                    <a href={consoleHrefForRef(finding.remedy.target)}>View {refLabel(finding.remedy.target)}</a>
                ) : (
                    <a href={consoleHrefForRef(finding.remedy.target, true)}>
                        Edit {refLabel(finding.remedy.target)}
                    </a>
                )}
                {finding.remedy.path && <> (field <code>{finding.remedy.path}</code>)</>}
                {finding.docsUrl && (
                    <>
                        {' · '}
                        <a href={finding.docsUrl} target="_blank" rel="noopener noreferrer">
                            Documentation <ExternalLinkAltIcon />
                        </a>
                    </>
                )}
            </div>
        </li>
    );
};

/**
 * The drawer's Findings section: each finding's summary, its evidence with where each
 * fact was read from, and the remedy with a link to the object to edit. Renders
 * nothing at all when there are none -- no heading, no "all clear".
 */
export const FindingsSection: React.FC<{ findings: Finding[] }> = ({ findings }) => {
    if (findings.length === 0) return null;
    const counts = countBySeverity(findings);
    return (
        <section
            aria-label="Findings"
            data-testid="drawer-findings"
            style={{
                marginBottom: 'var(--pf-t--global--spacer--lg)',
                paddingBottom: 'var(--pf-t--global--spacer--md)',
                borderBottom: '1px solid var(--pf-t--global--border--color--default)'
            }}
        >
            <Title headingLevel="h3" size="md" style={{ marginBottom: 'var(--pf-t--global--spacer--sm)' }}>
                Findings <span style={{ ...subtle, fontWeight: 'normal' }}>({describeCounts(counts)})</span>
            </Title>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {findings.map((finding) => <FindingEntry key={finding.key} finding={finding} />)}
            </ul>
        </section>
    );
};

const BADGE_HEIGHT = 18;
const BADGE_SEGMENT_WIDTH = 30;

/** The badge's width for these findings, so a caller can right-align it. */
export const findingsBadgeWidth = (findings: Finding[]): number => {
    const counts = countBySeverity(findings);
    return (counts.warning > 0 ? BADGE_SEGMENT_WIDTH : 0) + (counts.info > 0 ? BADGE_SEGMENT_WIDTH : 0);
};

/**
 * The graph decorator: a pill straddling a node's top edge with the warning and info
 * counts. Purely decorative over the node, which carries the same text in its own
 * accessible name; it is drawn after the node's content and changes no geometry the
 * layout reads. Renders nothing for no findings.
 */
export const FindingsBadge: React.FC<{ findings: Finding[]; x: number; y: number }> = ({ findings, x, y }) => {
    const counts = countBySeverity(findings);
    if (counts.total === 0) return null;
    const width = findingsBadgeWidth(findings);
    const label = describeCounts(counts);
    const worst = highestSeverity(findings);
    return (
        <g
            transform={`translate(${x}, ${y})`}
            data-testid="findings-badge"
            data-severity={worst}
            aria-label={label}
            role="img"
        >
            <title>{label}</title>
            <foreignObject width={width} height={BADGE_HEIGHT} style={{ overflow: 'visible' }}>
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-around',
                        height: BADGE_HEIGHT,
                        boxSizing: 'border-box',
                        borderRadius: BADGE_HEIGHT / 2,
                        border: '1px solid var(--pf-t--global--border--color--default)',
                        background: 'var(--pf-t--global--background--color--primary--default)',
                        color: 'var(--pf-t--global--text--color--regular)',
                        fontSize: 11,
                        lineHeight: 1
                    }}
                >
                    {counts.warning > 0 && (
                        <span><SeverityIcon severity="warning" /> {counts.warning}</span>
                    )}
                    {counts.info > 0 && (
                        <span style={subtle}><SeverityIcon severity="info" /> {counts.info}</span>
                    )}
                </div>
            </foreignObject>
        </g>
    );
};

/** A link to a finding's subject: a route inside the plugin, or a console page. */
export const FindingSubjectAnchor: React.FC<{ to?: string; href?: string; children: React.ReactNode }> = ({ to, href, children }) => {
    if (to) return <Link to={to}>{children}</Link>;
    if (href) return <a href={href}>{children}</a>;
    return <>{children}</>;
};
