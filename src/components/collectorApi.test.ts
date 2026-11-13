import { LookupResponse } from '../types';
import {
    CollectorRequestError,
    CollectorUnreachableError,
    describeCollectorFailure,
    fetchClusterTopology,
    fetchCollectorLookup,
    fetchCollectorSnapshot,
    rememberedClusterTopology,
    rememberedCollectorSnapshot,
    sectionsPath,
} from './collectorApi';

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

describe('fetchCollectorLookup', () => {
    // Earlier tests may have moved the remembered prefix, so these compare
    // what follows the collector's /api/v1 root.
    const requestedPaths = (): string[] =>
        requestedUrls().map((url) => url.slice(url.indexOf('/api/v1/') + '/api/v1'.length));

    it('puts the kind and the encoded value in the path', async () => {
        await fetchCollectorLookup('ip', '10.131.0.70');
        await fetchCollectorLookup('mac', '0a:58:0a:83:00:46');
        await fetchCollectorLookup('name', 'thanos-querier');
        expect(requestedPaths()).toEqual([
            '/lookup/ip/10.131.0.70',
            '/lookup/mac/0a%3A58%3A0a%3A83%3A00%3A46',
            '/lookup/name/thanos-querier',
        ]);
        for (const url of requestedUrls()) {
            expect(url.startsWith('/api/')).toBe(true);
        }
    });

    it('encodes the slash of a CIDR so the value cannot be mistaken for more path', async () => {
        await fetchCollectorLookup('cidr', '10.1.2.0/24');
        await fetchCollectorLookup('cidr', 'fd69::/112');
        expect(requestedPaths()).toEqual(['/lookup/cidr/10.1.2.0%2F24', '/lookup/cidr/fd69%3A%3A%2F112']);
    });

    // The console forwards the path and drops the query string
    // (ovn-recon-e2b.12), so nothing may leak into one, whatever is typed.
    it('never puts anything in a query string or a fragment', async () => {
        await fetchCollectorLookup('name', 'a?b=c&d#e f');
        await fetchCollectorLookup('ip', '10.131.0.70');
        await fetchCollectorLookup('cidr', '10.1.2.0/24');
        expect(requestedPaths()[0]).toBe('/lookup/name/a%3Fb%3Dc%26d%23e%20f');
        for (const url of requestedUrls()) {
            expect(url).not.toContain('?');
            expect(url).not.toContain('#');
            expect(url).not.toContain('=');
        }
    });

    it('trims the value', async () => {
        await fetchCollectorLookup('ip', '  10.131.0.70\n');
        expect(requestedPaths()).toEqual(['/lookup/ip/10.131.0.70']);
    });

    it('falls through the proxy prefixes like the snapshot helpers', async () => {
        fetchMock.mockReset();
        fetchMock
            .mockResolvedValueOnce({ ok: false, status: 404 })
            .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        await fetchCollectorLookup('cidr', '10.1.2.0/24');
        const urls = requestedUrls();
        expect(urls).toHaveLength(2);
        expect(urls.every((url) => url.endsWith('/api/v1/lookup/cidr/10.1.2.0%2F24'))).toBe(true);
        expect(urls[0]).not.toBe(urls[1]);
    });

    it('returns the collector payload', async () => {
        const payload: LookupResponse = {
            query: { kind: 'ip', value: '10.131.0.70' },
            hits: [
                {
                    node: 'cnv-1',
                    table: 'Logical_Switch_Port',
                    rowUuid: '6f0c0f0e-0000-4000-8000-000000000001',
                    rowName: 'openshift-monitoring_thanos-querier-0',
                    construct: { kind: 'switch', name: 'cnv-1', uuid: '6f0c0f0e-0000-4000-8000-000000000002' },
                    network: 'default',
                    owner: { kind: 'Pod', namespace: 'openshift-monitoring', name: 'thanos-querier-0' },
                    matchedField: 'addresses',
                    matchedValue: '0a:58:0a:83:00:46 10.131.0.70',
                    matchType: 'exact',
                    snapshotGeneratedAt: '2026-11-10T12:00:00Z',
                },
            ],
            total: 1,
            limit: 200,
            truncated: false,
            zones: [{ node: 'cnv-1', snapshotGeneratedAt: '2026-11-10T12:00:00Z', sourceHealth: 'healthy' }],
            warnings: [],
        };
        fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => payload });
        await expect(fetchCollectorLookup('ip', '10.131.0.70')).resolves.toEqual(payload);
    });

    // A 400 is the collector saying the value does not parse as that kind.
    // Another prefix cannot change that, and the reason is worth keeping.
    it('stops at a 400 and rejects with the reason the collector gave', async () => {
        fetchMock.mockReset();
        fetchMock.mockResolvedValue({
            ok: false,
            status: 400,
            text: async () => '"10.1.2" is not an IP address; expected /api/v1/lookup/<ip|mac|cidr|name>/<value>\n',
        });
        const failure = await fetchCollectorLookup('ip', '10.1.2').catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(CollectorRequestError);
        expect((failure as CollectorRequestError).status).toBe(400);
        expect((failure as CollectorRequestError).message).toBe(
            '"10.1.2" is not an IP address; expected /api/v1/lookup/<ip|mac|cidr|name>/<value>',
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('still reports every attempt when no prefix reaches the collector', async () => {
        fetchMock.mockReset();
        fetchMock.mockResolvedValue({ ok: false, status: 404 });
        const failure = await fetchCollectorLookup('ip', '10.131.0.70').catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(CollectorRequestError);
        expect((failure as Error).message).toContain('Collector request failed');
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('leaves the snapshot helpers falling through on a 400 as before', async () => {
        fetchMock.mockReset();
        fetchMock
            .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'unknown include section' })
            .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        await fetchCollectorSnapshot('cnv-1', { include: ['services'] });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

// ovn-recon-nt4.4: a failure keeps its routes, and the status of the likeliest one.
describe('a collector that does not answer', () => {
    it('rejects with every route tried, the likeliest first, and its status', async () => {
        fetchMock.mockReset();
        fetchMock.mockImplementation(async (url: string) => ({ ok: false, status: url.startsWith(API) ? 502 : 404 }));
        const failure = await fetchClusterTopology().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(CollectorUnreachableError);
        const unreachable = failure as CollectorUnreachableError;
        expect(unreachable.status).toBe(502);
        expect(unreachable.attempts.map(({ status }) => status)).toEqual([502, 404, 404, 404]);
        expect(unreachable.message).toContain('Collector request failed. Attempts: ');

        expect(describeCollectorFailure(failure)).toMatchObject({
            summary: 'Collector is not answering (HTTP 502)',
            status: 502,
            attempts: [
                `${API}/snapshots -> HTTP 502`,
                '/api/plugins/ovn-recon/backend/api/v1/snapshots -> HTTP 404',
                '/api/proxy/plugin/ovn-recon/backend/api/v1/snapshots -> HTTP 404',
                '/api/proxy/plugin/ovn-recon/api/v1/snapshots -> HTTP 404',
            ],
        });
    });

    it('names no status when no route answered at all', async () => {
        fetchMock.mockReset();
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
        const failure = describeCollectorFailure(await fetchClusterTopology().catch((error: unknown) => error));
        expect(failure.summary).toBe('Collector is not answering');
        expect(failure.status).toBeUndefined();
        expect(failure.attempts[0]).toBe(`${API}/snapshots -> Failed to fetch`);
    });

    it('describes any other error by its message', () => {
        expect(describeCollectorFailure(new Error('boom'))).toEqual({
            summary: 'Collector request failed', attempts: [], message: 'boom',
        });
    });
});

// ovn-recon-nt4.4: what a view paints before the collector answers.
describe('remembered ladder payloads', () => {
    const snapshotOf = (nodeName: string, generatedAt: string) => ({ metadata: { nodeName, generatedAt } });
    const answer = (payload: unknown) =>
        fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => payload });

    it('remembers the last aggregate and each node\'s ladder snapshot, not section payloads', async () => {
        expect(rememberedClusterTopology()).toBeNull();
        const aggregate = { snapshots: [snapshotOf('cnv-1', '2026-11-12T10:00:00Z')] };
        answer(aggregate);
        await fetchClusterTopology();
        expect(rememberedClusterTopology()).toBe(aggregate);
        // The node's zone in the aggregate stands in for its own snapshot.
        expect(rememberedCollectorSnapshot('cnv-1')).toBe(aggregate.snapshots[0]);
        expect(rememberedCollectorSnapshot('cnv-2')).toBeNull();

        const own = snapshotOf('cnv-1', '2026-11-12T10:05:00Z');
        answer(own);
        await fetchCollectorSnapshot('cnv-1');
        expect(rememberedCollectorSnapshot('cnv-1')).toBe(own);

        answer(snapshotOf('cnv-1', '2026-11-12T10:10:00Z'));
        await fetchCollectorSnapshot('cnv-1', { include: ['policy'] });
        expect(rememberedCollectorSnapshot('cnv-1')).toBe(own);
    });

    it('keeps the newer of a node\'s own snapshot and its zone in the aggregate', async () => {
        answer(snapshotOf('cnv-1', '2026-11-12T10:00:00Z'));
        await fetchCollectorSnapshot('cnv-1');
        const aggregate = { snapshots: [snapshotOf('cnv-1', '2026-11-12T10:05:00Z')] };
        answer(aggregate);
        await fetchClusterTopology();
        expect(rememberedCollectorSnapshot('cnv-1')).toBe(aggregate.snapshots[0]);
    });

    it('keeps the last good aggregate through a failed request', async () => {
        const aggregate = { snapshots: [] };
        answer(aggregate);
        await fetchClusterTopology();
        fetchMock.mockReset();
        fetchMock.mockResolvedValue({ ok: false, status: 502 });
        await expect(fetchClusterTopology()).rejects.toBeInstanceOf(CollectorUnreachableError);
        expect(rememberedClusterTopology()).toBe(aggregate);
    });

    it('shares a request already in flight for the same path', async () => {
        let resolve: (value: unknown) => void = () => undefined;
        fetchMock.mockReset();
        fetchMock.mockReturnValue(new Promise((done) => { resolve = done; }));
        const first = fetchClusterTopology();
        const second = fetchClusterTopology();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        resolve({ ok: true, status: 200, json: async () => ({ snapshots: [] }) });
        expect(await second).toBe(await first);

        // Once it has settled, the next request asks again.
        answer({ snapshots: [] });
        await fetchClusterTopology();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
