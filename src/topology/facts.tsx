import * as React from 'react';
import {
    DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm, Label
} from '@patternfly/react-core';

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

const renderItem = (item: FactItem) => {
    const href = item.ref ? getResourcePath(item.ref) : item.href;
    return href
        ? <a href={href} className="pf-v6-c-button pf-m-link pf-m-inline">{item.text}</a>
        : item.text;
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
            return (
                <KernelRouteTable
                    routes={table.routes}
                    viaInterface={table.viaInterface}
                    selectInterface={hooks.selectInterface}
                    ariaLabel={fact.label}
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
            : fact.value;
    }
    if (fact.value.length === 0) {
        return <span style={subtle}>{fact.emptyText}</span>;
    }
    return (
        <ul className="pf-v6-c-list">
            {fact.value.map((item) => <li key={item.text}>{renderItem(item)}</li>)}
        </ul>
    );
};

/**
 * An inferred value must say so: the chip flags the claim and its tooltip names
 * the rule that produced it, turning a heuristic from a liability into a feature.
 * Observed and declared values stay unadorned -- chips everywhere would say nothing.
 * Shared with the Relationships tab so facts and edges wear the same mark.
 */
export const ProvenanceLabel: React.FC<{ provenance: Provenance; hint?: string }> = ({ provenance, hint }) => (
    provenance === 'inferred'
        ? (
            <Label isCompact color="orange" title={hint} style={{ marginLeft: '0.5em' }}>
                inferred
            </Label>
        )
        : null
);

const FactGroup: React.FC<{ fact: Fact; hooks: FactRenderHooks }> = ({ fact, hooks }) => (
    <DescriptionListGroup>
        <DescriptionListTerm>
            <span title={fact.hint}>{fact.label}</span>
            <ProvenanceLabel provenance={fact.provenance} hint={fact.hint} />
        </DescriptionListTerm>
        <DescriptionListDescription>{renderValue(fact, hooks)}</DescriptionListDescription>
    </DescriptionListGroup>
);

/** Facts with no value are the builder's way of saying "not applicable here". */
const isRenderable = (fact: Fact): boolean => {
    if (typeof fact.value === 'string') return fact.value.length > 0;
    const size = isFactTable(fact.value) ? fact.value.routes.length : fact.value.length;
    return size > 0 || Boolean(fact.emptyText);
};

export const FactList: React.FC<{ facts: Fact[] } & FactRenderHooks> = ({ facts, ...hooks }) => (
    <DescriptionList isCompact>
        {facts.filter(isRenderable).map((fact) => <FactGroup key={fact.label} fact={fact} hooks={hooks} />)}
    </DescriptionList>
);
