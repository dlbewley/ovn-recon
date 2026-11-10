import * as React from 'react';
import { Link } from 'react-router';
import {
    Button,
    ClipboardCopy,
    DescriptionList,
    DescriptionListDescription,
    DescriptionListGroup,
    DescriptionListTerm,
    ExpandableSection,
    Label,
    LabelGroup,
    Popover,
    Title,
} from '@patternfly/react-core';
import { OutlinedQuestionCircleIcon } from '@patternfly/react-icons';

/**
 * The drawer layout kit (ovn-recon-dp7.1): the pieces both detail drawers,
 * physical and logical, are built from, so the two read the same.
 *
 *   DrawerIdentity     name, kind, state and the context chips that link
 *   FactRows/FactRow   one line per fact: a horizontal, compact description
 *                      list with a fixed term width
 *   WideFactRow        a fact whose value is a table: the term above, the
 *                      table across the full width
 *   InfoPopover        an explanation on an info button, never a title=
 *   CopyValue          a single value with a compact copy button
 *   IdentifiersSection UUIDs and raw names, collapsed by default
 */

const SUBTLE: React.CSSProperties = { color: 'var(--pf-t--global--text--color--subtle)' };

/**
 * The term column's width. Wide enough for most terms on one line; at the
 * physical drawer's default width (about 355px of body) it leaves about 180px
 * for the value, and long terms wrap rather than squeeze the value.
 */
export const FACT_TERM_WIDTH = '9rem';

/**
 * The description column must be allowed to shrink below its content's
 * min-content width, or one long token (a patch port name, a UUID) widens
 * the grid past the drawer and forces sideways scrolling.
 */
const FACT_LIST_STYLE = {
    '--pf-v6-c-description-list--m-horizontal__description--width': 'minmax(0, 1fr)',
} as React.CSSProperties;

/** A group whose term sits above its value and whose value spans the list. */
const WIDE_GROUP_STYLE = {
    '--pf-v6-c-description-list__group--GridTemplateColumns': 'minmax(0, 1fr)',
} as React.CSSProperties;

/** Long tokens wrap anywhere rather than widen the drawer. */
export const WRAP_ANYWHERE: React.CSSProperties = { overflowWrap: 'anywhere' };

/**
 * An explanation behind an info button. The button is a real button, so it
 * is reached by Tab and opened by Enter or Space, and by touch; a title=
 * attribute is none of those. The text is shown as given.
 */
export const InfoPopover: React.FC<{
    /** What the button explains, for its accessible name: "More about <subject>". */
    subject: string;
    hint: React.ReactNode;
    header?: React.ReactNode;
}> = ({ subject, hint, header }) => (
    <Popover
        headerContent={header}
        bodyContent={<div style={WRAP_ANYWHERE}>{hint}</div>}
        aria-label={`About ${subject}`}
    >
        <Button
            variant="plain"
            hasNoPadding
            aria-label={`More about ${subject}`}
            icon={<OutlinedQuestionCircleIcon />}
            style={{ marginInlineStart: '0.25em', verticalAlign: 'baseline' }}
            data-testid="info-popover"
        />
    </Popover>
);

/**
 * The provenance chip. An inferred value must say so; observed and declared
 * values stay unadorned, as chips everywhere would say nothing. The rule that
 * produced the claim is in the row's InfoPopover, not in a tooltip here.
 */
export const InferredLabel: React.FC = () => (
    <Label isCompact color="orange" style={{ marginInlineStart: '0.5em' }} data-testid="inferred-label">
        inferred
    </Label>
);

/** One line per fact. The children are FactRow, WideFactRow or their groups. */
export const FactRows: React.FC<{ children: React.ReactNode; ariaLabel?: string; testId?: string }> = ({
    children,
    ariaLabel,
    testId,
}) => (
    <DescriptionList
        isHorizontal
        isCompact
        horizontalTermWidthModifier={{ default: FACT_TERM_WIDTH }}
        style={FACT_LIST_STYLE}
        aria-label={ariaLabel}
        data-testid={testId ?? 'fact-rows'}
    >
        {children}
    </DescriptionList>
);

export interface FactRowProps {
    /** The term: text, or a link to the tab that lists the rows. */
    term: React.ReactNode;
    /** Plain-text name of the term, for the info button's accessible name. */
    termText?: string;
    /** The explanation, shown behind an info button. */
    hint?: string;
    inferred?: boolean;
    children: React.ReactNode;
    testId?: string;
}

const Term: React.FC<Omit<FactRowProps, 'children' | 'testId'>> = ({ term, termText, hint, inferred }) => (
    <DescriptionListTerm>
        {term}
        {hint && (
            <InfoPopover
                subject={termText ?? (typeof term === 'string' ? term : 'this fact')}
                hint={hint}
                header={inferred ? 'Inferred' : undefined}
            />
        )}
        {inferred && <InferredLabel />}
    </DescriptionListTerm>
);

export const FactRow: React.FC<FactRowProps> = ({ children, testId, ...term }) => (
    <DescriptionListGroup data-testid={testId}>
        <Term {...term} />
        <DescriptionListDescription style={WRAP_ANYWHERE}>{children}</DescriptionListDescription>
    </DescriptionListGroup>
);

/** A table-valued fact: in a narrow drawer a table needs the full width. */
export const WideFactRow: React.FC<FactRowProps> = ({ children, testId, ...term }) => (
    <DescriptionListGroup style={WIDE_GROUP_STYLE} data-testid={testId} data-wide="true">
        <Term {...term} />
        <DescriptionListDescription>{children}</DescriptionListDescription>
    </DescriptionListGroup>
);

/**
 * A list value: one item is a value, not a one-item bullet list; more are
 * one per line, without bullets, so they line up with the single values.
 */
