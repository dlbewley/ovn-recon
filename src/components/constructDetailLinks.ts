import { constructDetailPath } from '../routes';
import type { DetailLinkOptions } from '../routes';
import { LadderConstruct } from './logicalLadderModel';

/**
 * Addresses of the construct detail page (ovn-recon-e2b.8):
 *
 *   /ovn-recon/ovn/:node/:kind/:name?tab=&q=&port=   (built in src/routes.ts)
 *
 * `node` is the zone whose northbound database the page shows, `kind` is
 * LadderConstruct.kind (switch or router; bridge mappings are synthesized and
 * have no page) and `name` the OVN row name. The query parameters are all
 * optional: the tab, the active tab's text filter, and one Logical_Switch_Port
 * name (expanded on the Ports tab).
 */

/**
 * What every drawer link to this page is called (ovn-recon-dp7.12), whichever tab it
 * sits on: one label, so the same destination never reads as two different things.
 */
export const OPEN_FULL_PAGE = 'Open full page';

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

export type { DetailLinkOptions } from '../routes';
export { constructDetailPath, detailSearch } from '../routes';

/**
 * The name of the same construct in another node's zone. OVN-Kubernetes names
 * per-node constructs after their node: the node switch (`cnv-1`), the
 * external switch (`ext_cnv-1`), the gateway router (`GR_cnv-1`) and their
 * user-defined-network counterparts (`ext_<network>_cnv-1`,
 * `GR_<network>_cnv-1`, `<network>_cnv-1`). Those names follow the node;
 * cluster-wide names (`join`, `transit_switch`, `ovn_cluster_router`, ...)
 * are the same in every zone and are returned unchanged.
 */
export const constructNameForNode = (name: string, fromNode: string, toNode: string): string => {
    if (!fromNode || fromNode === toNode) return name;
    if (name === fromNode) return toNode;
    const suffix = `_${fromNode}`;
    if (name.endsWith(suffix)) return `${name.slice(0, -suffix.length)}_${toNode}`;
    return name;
};

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

/** The node ladder and the cluster ladder, opened on a construct. */
export { clusterLogicalPath as clusterLadderPath, nodeLogicalPath as nodeLadderPath } from '../routes';

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
