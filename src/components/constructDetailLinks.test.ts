import {
    clusterLadderPath,
    constructDetailPath,
    detailHrefFor,
    detailSearch,
    detailZoneFor,
    hasDetailPage,
    isDetailTab,
    nodeLadderPath,
    sectionsForTab,
    withSearchParams,
} from './constructDetailLinks';

describe('constructDetailPath', () => {
    it('puts the zone, kind and encoded name in the path and the options in the query', () => {
        expect(constructDetailPath('cnv-1', 'switch', 'cnv-1')).toBe('/ovn-recon/ovn/cnv-1/switch/cnv-1');
        expect(constructDetailPath('cnv-1', 'router', 'GR_cnv-1', { tab: 'routes' })).toBe(
            '/ovn-recon/ovn/cnv-1/router/GR_cnv-1?tab=routes',
        );
        expect(
            constructDetailPath('cnv-1', 'switch', 'cluster_udn_a.b', { tab: 'ports', q: 'virt launcher', port: 'ns_pod' }),
        ).toBe('/ovn-recon/ovn/cnv-1/switch/cluster_udn_a.b?tab=ports&q=virt+launcher&port=ns_pod');
        // A name with a character that needs it is percent-encoded.
        expect(constructDetailPath('n', 'switch', 'a/b')).toBe('/ovn-recon/ovn/n/switch/a%2Fb');
    });

    it('omits the default tab', () => {
        expect(detailSearch({ tab: 'overview' })).toBe('');
        expect(detailSearch({})).toBe('');
    });
});

describe('detailZoneFor', () => {
    it('targets a node-bound construct at its own node when that node is one of its zones', () => {
        expect(detailZoneFor({ node: 'cnv-2', zones: ['cnv-1', 'cnv-2', 'cnv-3'] })).toBe('cnv-2');
    });

    it('targets a cluster-wide construct at its first zone', () => {
        expect(detailZoneFor({ node: undefined, zones: ['ctrl-1', 'cnv-1'] })).toBe('ctrl-1');
        // A node that is not among the zones (a seam construct named for a
        // node it is not in) falls back to the first zone too.
        expect(detailZoneFor({ node: 'cnv-9', zones: ['cnv-1'] })).toBe('cnv-1');
    });

    it('follows a filtered cluster view, whose zones are the chosen host only', () => {
        expect(detailZoneFor({ node: undefined, zones: ['cnv-3'] })).toBe('cnv-3');
    });

    it('is undefined without zones', () => {
        expect(detailZoneFor({ node: 'cnv-1' })).toBeUndefined();
        expect(detailZoneFor({ node: undefined, zones: [] })).toBeUndefined();
    });
});

describe('detailHrefFor', () => {
    it('builds tab links for switches and routers', () => {
        const href = detailHrefFor('cnv-1', { kind: 'router', name: 'GR_cnv-1' });
        expect(href?.()).toBe('/ovn-recon/ovn/cnv-1/router/GR_cnv-1');
        expect(href?.('routes')).toBe('/ovn-recon/ovn/cnv-1/router/GR_cnv-1?tab=routes');
        expect(detailHrefFor('cnv-1', { kind: 'switch', name: 'cnv-1' })?.('ports', { port: 'p1' })).toBe(
            '/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=ports&port=p1',
        );
    });

    it('is undefined for a bridge mapping, without a node, or without a construct', () => {
        expect(detailHrefFor('cnv-1', { kind: 'physnet', name: 'physnet' })).toBeUndefined();
        expect(detailHrefFor(undefined, { kind: 'switch', name: 'cnv-1' })).toBeUndefined();
        expect(detailHrefFor('cnv-1', null)).toBeUndefined();
        expect(hasDetailPage({ kind: 'physnet' })).toBe(false);
        expect(hasDetailPage({ kind: 'switch' })).toBe(true);
    });
});

describe('ladder paths', () => {
    it('carry select=KIND:NAME, the parameter both ladder pages honour', () => {
        expect(nodeLadderPath('cnv-1', { kind: 'switch', name: 'cnv-1' })).toBe('/ovn-recon/ovn/cnv-1?select=switch:cnv-1');
        expect(clusterLadderPath({ kind: 'router', name: 'GR_cnv-1' })).toBe('/ovn-recon/ovn?select=router:GR_cnv-1');
        expect(nodeLadderPath('cnv-1')).toBe('/ovn-recon/ovn/cnv-1');
    });
});

describe('withSearchParams', () => {
    it('sets, replaces and removes parameters and keeps the others', () => {
        expect(withSearchParams('?tab=ports&q=a', { q: 'b' })).toBe('?tab=ports&q=b');
        expect(withSearchParams('?tab=ports&q=a', { q: null, port: 'p' })).toBe('?tab=ports&port=p');
        expect(withSearchParams('?q=a', { q: '' })).toBe('');
        expect(withSearchParams('', { tab: 'config' })).toBe('?tab=config');
    });
});

describe('tabs and sections', () => {
    it('knows the tab names', () => {
        expect(isDetailTab('routes')).toBe(true);
        expect(isDetailTab('nope')).toBe(false);
        expect(isDetailTab(null)).toBe(false);
    });

    it('maps the tabs to the sections they render', () => {
        expect(sectionsForTab('overview')).toEqual([]);
        expect(sectionsForTab('ports')).toEqual(['policy']);
        expect(sectionsForTab('policy')).toEqual(['policy']);
        expect(sectionsForTab('services')).toEqual(['services']);
        expect(sectionsForTab('routes')).toEqual([]);
    });
});
