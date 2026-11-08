import { fetchClusterTopology, fetchCollectorSnapshot, includeQuery } from './collectorApi';

const PREFIX = '/api/plugins/ovn-recon/api/v1/snapshots';

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

describe('includeQuery', () => {
    it('is empty when no section is requested', () => {
        expect(includeQuery()).toBe('');
        expect(includeQuery([])).toBe('');
    });

    it('sorts and deduplicates so the URL is stable', () => {
        expect(includeQuery(['services', 'policy'])).toBe('?include=policy,services');
        expect(includeQuery(['policy', 'services'])).toBe('?include=policy,services');
        expect(includeQuery(['services', 'services'])).toBe('?include=services');
    });
});

describe('fetchCollectorSnapshot', () => {
    it('requests the ladder payload by default: no include on the URL', async () => {
        await fetchCollectorSnapshot('cnv-1');
        await fetchCollectorSnapshot('cnv-1', {});
        await fetchCollectorSnapshot('cnv-1', { include: [] });
        expect(requestedUrls()).toEqual([`${PREFIX}/cnv-1`, `${PREFIX}/cnv-1`, `${PREFIX}/cnv-1`]);
    });

    it('appends the requested sections after the encoded node name', async () => {
        await fetchCollectorSnapshot('cnv-1', { include: ['policy'] });
        await fetchCollectorSnapshot('node/with space', { include: ['services', 'policy'] });
        expect(requestedUrls()).toEqual([
            `${PREFIX}/cnv-1?include=policy`,
            `${PREFIX}/node%2Fwith%20space?include=policy,services`,
        ]);
    });

    it('keeps the include on every proxy prefix it falls through', async () => {
        fetchMock.mockReset();
        fetchMock
            .mockResolvedValueOnce({ ok: false, status: 404 })
            .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        await fetchCollectorSnapshot('cnv-1', { include: ['services'] });
        const urls = requestedUrls();
        expect(urls).toHaveLength(2);
        expect(urls.every((url) => url.endsWith('/api/v1/snapshots/cnv-1?include=services'))).toBe(true);
        expect(urls[0]).not.toBe(urls[1]);
    });
});

describe('fetchClusterTopology', () => {
    it('requests the ladder-only aggregate by default', async () => {
        await fetchClusterTopology();
        const [url] = requestedUrls();
        expect(url.endsWith('/api/v1/snapshots')).toBe(true);
        expect(url).not.toContain('include');
    });

    it('passes sections through in the same sorted form', async () => {
        await fetchClusterTopology({ include: ['services', 'policy'] });
        const [url] = requestedUrls();
        expect(url.endsWith('/api/v1/snapshots?include=policy,services')).toBe(true);
    });
});
