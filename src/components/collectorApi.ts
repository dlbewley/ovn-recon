import {
    ClusterLogicalTopology,
    CollectorStatusResponse,
    LogicalTopologySnapshot,
    LookupKind,
    LookupResponse,
    OvsBondsResponse,
    SnapshotSection,
} from '../types';

// The collector is reachable through several console proxy shapes depending
// on console version and plugin proxy configuration; try each in order. Each
// entry is the collector's /api/v1 root as seen through that shape.
//
// On a default install only the first works: the console's plugin ASSET
// handler forwards the request to the plugin's own nginx, which proxies
// /api/v1/ to the collector. That handler forwards the request PATH only and
// drops the query string, so nothing the collector needs may travel in a
// query parameter (ovn-recon-e2b.12).
const COLLECTOR_PROXY_PREFIXES = [
    '/api/plugins/ovn-recon/api/v1',
    '/api/plugins/ovn-recon/backend/api/v1',
    '/api/proxy/plugin/ovn-recon/backend/api/v1',
    '/api/proxy/plugin/ovn-recon/api/v1',
];

// Only one prefix ever works on a given console; remember it so later
// requests skip the two or three guaranteed failures.
let lastWorkingPrefix: string | null = null;

const orderedPrefixes = (): string[] =>
    lastWorkingPrefix
        ? [lastWorkingPrefix, ...COLLECTOR_PROXY_PREFIXES.filter((prefix) => prefix !== lastWorkingPrefix)]
        : [...COLLECTOR_PROXY_PREFIXES];

/**
 * The collector received the request and refused it: `message` is its own
 * explanation (for a lookup, why the value does not parse). Unlike a prefix
 * that does not route, trying another prefix cannot help.
 */
export class CollectorRequestError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'CollectorRequestError';
        this.status = status;
    }
}

interface FetchFirstOptions {
    /**
     * Statuses that are the collector's answer rather than a prefix that
     * does not route; the request stops there with a CollectorRequestError.
     */
    refusedStatuses?: readonly number[];
    /**
     * A failed answer that is the collector's own, told apart by its body
     * (ovn-recon-2am): a 404 the collector words itself means the request
     * reached it, where a proxy route that does not exist answers 404 too.
     */
    refuses?: (status: number, body: string) => boolean;
}

/** One proxy route tried for a request, and what came back. */
export interface CollectorAttempt {
    url: string;
    /** The HTTP status, when the route answered at all. */
    status?: number;
    /** Why the request did not complete, when it did not. */
    message?: string;
}

const attemptText = ({ url, status, message }: CollectorAttempt): string =>
    `${url} -> ${status != null ? `HTTP ${status}` : message ?? 'failed'}`;

/**
 * No route reached a collector that answered (ovn-recon-nt4.4): every proxy shape was
 * tried and each one failed. `attempts` keeps them in the order tried, the most likely
 * route first (the one that worked last, else the default install's), so its status is
 * the one worth showing: HTTP 502 while the collector pod restarts, where the other
 * routes answer 404 on every default install.
 */
export class CollectorUnreachableError extends Error {
    readonly attempts: CollectorAttempt[];

    constructor(attempts: CollectorAttempt[]) {
        super(`Collector request failed. Attempts: ${attempts.map(attemptText).join('; ')}`);
        this.name = 'CollectorUnreachableError';
        this.attempts = attempts;
    }

    /** The status of the first route tried, when it answered. */
    get status(): number | undefined {
        return this.attempts[0]?.status;
    }
}

/**
 * The collector answers on its other routes but not on this one (ovn-recon-2am):
 * it is older than the plugin asking. Every route answered 404 for `what`, while a
 * route every collector this plugin knows serves answered on the same proxy.
 */
export class CollectorEndpointMissingError extends Error {
    readonly what: string;
    readonly attempts: CollectorAttempt[];

    constructor(what: string, attempts: CollectorAttempt[]) {
        super(`The collector does not serve ${what}. Attempts: ${attempts.map(attemptText).join('; ')}`);
        this.name = 'CollectorEndpointMissingError';
        this.what = what;
        this.attempts = attempts;
    }
}

