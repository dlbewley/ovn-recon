import * as React from 'react';

import {
    CopyValue, FactRow, FactRows, InferredLabel, InfoPopover, isCopyableAddress, ValueList, WideFactRow
} from '../components/drawerKit';
import { InterfaceSelector, KernelRouteTable } from '../components/KernelRouteTable';
import { getResourcePath } from './links';
import { Fact, FactItem, FactTable, NodeViewModel, Provenance } from './types';

/**
 * The one renderer for drawer facts (ovn-recon-s3t.12).
 *
 * Every node kind used to carry its own DescriptionList JSX -- ~500 lines written
 * against `any`, none of it testable. Kinds now return Fact[] from a pure function
 * and this renders them all, so presentation decisions are made exactly once.
 */

/**
 * Type and State rows, shared by most kinds. When the kind maps to an API
 * resource, `typeHref` links the Type value to its api-resource reference page.
 */
export const baseFacts = (
    node: NodeViewModel,
    provenance: Provenance = 'observed',
    typeHref?: string
): Fact[] => [
    {
        label: 'Type',
        value: typeHref ? [{ text: node.subtitle, href: typeHref }] : node.subtitle,
        provenance
    },
    ...(node.state
        ? [{ label: 'State', value: node.state, provenance } as Fact]
        : [])
];

const subtle: React.CSSProperties = { color: 'var(--pf-t--global--text--color--subtle)' };

/** A single address gets a copy button; any other text renders as it is. */
const renderText = (text: string): React.ReactNode =>
    isCopyableAddress(text) ? <CopyValue value={text} /> : text;

const renderItem = (item: FactItem) => {
    const href = item.ref ? getResourcePath(item.ref) : item.href;
    const main = href
        ? <a href={href} className="pf-v6-c-button pf-m-link pf-m-inline">{item.text}</a>
        : renderText(item.text);
    if (!item.detail) return main;
    return (
        <>
            {main}
            <div style={{ ...subtle, fontSize: '0.9em' }} data-testid="fact-item-detail">
                {isCopyableAddress(item.detail)
                    ? <CopyValue value={item.detail} />
                    : item.detail.startsWith('(') ? item.detail : <code>{item.detail}</code>}
            </div>
        </>
    );
};

/** A table value is an object; a list is an array; anything else is text. */
export const isFactTable = (value: Fact['value']): value is FactTable =>
    typeof value === 'object' && !Array.isArray(value);

/**
 * What a table-valued fact may need from the view drawing it. Optional: the
 * same facts render with plain names where nothing can be selected.
 */
export interface FactRenderHooks {
    selectInterface?: InterfaceSelector;
}

const renderTable = (fact: Fact, table: FactTable, hooks: FactRenderHooks) => {
    switch (table.table) {
        case 'kernel-routes':
            // The physical drawer is narrow (ovn-recon-dp7.9 item 2): the
            // table keeps Destination, Gateway and Interface and folds the
            // rest into each row's expansion.
            return (
                <KernelRouteTable
                    routes={table.routes}
                    viaInterface={table.viaInterface}
                    selectInterface={hooks.selectInterface}
                    ariaLabel={fact.label}
                    narrow
                />
            );
    }
};

const renderValue = (fact: Fact, hooks: FactRenderHooks) => {
    if (isFactTable(fact.value)) {
        return fact.value.routes.length === 0
            ? <span style={subtle}>{fact.emptyText}</span>
            : renderTable(fact, fact.value, hooks);
    }
    if (typeof fact.value === 'string') {
        return fact.ref
            ? <a href={getResourcePath(fact.ref)} className="pf-v6-c-button pf-m-link pf-m-inline">{fact.value}</a>
            : renderText(fact.value);
    }
    if (fact.value.length === 0) {
        return <span style={subtle}>{fact.emptyText}</span>;
    }
    // One item is a value, not a one-item bullet list (ovn-recon-dp7.1).
    return <ValueList items={fact.value.map((item) => renderItem(item))} />;
};

/**
 * An inferred value must say so: the chip flags the claim and the info button
 * beside it names the rule that produced it, turning a heuristic from a
 * liability into a feature. Observed and declared values stay unadorned --
 * chips everywhere would say nothing. Shared with the Relationships tab and
 * the network pages so facts and edges wear the same mark.
 */
export const ProvenanceLabel: React.FC<{ provenance: Provenance; hint?: string; subject?: string }> = ({
    provenance,
    hint,
    subject = 'this inference'
}) => (
    provenance === 'inferred'
        ? (
            <>
                <InferredLabel />
                {hint && <InfoPopover subject={subject} hint={hint} header="Inferred" />}
            </>
        )
        : null
);

/** Facts with no value are the builder's way of saying "not applicable here". */
const isRenderable = (fact: Fact): boolean => {
    if (typeof fact.value === 'string') return fact.value.length > 0;
    const size = isFactTable(fact.value) ? fact.value.routes.length : fact.value.length;
    return size > 0 || Boolean(fact.emptyText);
};

/**
 * One line per fact (ovn-recon-dp7.1): a horizontal description list with a
 * fixed term width, the hint behind an info button. A table-valued fact
 * takes the full width under its term.
 */
export const FactList: React.FC<{ facts: Fact[] } & FactRenderHooks> = ({ facts, ...hooks }) => (
    <FactRows ariaLabel="Facts">
        {facts.filter(isRenderable).map((fact) => {
            const Row = isFactTable(fact.value) && fact.value.routes.length > 0 ? WideFactRow : FactRow;
            return (
                <Row
                    key={fact.label}
                    term={fact.label}
                    hint={fact.hint}
                    inferred={fact.provenance === 'inferred'}
                >
                    {renderValue(fact, hooks)}
                </Row>
            );
        })}
    </FactRows>
);
