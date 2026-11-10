import * as React from 'react';
import { useLocation, useNavigate } from 'react-router';

import { LadderConstruct, LadderModel } from './logicalLadderModel';

/**
 * Deep-linkable selection for the three graph pages (ovn-recon-s3t.16).
 *
 * One query parameter, `select`, carries whatever the page's drawer is showing:
 *
 *   physical view      select=<canonical node id>   e.g. select=vrf:blue, select=udn:ns1/blue
 *   both ladder views  select=KIND:NAME             e.g. select=switch:join, select=router:GR_node-1
 *
 * KIND on the ladder is LadderConstruct.kind (switch, router, or physnet for a
 * bridge mapping) and NAME the OVN row name, the same pair the construct detail
 * page uses in its route (ovn-recon-e2b.8, decision 8).
 *
 * The parameter is written with replace, never push, so the Back button leaves
 * the page instead of stepping back through selections, and it is removed when
 * the drawer closes. Every other query parameter is kept exactly as it was.
 */

export const SELECT_PARAM = 'select';

const decodeComponent = (value: string): string => {
    try {
        return decodeURIComponent(value.replace(/\+/g, ' '));
    } catch {
        return value;
    }
};

/** The select value in a search string, or null when absent or empty. */
export const readSelectParam = (search: string): string | null =>
    new URLSearchParams(search).get(SELECT_PARAM) || null;

/**
 * Percent-encode a select value, leaving `:` and `/` readable: both are legal in
 * a query (RFC 3986 section 3.4) and they are the separators of every id we write.
 */
export const encodeSelectValue = (value: string): string =>
    encodeURIComponent(value).replace(/%3A/gi, ':').replace(/%2F/gi, '/');

/**
 * The search string with select set to value, or removed when value is null.
 * Other parameters keep their order and their exact encoding, and an existing
 * select keeps its position; works on the raw pairs rather than through
 * URLSearchParams, which would re-encode everything it touches.
 */
export const withSelectParam = (search: string, value: string | null): string => {
    const pairs = search.replace(/^\?/, '').split('&').filter(Boolean);
    const isSelect = (pair: string) => decodeComponent(pair.split('=')[0]) === SELECT_PARAM;
    const position = pairs.findIndex(isSelect);
    const kept = pairs.filter((pair) => !isSelect(pair));
    if (value !== null) {
        const pair = `${SELECT_PARAM}=${encodeSelectValue(value)}`;
        // Every pair before the first select survives the filter, so the index
        // is the same in the filtered list.
        if (position >= 0) kept.splice(position, 0, pair);
        else kept.push(pair);
    }
    return kept.length > 0 ? `?${kept.join('&')}` : '';
};

export interface SelectionDeepLink<T> {
    /** The page's current selection, or null when the drawer is closed. */
    selected: T | null;
    /** The URL value for a selection. */
    encode: (selection: T) => string;
    /**
     * The selection a URL value names in the page's current model, or null when
     * the model does not (yet) contain it. Called whenever a value is pending, so
     * it can answer from whatever the page has loaded so far.
     */
    resolve: (value: string) => T | null;
    /** Select, open the drawer and reveal: the page's own drawer-navigation path. */
    apply: (selection: T) => void;
}

/**
 * Keep a page's selection and the `select` query parameter in step.
 *
 * - A value in the URL on mount, or arriving later from a navigation this hook
 *   did not make, is pending until the first model that contains it; then it is
 *   applied once. A value no model contains stays pending, which only means it
 *   is ignored: nothing errors, and the user's next selection replaces it.
 * - While nothing is pending, every selection change is mirrored into the URL
 *   with replace, and closing the drawer removes the parameter.
 */
export const useSelectionDeepLink = <T>({ selected, encode, resolve, apply }: SelectionDeepLink<T>): void => {
    const location = useLocation();
    const navigate = useNavigate();
    const urlValue = readSelectParam(location.search);

    const [pending, setPending] = React.useState<string | null>(urlValue);

    // The location as this hook last saw or wrote it; a difference is a
    // navigation someone else made.
    const observed = React.useRef({ pathname: location.pathname, value: urlValue });

    // The value of the current selection, as the URL would carry it.
    const selectedValue = selected === null ? null : encode(selected);

    // The user picking something while a link is pending wins over the link.
    const previousSelectedValue = React.useRef(selectedValue);
    React.useEffect(() => {
        if (selectedValue !== previousSelectedValue.current && selectedValue !== null) {
            setPending(null);
        }
        previousSelectedValue.current = selectedValue;
    }, [selectedValue]);

    React.useEffect(() => {
        const seen = observed.current;
        if (location.pathname !== seen.pathname || urlValue !== seen.value) {
            // Someone else navigated: a new select is a request; anything else
            // is left alone rather than overwritten with a selection that may
            // belong to the page we just left.
            observed.current = { pathname: location.pathname, value: urlValue };
            if (urlValue !== null) setPending(urlValue);
            return;
        }
        if (pending !== null || selectedValue === urlValue) return;
        observed.current = { pathname: location.pathname, value: selectedValue };
        navigate(
            {
                pathname: location.pathname,
                search: withSelectParam(location.search, selectedValue),
                hash: location.hash,
            },
            { replace: true, state: location.state },
        );
    }, [location, urlValue, pending, selectedValue, navigate]);

    // No dependency list: resolve answers from the page's latest model, and the
    // guard makes this a no-op whenever nothing is pending.
    React.useEffect(() => {
        if (pending === null) return;
        const target = resolve(pending);
        if (target === null) return;
        setPending(null);
        apply(target);
    });
};

/* Ladder selection values: KIND:NAME. */

const LADDER_KINDS: ReadonlySet<string> = new Set<LadderConstruct['kind']>(['switch', 'router', 'physnet']);

/** The select value for a ladder construct. */
export const constructSelectValue = (construct: Pick<LadderConstruct, 'kind' | 'name'>): string =>
    `${construct.kind}:${construct.name}`;

/** Split a KIND:NAME value; null for an unknown kind or an empty name. */
export const parseConstructSelectValue = (
    value: string,
): { kind: LadderConstruct['kind']; name: string } | null => {
    const separator = value.indexOf(':');
    if (separator <= 0) return null;
    const kind = value.slice(0, separator);
    const name = value.slice(separator + 1);
    if (!LADDER_KINDS.has(kind) || name === '') return null;
    return { kind: kind as LadderConstruct['kind'], name };
};

/**
 * The construct a KIND:NAME value names. When two constructs share a kind and
 * name (two networks with the same bridge-mapping name on the cluster page),
 * the first in model order wins.
 */
export const findConstructBySelectValue = (model: LadderModel, value: string): LadderConstruct | null => {
    const parsed = parseConstructSelectValue(value);
    if (!parsed) return null;
    return model.constructs.find(
        (construct) => construct.kind === parsed.kind && construct.name === parsed.name,
    ) ?? null;
};