/** A failed collector request, as a status line and its details show it. */
export interface CollectorFailure {
    /** One line: "Collector is not answering (HTTP 502)". */
    summary: string;
    /** The HTTP status of the most likely route, when it answered. */
    status?: number;
    /** Each route tried and what came back; empty for a failure that is not a routing one. */
    attempts: string[];
    /** The whole error message. */
    message: string;
}

export const describeCollectorFailure = (error: unknown): CollectorFailure => {
    if (error instanceof CollectorUnreachableError) {
        const { status } = error;
        return {
            summary: `Collector is not answering${status != null ? ` (HTTP ${status})` : ''}`,
            status,
            attempts: error.attempts.map(attemptText),
            message: error.message,
        };
    }
    if (error instanceof CollectorEndpointMissingError) {
        return {
            summary: `Collector does not report ${error.what}: it is older than this plugin`,
            status: 404,
            attempts: error.attempts.map(attemptText),
            message: error.message,
        };
    }
    if (error instanceof CollectorRequestError) {
        return {
            summary: `Collector answered HTTP ${error.status}: ${error.message}`,
            status: error.status,
            attempts: [],
            message: error.message,
        };
    }
    const message = error instanceof Error ? error.message : String(error || 'Failed to reach the collector');
    return { summary: 'Collector request failed', attempts: [], message };
};

/** A failed answer's body, or '' when it has none that can be read. */
const readBody = async (response: Response): Promise<string> => {
    try {
        return (await response.text()).trim();
    } catch {
        return '';
    }
};

const fetchFirst = async <T>(
    buildUrl: (prefix: string) => string,
    { refusedStatuses = [], refuses }: FetchFirstOptions = {},
): Promise<T> => {
    const attempts: CollectorAttempt[] = [];

    for (const prefix of orderedPrefixes()) {
        const url = buildUrl(prefix);
        try {
            const response = await fetch(url, {
                headers: {
                    Accept: 'application/json',
                },
            });

            if (refusedStatuses.includes(response.status)) {
                const reason = (await response.text()).trim();
                throw new CollectorRequestError(response.status, reason || `HTTP ${response.status}`);
            }

            if (!response.ok) {
                if (refuses) {
                    const body = await readBody(response);
                    if (refuses(response.status, body)) {
                        lastWorkingPrefix = prefix;
                        throw new CollectorRequestError(response.status, body || `HTTP ${response.status}`);
                    }
                }
                attempts.push({ url, status: response.status });
                continue;
            }

            const payload = await response.json() as T;
            lastWorkingPrefix = prefix;
            return payload;
        } catch (error) {
            if (error instanceof CollectorRequestError) throw error;
            const message = error instanceof Error ? error.message : String(error);
            attempts.push({ url, message });
        }
    }

    throw new CollectorUnreachableError(attempts);
};

/*
 * The last ladder payload of each path, held for the browser tab (ovn-recon-nt4.4).
 * The aggregate takes 10 to 18 seconds on a cold collector, and the shell remounts
 * after a trip to another console page; a view paints what it was last shown at once
 * and refreshes over it. Only payloads without optional sections are kept, so what is
 * held is one aggregate, one snapshot per node viewed and the collector's status. A request for a path already
 * in flight shares it, so the title row's collector line and the cluster ladder opened
 * together ask the collector once.
 */
const remembered = new Map<string, unknown>();
const inFlight = new Map<string, Promise<unknown>>();

const fetchShared = <T>(path: string, remember: boolean, options: FetchFirstOptions = {}): Promise<T> => {
    const pending = inFlight.get(path);
    if (pending) return pending as Promise<T>;
    const request = fetchFirst<T>((prefix) => `${prefix}${path}`, options)
        .then((payload) => {
            if (remember) remembered.set(path, payload);
            return payload;
        })
        .finally(() => {
            if (inFlight.get(path) === request) inFlight.delete(path);
        });
    inFlight.set(path, request);
    return request;
};

/**
 * Forget every remembered payload, in-flight request and the route that worked
 * (jest.setup.js, between tests).
 */
export const forgetCollectorResponses = (): void => {
    remembered.clear();
    inFlight.clear();
    lastWorkingPrefix = null;
    statusMissing = false;
};

const AGGREGATE_PATH = '/snapshots';
const snapshotPath = (nodeName: string): string => `/snapshots/${encodeURIComponent(nodeName)}`;

