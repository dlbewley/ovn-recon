import * as React from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import {
    Alert,
    Button,
    Card,
    CardBody,
    CardTitle,
    ExpandableSection,
    Flex,
    FlexItem,
    Label,
    LabelGroup,
    SearchInput,
    Spinner,
    Title,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import { NodeNetworkState } from '../types';
import { getResourcePath } from '../topology/links';
import { CollectorRequestError, fetchCollectorLookup } from './collectorApi';
import {
    buildClusterSearchResults,
    ClusterSearchResults,
    CollectorOutcome,
    CoveringGroup,
    describeSearched,
    describeSearchQuery,
    detectSearchQuery,
    jumpTargets,
    readSearchParam,
    SearchCoverage,
    SearchLink,
    SearchMatch,
    SearchPlace,
    SearchQuery,
    SearchResult,
    searchGroupAnchorId,
    withSearchParam,
    ZoneCount,
} from './clusterSearchModel';
import { networkResourceRef } from './logicalClassification';
import { networkDisplayName, networkKindBadge } from './LogicalLadderView';
import { parseSnapshotAgeMs } from './snapshotFreshness';
import { formatAge } from './SnapshotStatusLine';

/**
 * The cluster search (ovn-recon-tpp.2): "where is this IP, MAC, pod or
 * network?". Thin on purpose: reading the input, merging the collector's hits
 * with what the overview already watches, folding and link building all live
 * in clusterSearchModel.ts. This module owns only the request and what is on
 * screen.
 *
 * A lookup reads every cached zone snapshot and takes about a second on a
 * ten-node cluster, so it runs when the search is submitted, never while
 * typing. The submitted text lives in the page URL (`?q=`), which is what
 * lets a result link be followed and Back return to the same results.
 *
 * Three pieces (ovn-recon-gbr.3), so the box and the answer can sit in
 * different places under one owner of the lookup: `useClusterSearch` holds the
 * request and its answer, `ClusterSearchInput` is the box, and
 * `ClusterSearchResultsPanel` is everything said back. `ClusterSearch`, the
 * overview's card, is the three put together.
 */

export interface ClusterSearchProps {
    /** Every node's NodeNetworkState, as the overview watches it. */
    nodeNetworkStates?: NodeNetworkState[];
    /** The Node list, read for node addresses and for which nodes exist. */
    nodes?: K8sResourceCommon[];
    /** The NodeNetworkState watch has settled: loaded, or failed. */
    stateLoaded: boolean;
    /** Why NodeNetworkState could not be read, when it could not. */
    stateError?: string;
    collectorEnabled: boolean;
    /** Whether `collectorEnabled` is known yet. */
    gateLoaded: boolean;
}

const SUBTLE: React.CSSProperties = { color: 'var(--pf-t--global--text--color--subtle)' };
const WRAP_ANYWHERE: React.CSSProperties = { overflowWrap: 'anywhere' };

const NO_STATES: NodeNetworkState[] = [];
const NO_NODES: K8sResourceCommon[] = [];

// Places listed before the rest fold behind "and N more".
const PLACE_LIMIT = 3;

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

const MATCH_TYPE_LABEL: Partial<Record<SearchMatch['type'], string>> = {
    within: 'inside the searched CIDR',
    prefix: 'starts with the text',
    substring: 'contains the text',
};

const SearchLinkAnchor: React.FC<{ link: SearchLink }> = ({ link }) => (
    <Link to={link.href} data-view={link.view}>{link.label}</Link>
);

/** The zones or nodes of one result, each with the link that opens it there. */
const PlaceList: React.FC<{ places: SearchPlace[]; noun: string }> = ({ places, noun }) => {
    const [showAll, setShowAll] = React.useState(false);
    const visible = showAll ? places : places.slice(0, PLACE_LIMIT);
    const hidden = places.length - visible.length;
    return (
        <>
            {visible.map((place) => (
                <div key={place.node} style={WRAP_ANYWHERE}>
                    {place.node}
                    {place.link && (
                        <>
                            {' · '}
                            <SearchLinkAnchor link={place.link} />
                        </>
                    )}
                </div>
            ))}
            {hidden > 0 && (
                <Button variant="link" isInline onClick={() => setShowAll(true)}>
                    and {plural(hidden, `more ${noun}`)}
                </Button>
            )}
        </>
    );
};

const NetworkCell: React.FC<{ result: Pick<SearchResult, 'network' | 'context'> }> = ({ result }) => {
    if (!result.network) return <>{result.context ?? ''}</>;
    const ref = networkResourceRef(result.network);
    const badge = networkKindBadge(result.network);
    const name = networkDisplayName(result.network);
    return (
        <span style={WRAP_ANYWHERE}>
            {badge && `${badge} `}
            {ref ? <Link to={getResourcePath(ref)}>{name}</Link> : name}
        </span>
    );
};

const OwnerCell: React.FC<{ owner: SearchResult['owner'] }> = ({ owner }) => {
    if (!owner) return null;
    const name = owner.namespace ? `${owner.namespace}/${owner.name}` : owner.name;
    return (
        <span style={WRAP_ANYWHERE}>
            {owner.kind}{' '}
            {owner.href ? <Link to={owner.href} data-view="owner">{name}</Link> : name}
            {owner.note && <span style={SUBTLE}> ({owner.note})</span>}
        </span>
    );
};

/** Where a Service VIP is programmed, out of the zones searched, and where it is not. */
const ZoneCountLine: React.FC<{ zones: ZoneCount }> = ({ zones }) => (
    <>
        <div data-testid="search-zone-count">Programmed in {zones.found} of {plural(zones.searched, 'zone')}</div>
        {zones.missing.length > 0 && (
            <div style={{ ...SUBTLE, ...WRAP_ANYWHERE }}>
                not in {zones.missing.join(', ')}
                {zones.incomplete && ' (or cut from the answer: the collector returned only its first matches)'}
            </div>
        )}
    </>
);

/**
 * The rows a folded result stands for, each with its own places and links.
 * Built only when open: a Service on a large cluster has hundreds.
 */
const MemberList: React.FC<{ result: SearchResult; noun: string }> = ({ result, noun }) => {
    const [expanded, setExpanded] = React.useState(false);
    const members = result.members ?? [];
    const what = result.kind === 'service-vip' ? 'load balancer row' : 'row';
    return (
        <ExpandableSection
            isExpanded={expanded}
            onToggle={(_event, next) => setExpanded(next)}
            toggleText={expanded ? `Hide the ${plural(members.length, what)}` : `Show the ${plural(members.length, what)}`}
            data-testid="search-members"
        >
            {expanded && members.map((member) => (
                <div key={member.key} data-testid="search-member" style={{ marginBottom: 8 }}>
                    <div style={WRAP_ANYWHERE}>{member.title}</div>
                    {member.match.value !== result.match.value && (
                        <div style={{ ...SUBTLE, ...WRAP_ANYWHERE }}>{member.match.field} {member.match.value}</div>
                    )}
                    <div style={SUBTLE}>
                        <PlaceList places={member.places} noun={noun} />
                    </div>
                    {member.links.map((link) => (
                        <div key={link.href}><SearchLinkAnchor link={link} /></div>
                    ))}
                </div>
            ))}
        </ExpandableSection>
    );
};

const nodesSummary = (places: SearchPlace[], noun: string): string => {
    const names = places.map((place) => place.node);
    const shown = names.slice(0, PLACE_LIMIT).join(', ');
    const rest = names.length - PLACE_LIMIT;
    return `On ${plural(names.length, noun)}: ${shown}${rest > 0 ? ` and ${rest} more` : ''}`;
};

const ResultRow: React.FC<{ result: SearchResult }> = ({ result }) => {
    const typeLabel = MATCH_TYPE_LABEL[result.match.type];
    const noun = result.source === 'collector' ? 'zone' : 'node';
    return (
        <Tr data-testid="search-result" data-source={result.source}>
            <Td dataLabel="Found">
                <div style={WRAP_ANYWHERE}>{result.title}</div>
                {result.subtitle && <div style={{ ...SUBTLE, ...WRAP_ANYWHERE }}>{result.subtitle}</div>}
            </Td>
            <Td dataLabel="Matched">
                <span style={WRAP_ANYWHERE}>{result.match.field} {result.match.value}</span>
                {result.match.note && <span style={SUBTLE}> ({result.match.note})</span>}
                {typeLabel && (
                    <>
                        {' '}
                        <Label isCompact>{typeLabel}</Label>
                    </>
                )}
                {result.ports && result.ports.length > 0 && (
                    <div style={{ marginTop: 4 }}>
                        <LabelGroup numLabels={8} isCompact aria-label="Ports">
                            {result.ports.map((port) => <Label key={port} isCompact color="blue">{port}</Label>)}
                        </LabelGroup>
                    </div>
                )}
            </Td>
            <Td dataLabel="Network"><NetworkCell result={result} /></Td>
            <Td dataLabel="Owner"><OwnerCell owner={result.owner} /></Td>
            <Td dataLabel="Where">
                {result.zones && <ZoneCountLine zones={result.zones} />}
                {result.members ? (
                    <>
                        {!result.zones && <div style={WRAP_ANYWHERE}>{nodesSummary(result.places, 'node')}</div>}
                        <MemberList result={result} noun={noun} />
                    </>
                ) : (
                    <PlaceList places={result.places} noun={noun} />
                )}
                {result.links.map((link) => (
                    <div key={link.href}><SearchLinkAnchor link={link} /></div>
                ))}
            </Td>
        </Tr>
    );
};

const RESULT_COLUMNS = ['Found', 'Matched', 'Network', 'Owner', 'Where'];

const coveringCountText = (count: number): string =>
    count === 1 ? '1 covering route or subnet' : `${count} covering routes and subnets`;

const coveringSummary = (group: CoveringGroup): string =>
    [
        `${group.entries.length} ${group.entries.length === 1 ? 'prefix' : 'prefixes'}`,
        group.source === 'collector' && group.nodes.length > 1 ? `${group.nodes.length} zones` : '',
    ].filter(Boolean).join(' · ');

const CoveringGroupSection: React.FC<{ group: CoveringGroup }> = ({ group }) => {
    const [expanded, setExpanded] = React.useState(false);
    return (
        <ExpandableSection
            isIndented
            isExpanded={expanded}
            onToggle={(_event, next) => setExpanded(next)}
            data-testid="search-covering-group"
            toggleContent={(
                <span>
                    {group.label}
                    <span style={SUBTLE}>
                        {group.network && (
                            <>
                                {' · '}
                                {networkDisplayName(group.network)}
                            </>
                        )}
                        {' · '}
                        {coveringSummary(group)}
                    </span>
                </span>
            )}
        >
            {/* Built only when open: one address can have hundreds of these. */}
            {expanded && (
                <>
                    {group.links.map((link) => (
                        <div key={link.href}><SearchLinkAnchor link={link} /></div>
                    ))}
                    <Table aria-label={`${group.label}: covering routes and subnets`} variant="compact">
                        <Thead>
                            <Tr>
                                <Th>Covered by</Th>
                                <Th>Where</Th>
                            </Tr>
                        </Thead>
                        <Tbody>
                            {group.entries.map((entry) => (
                                <Tr key={entry.key} data-testid="search-covering-entry">
                                    <Td dataLabel="Covered by">
                                        <div style={WRAP_ANYWHERE}>{entry.what} {entry.prefix}</div>
                                        {entry.detail && <div style={{ ...SUBTLE, ...WRAP_ANYWHERE }}>{entry.detail}</div>}
                                    </Td>
                                    <Td dataLabel="Where">
                                        <PlaceList places={entry.places} noun={group.source === 'collector' ? 'zone' : 'node'} />
                                    </Td>
                                </Tr>
                            ))}
                        </Tbody>
                    </Table>
                </>
            )}
        </ExpandableSection>
    );
};

const COLLECTOR_SCOPE = 'OVN switch and router ports, NAT rules, static routes, switch subnets and Service VIPs';
const CLUSTER_SCOPE = 'node interfaces, kernel routes and node addresses';

/** What the answer does not cover, said next to it. */
const CoverageAlerts: React.FC<{ query: SearchQuery; coverage: SearchCoverage; stateError?: string }> = ({
    query,
    coverage,
    stateError,
}) => {
    const what = describeSearchQuery(query);
    return (
        <>
            {coverage.collector === 'rejected' && (
                <Alert variant="danger" isInline title={`The collector could not search for ${what}`} data-testid="search-rejected">
                    <p>{coverage.collectorMessage}</p>
                    <p>The result is partial: only {CLUSTER_SCOPE} were searched.</p>
                </Alert>
            )}
            {coverage.collector === 'unreachable' && (
                <Alert variant="warning" isInline title="Partial result: the collector could not be reached" data-testid="search-partial">
                    <p>Only {CLUSTER_SCOPE} were searched. {COLLECTOR_SCOPE} were not.</p>
                    <p style={{ ...SUBTLE, ...WRAP_ANYWHERE }}>{coverage.collectorMessage}</p>
                </Alert>
            )}
            {coverage.collector === 'disabled' && (
                <Alert variant="info" isInline title="Partial result: the collector is not enabled" data-testid="search-partial">
                    Only {CLUSTER_SCOPE} were searched. {COLLECTOR_SCOPE} are searched when the collector is
                    enabled (spec.collector.enabled on the OvnRecon resource).
                </Alert>
            )}
            {coverage.collector === 'searched' && (coverage.partial || coverage.warnings.length > 0) && (
                <Alert
                    variant="warning"
                    isInline
                    title={coverage.partial ? 'Partial result' : 'Collector warnings'}
                    data-testid="search-partial"
                >
                    {coverage.zonesSearched === 0 && (
                        <p>The collector has no stored zone snapshot to search. {COLLECTOR_SCOPE} were not searched.</p>
                    )}
                    {coverage.zonesSearched > 0 && coverage.unsearchedNodes.length > 0 && (
                        <p style={WRAP_ANYWHERE}>
                            The collector has no stored snapshot for {plural(coverage.unsearchedNodes.length, 'node')}, so
                            their OVN zones were not searched: {coverage.unsearchedNodes.join(', ')}.
                        </p>
                    )}
                    {coverage.truncated && (
                        <p>
                            The collector returned the first {coverage.truncated.shown} of {coverage.truncated.total} matches.
                            The ones it cut are the lowest ranked; narrow the search to see them.
                        </p>
                    )}
                    {coverage.warnings.map((warning, index) => (
                        <p key={`${warning.code}-${index}`} style={WRAP_ANYWHERE}>{warning.code}: {warning.message}</p>
                    ))}
                </Alert>
            )}
            {stateError && (
                <Alert variant="warning" isInline title="NodeNetworkState could not be read" data-testid="search-state-error">
                    Node interfaces and kernel routes were not searched: {stateError}
                </Alert>
            )}
        </>
    );
};

// A lookup reads stored snapshots and never collects, so the answer is as
// old as the oldest of them.
const searchedLine = (coverage: SearchCoverage): string => {
    const age = coverage.oldestSnapshotAt ? parseSnapshotAgeMs(coverage.oldestSnapshotAt) : null;
    return `Searched ${describeSearched(coverage, age != null ? `oldest collected ${formatAge(age)}` : '')}.`;
};

/**
 * One finished search. `settled` is false while NodeNetworkState is still
 * loading: the cluster half may yet add results, so "no match" waits for it.
 */
const Results: React.FC<{ results: ClusterSearchResults; stateError?: string; settled: boolean }> = ({
    results,
    stateError,
    settled,
}) => {
    const what = describeSearchQuery(results.query);
    const nothingDirect = results.resultCount === 0;
    const targets = jumpTargets(results);
    // The covering groups are the whole answer when nothing matched directly,
    // so they open; under direct results they stay out of the way.
    const [coveringOpen, setCoveringOpen] = React.useState<boolean | null>(null);
    const coveringExpanded = coveringOpen ?? nothingDirect;

    return (
        <div data-testid="search-results">
            <Title headingLevel="h3" size="md" style={{ marginTop: 16 }}>
                Results for {what}
                <span style={{ ...SUBTLE, fontWeight: 'normal' }}>
                    {' · '}
                    {plural(results.resultCount, 'result')}
                    {results.coveringCount > 0 && ` · ${coveringCountText(results.coveringCount)}`}
                </span>
            </Title>
            <p style={SUBTLE} data-testid="search-searched">{searchedLine(results.coverage)}</p>

            <CoverageAlerts query={results.query} coverage={results.coverage} stateError={stateError} />

            {settled && nothingDirect && results.coveringCount === 0 && (
                <p data-testid="search-empty" style={{ marginTop: 12 }}>
                    No match for {what} in {describeSearched(results.coverage)}.
                </p>
            )}
            {settled && nothingDirect && results.coveringCount > 0 && (
                <p data-testid="search-empty" style={{ marginTop: 12 }}>
                    Nothing holds {what} itself in {describeSearched(results.coverage)}. The routes and subnets
                    below cover it.
                </p>
            )}

            {targets.length > 0 && (
                <nav aria-label="Result groups" data-testid="search-jump-list" style={{ marginTop: 12 }}>
                    <span style={SUBTLE}>Jump to: </span>
                    {targets.map((target, index) => (
                        <React.Fragment key={target.id}>
                            {index > 0 && <span style={SUBTLE}> · </span>}
                            <Button
                                variant="link"
                                isInline
                                onClick={() => {
                                    if (target.id === searchGroupAnchorId('covering')) setCoveringOpen(true);
                                    document.getElementById(target.id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
                                }}
                            >
                                {target.label} ({target.count})
                            </Button>
                        </React.Fragment>
                    ))}
                </nav>
            )}

            {results.groups.map((group) => (
                <div
                    key={group.kind}
                    id={searchGroupAnchorId(group.kind)}
                    data-testid={`search-group-${group.kind}`}
                    style={{ marginTop: 16 }}
                >
                    <Title headingLevel="h4" size="md">
                        {group.label} <span style={{ ...SUBTLE, fontWeight: 'normal' }}>({group.results.length})</span>
                    </Title>
                    <Table aria-label={group.label} variant="compact">
                        <Thead>
                            <Tr>{RESULT_COLUMNS.map((column) => <Th key={column}>{column}</Th>)}</Tr>
                        </Thead>
                        <Tbody>
                            {group.results.map((result) => <ResultRow key={result.key} result={result} />)}
                        </Tbody>
                    </Table>
                </div>
            ))}

            {results.covering.length > 0 && (
                <div id={searchGroupAnchorId('covering')} data-testid="search-covering" style={{ marginTop: 16 }}>
                    <ExpandableSection
                        isExpanded={coveringExpanded}
                        onToggle={(_event, next) => setCoveringOpen(next)}
                        toggleText={`Routes and subnets that cover ${results.query.value} (${results.coveringCount} in ${plural(results.covering.length, 'group')})`}
                    >
                        <p style={SUBTLE}>
                            These contain the searched {results.query.kind === 'cidr' ? 'range' : 'address'} without being
                            about it. One group per router, switch or node, most specific first.
                        </p>
                        {results.covering.map((group) => <CoveringGroupSection key={group.key} group={group} />)}
                    </ExpandableSection>
                </div>
            )}
        </div>
    );
};

interface Answer {
    query: SearchQuery;
    outcome: CollectorOutcome;
}

/** One search: what was submitted, how to submit another, and the answer so far. */
export interface ClusterSearchState {
    /** The submitted text, as the page URL holds it (`?q=`); empty when there is none. */
    submitted: string;
    /** `submitted` read as an IP, CIDR, MAC or name; null when there is nothing to search for. */
    query: SearchQuery | null;
    /**
     * Search for this text: writes it to the page URL, or repeats the lookup when it
     * is the text already there. Empty text clears the search.
     */
    submit: (value: string) => void;
    /** A search is under way: the collector has not answered, or NodeNetworkState has not settled. */
    busy: boolean;
    /** The last finished search, merged with the cluster's own hits. It stays while the next one runs. */
    results: ClusterSearchResults | null;
    /** The NodeNetworkState watch has settled; until then "no match" is not yet known. */
    stateLoaded: boolean;
    /** Why NodeNetworkState could not be read, when it could not. */
    stateError?: string;
}

/**
 * The lookup behind the search, for whichever component owns it: the overview's
 * card today. It reads the submitted text from the page URL, asks the collector
 * when that text changes, and merges the answer with the sources it is handed.
 */
export const useClusterSearch = ({
    nodeNetworkStates,
    nodes,
    stateLoaded,
    stateError,
    collectorEnabled,
    gateLoaded,
}: ClusterSearchProps): ClusterSearchState => {
    const location = useLocation();
    const navigate = useNavigate();

    // The URL holds the submitted search; the box holds what is being typed.
    const submitted = readSearchParam(location.search);
    const query = React.useMemo(() => detectSearchQuery(submitted), [submitted]);

    // Bumped to repeat the search that is already in the URL.
    const [run, setRun] = React.useState(0);
    const [pending, setPending] = React.useState(false);
    // The last finished search. It stays on screen while the next one runs.
    const [answer, setAnswer] = React.useState<Answer | null>(null);

    React.useEffect(() => {
        if (!query) {
            setAnswer(null);
            setPending(false);
            return undefined;
        }
        if (!gateLoaded) {
            setPending(true);
            return undefined;
        }
        if (!collectorEnabled) {
            setAnswer({ query, outcome: { state: 'disabled' } });
            setPending(false);
            return undefined;
        }
        let cancelled = false;
        setPending(true);
        fetchCollectorLookup(query.kind, query.value)
            .then((response): CollectorOutcome => ({ state: 'searched', response }))
            .catch((error: unknown): CollectorOutcome => {
                const message = error instanceof Error ? error.message : 'The collector request failed';
                return error instanceof CollectorRequestError
                    ? { state: 'rejected', message }
                    : { state: 'unreachable', message };
            })
            .then((outcome) => {
                if (cancelled) return;
                setAnswer({ query, outcome });
                setPending(false);
            });
        return () => {
            cancelled = true;
        };
    }, [query, run, gateLoaded, collectorEnabled]);

    const submit = (value: string) => {
        const text = value.trim();
        if (text === submitted) {
            if (text !== '') setRun((count) => count + 1);
            return;
        }
        navigate(
            { pathname: location.pathname, search: withSearchParam(location.search, text), hash: location.hash },
            { replace: true, state: location.state },
        );
    };

    // A watch that has not loaded hands over nothing; the constants keep the
    // memo below from recomputing on every render until it does.
    const sources = React.useMemo(
        () => ({ nodeNetworkStates: nodeNetworkStates ?? NO_STATES, nodes: nodes ?? NO_NODES }),
        [nodeNetworkStates, nodes],
    );
    const results = React.useMemo(
        () => (answer ? buildClusterSearchResults(answer.query, answer.outcome, sources) : null),
        [answer, sources],
    );

    const busy = query !== null && (pending || !stateLoaded);

    return { submitted, query, submit, busy, results, stateLoaded, stateError };
};

/** The search box. It holds what is being typed; the search itself is the owner's. */
export const ClusterSearchInput: React.FC<{ search: ClusterSearchState }> = ({ search }) => {
    const { submitted, submit } = search;
    const [input, setInput] = React.useState(submitted);
    const seenSubmitted = React.useRef(submitted);
    React.useEffect(() => {
        if (seenSubmitted.current === submitted) return;
        seenSubmitted.current = submitted;
        setInput(submitted);
    }, [submitted]);

    return (
        <SearchInput
            aria-label="Find an IP, CIDR, MAC or name in the cluster"
            placeholder="IP address, CIDR, MAC, or part of a pod, VM, network or interface name"
            value={input}
            onChange={(_event, value) => setInput(value)}
            onSearch={(_event, value) => submit(value)}
            onClear={() => {
                setInput('');
                submit('');
            }}
            submitSearchButtonLabel="Search"
        />
    );
};

/**
 * Everything the search says back: the line that reports a search under way (or,
 * with nothing searched, what Enter will do), then the last finished answer.
 */
export const ClusterSearchResultsPanel: React.FC<{ search: ClusterSearchState }> = ({ search }) => {
    const { query, busy, results, stateLoaded, stateError } = search;
    return (
        <>
            <div aria-live="polite" style={{ marginTop: 8 }}>
                {busy && query ? (
                    <Flex spaceItems={{ default: 'spaceItemsSm' }} alignItems={{ default: 'alignItemsCenter' }} data-testid="search-status">
                        <FlexItem><Spinner size="md" aria-label="Searching" /></FlexItem>
                        <FlexItem>Searching for {describeSearchQuery(query)}…</FlexItem>
                    </Flex>
                ) : (
                    !query && (
                        <span style={SUBTLE} data-testid="search-hint">
                            Press Enter to search every node: OVN ports, routers, NAT rules and Service VIPs, node
                            interfaces and kernel routes.
                        </span>
                    )
                )}
            </div>
            {results && (
                <Results
                    key={describeSearchQuery(results.query)}
                    results={results}
                    stateError={stateError}
                    settled={stateLoaded}
                />
            )}
        </>
    );
};

/** The overview's "Find in cluster" card: the box over its answer, one lookup behind both. */
const ClusterSearch: React.FC<ClusterSearchProps> = (props) => {
    const search = useClusterSearch(props);
    return (
        <Card data-testid="overview-search">
            <CardTitle>Find in cluster</CardTitle>
            <CardBody>
                <ClusterSearchInput search={search} />
                <ClusterSearchResultsPanel search={search} />
            </CardBody>
        </Card>
    );
};

export default ClusterSearch;