export const ValueList: React.FC<{ items: React.ReactNode[]; testId?: string }> = ({ items, testId }) => {
    if (items.length === 1) return <>{items[0]}</>;
    return (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid={testId ?? 'value-list'}>
            {items.map((item, index) => <li key={index}>{item}</li>)}
        </ul>
    );
};

/**
 * A single value worth copying (an address, a UUID): the value as code and a
 * compact copy button beside it. Long values wrap inside the drawer.
 */
export const CopyValue: React.FC<{ value: string; ariaLabel?: string }> = ({ value, ariaLabel }) => (
    <ClipboardCopy
        variant="inline-compact"
        isCode
        hoverTip="Copy"
        clickTip="Copied"
        copyAriaLabel={ariaLabel ?? `Copy ${value}`}
        style={WRAP_ANYWHERE}
        data-testid="copy-value"
    >
        {value}
    </ClipboardCopy>
);

const MAC = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?$/;
const IPV6 = /^[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?:\/\d{1,3})?$/i;

/** Whether a single value is one MAC or IP address (with an optional prefix
 * length): the values that earn a copy button. */
export const isCopyableAddress = (value: string): boolean =>
    MAC.test(value) || IPV4.test(value) || IPV6.test(value);

export interface Identifier {
    label: string;
    value: string;
}

/**
 * The identifiers nobody reads first and everybody needs once: UUIDs and raw
 * names. Collapsed by default so they never push the facts down; each with a
 * copy button. Renders nothing when there is nothing to hold.
 */
export const IdentifiersSection: React.FC<{ identifiers: Identifier[] }> = ({ identifiers }) => {
    const [expanded, setExpanded] = React.useState(false);
    if (identifiers.length === 0) return null;
    return (
        <ExpandableSection
            toggleText="Identifiers"
            isExpanded={expanded}
            onToggle={(_event, value) => setExpanded(value)}
            isIndented
            className="pf-u-mt-sm"
            data-testid="identifiers"
        >
            <FactRows ariaLabel="Identifiers" testId="identifier-rows">
                {identifiers.map((identifier) => (
                    <FactRow key={identifier.label} term={identifier.label}>
                        <CopyValue value={identifier.value} ariaLabel={`Copy ${identifier.label}`} />
                    </FactRow>
                ))}
            </FactRows>
        </ExpandableSection>
    );
};

export type IdentityStatus = 'success' | 'warning' | 'danger' | 'info';

/** A context chip: what the selection belongs to, linked where a page exists. */
export interface ContextChip {
    /** What kind of context: "Node", "Network". Read out before the value. */
    kind: string;
    value: string;
    /** In-console route (react-router). */
    to?: string;
    /** Plain href, for console resource pages outside the plugin's routes. */
    href?: string;
    /** The association was inferred, not read: the chip says so. */
    inferred?: boolean;
}

export interface DrawerIdentityProps {
    name: string;
    icon?: React.ReactNode;
    /** What the selection is: "Gateway router", "OVS bridge". */
    kind?: string;
    /** Its state, as a PatternFly status label. */
    state?: { text: string; status?: IdentityStatus };
    chips?: ContextChip[];
}

const ChipLink: React.FC<{ chip: ContextChip }> = ({ chip }) => {
    const text = (
        <>
            <span style={SUBTLE}>{chip.kind}</span> {chip.value}
            {chip.inferred && <span style={SUBTLE}> · inferred</span>}
        </>
    );
    const to = chip.to;
    if (to) {
        return (
            <Label
                isCompact
                isClickable
                variant="outline"
                render={({ className, content }) => <Link to={to} className={className}>{content}</Link>}
            >
                {text}
            </Label>
        );
    }
    if (chip.href) return <Label isCompact variant="outline" href={chip.href}>{text}</Label>;
    return <Label isCompact variant="outline">{text}</Label>;
};

/**
 * The identity header both drawers open with: the name, then one line of
 * kind, state and context. Sits in the DrawerHead or right under it.
 */
export const DrawerIdentity: React.FC<DrawerIdentityProps & { headingLevel?: 'h2' | 'h3' }> = ({
    name,
    icon,
    kind,
    state,
    chips = [],
    headingLevel = 'h2',
}) => (
    <div data-testid="drawer-identity" style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', gap: '0.5em', alignItems: 'center', minWidth: 0 }}>
            {icon && <span style={{ display: 'inline-flex', flex: '0 0 auto' }}>{icon}</span>}
            <Title headingLevel={headingLevel} size="xl" style={{ minWidth: 0, ...WRAP_ANYWHERE }} data-testid="drawer-identity-name">
                {name}
            </Title>
        </div>
        {(kind || state || chips.length > 0) && (
            <LabelGroup isCompact numLabels={6} className="pf-u-mt-xs" aria-label="Identity" data-testid="drawer-identity-labels">
                {kind && <Label isCompact color="blue" data-testid="drawer-identity-kind">{kind}</Label>}
                {state && (
                    <Label
                        isCompact
                        status={state.status}
                        color={state.status ? undefined : 'grey'}
                        data-testid="drawer-identity-state"
                    >
                        {state.text}
                    </Label>
                )}
                {chips.map((chip) => <ChipLink key={`${chip.kind}:${chip.value}`} chip={chip} />)}
            </LabelGroup>
        )}
    </div>
);

/** PatternFly status for an interface's oper state, as nmstate reports it. */
export const interfaceStateStatus = (state: string | undefined): IdentityStatus | undefined => {
    switch ((state ?? '').toLowerCase()) {
        case 'up':
            return 'success';
        case 'down':
            return 'danger';
        default:
            return undefined;
    }
};