export interface SnapshotFetchOptions {
    /**
     * Optional sections to add to the response. Omitted or empty requests the
     * ladder payload, which is what the topology pages fetch; the sections
     * are megabytes on a real cluster, so only the views that render them ask.
     */
    include?: readonly SnapshotSection[];
}

/** Sections deduplicated and sorted, so equal requests are spelled the same. */
export const normalizeSections = (include?: readonly SnapshotSection[]): SnapshotSection[] =>
    Array.from(new Set(include ?? [])).sort();

/**
 * The path segment that selects optional sections, or '' when none is
 * requested: `/sections/policy,services`. The same request always produces
 * the same URL.
 *
 * Sections travel in the path, not as `?include=`, because the console drops
 * query strings on the way to the collector (see COLLECTOR_PROXY_PREFIXES).
 * The collector serves both spellings identically.
 */
export const sectionsPath = (include?: readonly SnapshotSection[]): string => {
    const sections = normalizeSections(include);
    return sections.length > 0 ? `/sections/${sections.join(',')}` : '';
};

export const fetchCollectorSnapshot = (
    nodeName: string,
    options: SnapshotFetchOptions = {},
): Promise<LogicalTopologySnapshot> => {
    const sections = sectionsPath(options.include);
    return fetchShared(`${sections}${snapshotPath(nodeName)}`, sections === '');
};

/**
 * The aggregate carries one snapshot per zone, and the optional sections are
 * near-identical in every zone, so the cluster views fetch it without
 * `include` and read section data from one representative node's snapshot.
 */
export const fetchClusterTopology = (options: SnapshotFetchOptions = {}): Promise<ClusterLogicalTopology> => {
    const sections = sectionsPath(options.include);
    return fetchShared(`${sections}${AGGREGATE_PATH}`, sections === '');
};

/** The last aggregate (ladder payload) this browser tab received, or null. */
export const rememberedClusterTopology = (): ClusterLogicalTopology | null =>
    (remembered.get(AGGREGATE_PATH) as ClusterLogicalTopology | undefined) ?? null;

const STATUS_PATH = '/status';

/**
 * Set once a collector answered the aggregate where `/status` 404'd: it is older than
 * this plugin, so later polls in this tab go straight to the aggregate.
 */
let statusMissing = false;

/** The status an aggregate implies, for a collector older than `/status`. */
export const statusFromAggregate = (aggregate: ClusterLogicalTopology): CollectorStatusResponse => ({
    metadata: aggregate.metadata,
    zones: (aggregate.snapshots ?? []).map((snapshot) => ({
        nodeName: snapshot.metadata?.nodeName ?? '',
        generatedAt: snapshot.metadata?.generatedAt ?? '',
        sourceHealth: snapshot.metadata?.sourceHealth ?? '',
        ovnVersion: snapshot.database?.nbGlobal?.options?.northd_internal_version || undefined,
        warnings: snapshot.warnings ?? [],
    })),
    warnings: aggregate.warnings ?? [],
});

/**
 * The collector's status line (ovn-recon-1zx): `GET /status`, the aggregate's envelope
 * without its databases, a few hundred bytes where the aggregate is every node's whole
 * database. A collector older than the route 404s it on the likeliest route; the
 * aggregate then stands in, reduced to the same shape, and this tab keeps asking the
 * aggregate. Any other failure (the collector restarting, no route at all) rejects as
 * the aggregate would.
 */
export const fetchCollectorStatus = async (): Promise<CollectorStatusResponse> => {
    if (!statusMissing) {
        try {
            return await fetchShared<CollectorStatusResponse>(STATUS_PATH, true);
        } catch (error) {
            if (!(error instanceof CollectorUnreachableError) || error.status !== 404) throw error;
        }
    }
    const aggregate = await fetchClusterTopology();
    statusMissing = true;
    return statusFromAggregate(aggregate);
};

/**
 * The last collector status this browser tab knows: its own, else the one the last
 * aggregate implies (the cluster ladder was open), whichever is newer; or null.
 */
export const rememberedCollectorStatus = (): CollectorStatusResponse | null => {
    const own = remembered.get(STATUS_PATH) as CollectorStatusResponse | undefined;
    const aggregate = rememberedClusterTopology();
    const implied = aggregate ? statusFromAggregate(aggregate) : undefined;
    if (own && implied) {
        return Date.parse(implied.metadata.generatedAt) > Date.parse(own.metadata.generatedAt) ? implied : own;
    }
    return own ?? implied ?? null;
};

