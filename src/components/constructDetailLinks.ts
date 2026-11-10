import { LadderConstruct } from './logicalLadderModel';
import { constructSelectValue, withSelectParam } from './useSelectParam';

/**
 * Addresses of the construct detail page (ovn-recon-e2b.8):
 *
 *   /ovn-recon/ovn/:node/:kind/:name?tab=&q=&port=
 *
 * `node` is the zone whose northbound database the page shows, `kind` is
 * LadderConstruct.kind (switch or router; bridge mappings are synthesized and
 * have no page) and `name` the OVN row name. The query parameters are all
 * optional: the tab, the active tab's text filter, and one Logical_Switch_Port
 * name (expanded on the Ports tab).
 */

export const DETAIL_TABS = [
    'overview',
    'relationships',
    'ports',
    'policy',
    'services',
    'routes',
    'config',
] as const;
export type ConstructDetailTab = (typeof DETAIL_TABS)[number];

export type DetailKind = 'switch' | 'router';

export const isDetailTab = (value: string | null | undefined): value is ConstructDetailTab =>
    value != null && (DETAIL_TABS as readonly string[]).includes(value);

export const isDetailKind = (value: string | null | undefined): value is DetailKind =>
    value === 'switch' || value === 'router';

/** Switches and routers have a detail page; bridge mappings do not. */
export const hasDetailPage = (construct: Pick<LadderConstruct, 'kind'>): boolean => isDetailKind(construct.kind);

export interface DetailLinkOptions {
    tab?: ConstructDetailTab;
    q?: string;
    port?: string;
}

/** The search string for the page's own parameters; overview is the default tab. */
export const detailSearch = ({ tab, q, port }: DetailLinkOptions = {}): string => {
    const params = new URLSearchParams();
    if (tab && tab !== 'overview') params.set('tab', tab);
    if (q) params.set('q', q);
    if (port) params.set('port', port);
    const search = params.toString();
    return search ? `?${search}` : '';
};

export const constructDetailPath = (
    node: string,
    kind: DetailKind,
    name: string,
    options: DetailLinkOptions = {},
): string =>
    `/ovn-recon/ovn/${encodeURIComponent(node)}/${kind}/${encodeURIComponent(name)}${detailSearch(options)}`;

/**
 * The zone a cluster-view construct's detail link targets: the construct's
 * own node when that node is one of its zones, otherwise the first zone, the
 * representative-zone rule the drawer's Config tab uses. A filtered cluster
 * view has already narrowed `zones` to the chosen host. Undefined when the
 * construct carries no zones (it was not built from a merged model).
 */
export const detailZoneFor = (construct: Pick<LadderConstruct, 'node'> & { zones?: string[] }): string | undefined => {
    const zones = construct.zones ?? [];
    if (construct.node && zones.includes(construct.node)) return construct.node;
    return zones[0];
};

export type DetailHref = (tab?: ConstructDetailTab, options?: Omit<DetailLinkOptions, 'tab'>) => string;

/**
 * The drawer's detailHref for a construct shown from `node`'s database, or
 * undefined when the construct has no page or no zone is known.
 */
export const detailHrefFor = (
    node: string | undefined,
    construct: Pick<LadderConstruct, 'kind' | 'name'> | null | undefined,
): DetailHref | undefined => {
    if (!node || !construct || !isDetailKind(construct.kind)) return undefined;
    const kind = construct.kind;
    return (tab, options = {}) => constructDetailPath(node, kind, construct.name, { ...options, tab });
};

/** The node ladder, opened on a construct. */
export const nodeLadderPath = (node: string, construct?: Pick<LadderConstruct, 'kind' | 'name'>): string =>
    `/ovn-recon/ovn/${encodeURIComponent(node)}${construct ? withSelectParam('', constructSelectValue(construct)) : ''}`;

/** The cluster ladder, opened on a construct. */
export const clusterLadderPath = (construct?: Pick<LadderConstruct, 'kind' | 'name'>): string =>
    `/ovn-recon/ovn${construct ? withSelectParam('', constructSelectValue(construct)) : ''}`;

/**
 * The search string with `updates` applied: a null or empty value removes the
 * parameter, anything else sets it. Other parameters are kept.
 */
export const withSearchParams = (search: string, updates: Record<string, string | null | undefined>): string => {
    const params = new URLSearchParams(search);
    for (const [key, value] of Object.entries(updates)) {
        if (value == null || value === '') params.delete(key);
        else params.set(key, value);
    }
    const next = params.toString();
    return next ? `?${next}` : '';
};

/** The optional snapshot sections a tab renders. */
export const sectionsForTab = (tab: ConstructDetailTab): Array<'policy' | 'services'> => {
    switch (tab) {
        case 'ports':
        case 'policy':
            return ['policy'];
        case 'services':
            return ['services'];
        default:
            return [];
    }
};
