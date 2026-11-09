import { fetchClusterTopology, fetchCollectorSnapshot, sectionsPath } from './collectorApi';

const API = '/api/plugins/ovn-recon/api/v1';

const fetchMock = jest.fn();

const requestedUrls = (): string[] => fetchMock.mock.calls.map(([url]) => url as string);

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
});

afterAll(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
});

describe('sectionsPath', () => {
    it('is empty when no section is requested', () => {
        expect(sectionsPath()).toBe('');
        expect(sectionsPath([])).toBe('');
    });

    it('sorts and deduplicates so the URL is stable', () => {
        expect(sectionsPath(['services', 'policy'])).toBe('/sections/policy,services');
        expect(sectionsPath(['policy', 'services'])).toBe('/sections/policy,services');
        expect(sectionsPath(['services', 'services'])).toBe('/sections/services');
    });
});

describe('fetchCollectorSnapshot', () => {
    it('requests the ladder payload by default: no sections on the URL', async () => {
        await fetchCollectorSnapshot('cnv-1');
        await fetchCollectorSnapshot('cnv-1', {});
        await fetchCollectorSnapshot('cnv-1', { include: [] });
        const url = `${API}/snapshots/cnv-1`;
        expect(requestedUrls()).toEqual([url, url, url]);
    });

    it('names the requested sections in the path, before the encoded node name', async () => {
        await fetchCollectorSnapshot('cnv-1', { include: ['policy'] });
        await fetchCollectorSnapshot('node/with space', { include: ['services', 'policy'] });
        expect(requestedUrls()).toEqual([
            `${API}/sections/policy/snapshots/cnv-1`,
            `${API}/sections/policy,services/snapshots/node%2Fwith%20space`,
        ]);
    });

    // The console's plugin asset handler forwards the path and drops the
    // query string, so a query parameter never reaches the collector
    // (ovn-recon-e2b.12: the Services tab silently never appeared).
    it('never puts anything in a query string', async () => {
        await fetchCollectorSnapshot('cnv-1');
        await fetchCollectorSnapshot('cnv-1', { include: ['services'] });
        await fetchCollectorSnapshot('cnv-1', { include: ['policy', 'services'] });
        await fetchClusterTopology();
        await fetchClusterTopology({ include: ['services'] });
        expect(requestedUrls()).toHaveLength(5);
        for (const url of requestedUrls()) {
            expect(url).not.toContain('?');
            expect(url).not.toContain('include=');
        }
    });

    it('keeps the sections on every proxy prefix it falls through', async () => {
        fetchMock.mockReset();
        fetchMock
            .mockResolvedValueOnce({ ok: false, status: 404 })
            .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        await fetchCollectorSnapshot('cnv-1', { include: ['services'] });
        const urls = requestedUrls();
        expect(urls).toHaveLength(2);
        expect(urls.every((url) => url.endsWith('/api/v1/sections/services/snapshots/cnv-1'))).toBe(true);
        expect(urls[0]).not.toBe(urls[1]);
    });
});

describe('fetchClusterTopology', () => {
    it('requests the ladder-only aggregate by default', async () => {
        await fetchClusterTopology();
        const [url] = requestedUrls();
        expect(url.endsWith('/api/v1/snapshots')).toBe(true);
        expect(url).not.toContain('sections');
    });

    it('passes sections through in the same sorted form', async () => {
        await fetchClusterTopology({ include: ['services', 'policy'] });
        const [url] = requestedUrls();
        expect(url.endsWith('/api/v1/sections/policy,services/snapshots')).toBe(true);
    });
});