const generatedAtMs = (snapshot: LogicalTopologySnapshot): number => {
    const parsed = Date.parse(snapshot.metadata?.generatedAt ?? '');
    return Number.isNaN(parsed) ? -Infinity : parsed;
};

/**
 * The newest ladder payload of one node this browser tab has seen: its own snapshot,
 * or its zone in the last aggregate (the same projection), or null.
 */
export const rememberedCollectorSnapshot = (nodeName: string): LogicalTopologySnapshot | null => {
    const own = remembered.get(snapshotPath(nodeName)) as LogicalTopologySnapshot | undefined;
    const fromAggregate = rememberedClusterTopology()?.snapshots
        ?.find((snapshot) => snapshot.metadata?.nodeName === nodeName);
    if (own && fromAggregate) return generatedAtMs(fromAggregate) > generatedAtMs(own) ? fromAggregate : own;
    return own ?? fromAggregate ?? null;
};

/**
 * Where an address or a name is, across every zone snapshot the collector
 * has stored: `GET /lookup/<kind>/<value>` (ovn-recon-tpp.1). The collector
 * answers from its cache and never collects for a lookup, so each hit and
 * each entry of `zones` carries the age of the snapshot it came from.
 *
 * The value travels in the path, encoded, for the same reason sections do:
 * the console drops query strings (see COLLECTOR_PROXY_PREFIXES). A CIDR's
 * slash is sent as %2F; the console decodes it on the way and the collector
 * reads either spelling.
 *
 * A value the collector cannot parse as the given kind rejects with a
 * CollectorRequestError (status 400) whose message says why.
 */
export const fetchCollectorLookup = (kind: LookupKind, value: string): Promise<LookupResponse> => {
    const encodedValue = encodeURIComponent(value.trim());
    return fetchFirst((prefix) => `${prefix}/lookup/${kind}/${encodedValue}`, { refusedStatuses: [400] });
};

/**
 * Every OVS bond's runtime state on one node: `GET /ovs/bonds/<node>`
 * (ovn-recon-1tw.7), the collector's parse of `ovs-appctl bond/show`. It moves
 * (the active member, the rebalance timer), so it is never remembered for the tab
 * the way ladder payloads are: each call asks the collector, sharing only a request
 * for the same node already in flight (the cold double mount of the shell). The
 * node travels in the path, encoded, as everything does (see COLLECTOR_PROXY_PREFIXES).
 */
export const fetchOvsBondState = async (nodeName: string): Promise<OvsBondsResponse> => {
    try {
        return await fetchShared<OvsBondsResponse>(`/ovs/bonds/${encodeURIComponent(nodeName)}`, false, {
            // The collector words its own 404 (an unknown node) with this route's
            // usage line; a proxy route that does not exist says nothing of the kind.
            refuses: (status, body) => status === 404 && body.includes(OVS_BONDS_ROUTE),
        });
    } catch (error) {
        if (error instanceof CollectorUnreachableError
            && error.attempts.some((attempt) => attempt.status === 404)
            && await collectorAnswers()) {
            throw new CollectorEndpointMissingError('OVS bond state', error.attempts);
        }
        throw error;
    }
};

/** The collector's usage line for the bond route names it so (collector/internal/server/ovs_bonds.go). */
const OVS_BONDS_ROUTE = '/ovs/bonds/';

/**
 * Whether a collector answers on any proxy route (ovn-recon-2am), asked only after a
 * route 404'd on every prefix, to tell a collector older than that route from one
 * that cannot be reached. `/lookup/` with no kind is the probe: every collector since
 * ovn-recon-tpp.1 answers it 400 with its usage line, from memory, never collecting.
 * A collector older still is reported as not answering, as before.
 */
const collectorAnswers = async (): Promise<boolean> => {
    for (const prefix of orderedPrefixes()) {
        try {
            const response = await fetch(`${prefix}/lookup/`, { headers: { Accept: 'application/json' } });
            if (response.status === 400 && (await readBody(response)).includes('/lookup/')) {
                lastWorkingPrefix = prefix;
                return true;
            }
        } catch {
            // A route that does not complete says nothing; try the next.
        }
    }
    return false;
};
