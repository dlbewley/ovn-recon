import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import { LookupResponse, NodeNetworkState } from '../types';
import {
    ClusterSearchInput,
    ClusterSearchProps,
    ClusterSearchResultsPanel,
    ClusterSearchState,
    useClusterSearch,
} from './ClusterSearch';
import { LocationRecord, TestRouter } from './testRouter';

/**
 * The search as a lookup hook, a box and a results panel (ovn-recon-gbr.3): a parent
 * owns the lookup and puts the box and the answer in different places. The card the
 * overview draws from the same three pieces is held by ClusterSearch.test.tsx, which
 * this change left as it was.
 */

// Every address here is from a documentation range (RFC 5737).

const GENERATED_AT = new Date().toISOString();

const lookup = (): LookupResponse => ({
    query: { kind: 'ip', value: '203.0.113.70' },
    hits: [{
        node: 'node-a',
        table: 'Logical_Switch_Port',
        rowUuid: 'row',
        rowName: 'shop_web-7b7bd6f866-nhwtv',
        construct: { kind: 'switch', name: 'node-a', uuid: 'switch' },
        network: 'default',
        owner: { kind: 'Pod', namespace: 'shop', name: 'web-7b7bd6f866-nhwtv' },
        matchedField: 'addresses',
        matchedValue: '02:00:00:00:00:46 203.0.113.70',
        matchType: 'exact',
        snapshotGeneratedAt: GENERATED_AT,
    }],
    total: 1,
    limit: 200,
    truncated: false,
    zones: ['node-a', 'node-b'].map((node) => ({ node, snapshotGeneratedAt: GENERATED_AT, sourceHealth: 'healthy' })),
    warnings: [],
});

const states = [{ metadata: { name: 'node-a' }, status: { currentState: { interfaces: [] } } }] as unknown as NodeNetworkState[];
const nodes = ['node-a', 'node-b'].map((name) => ({ metadata: { name } })) as K8sResourceCommon[];

const SOURCES: ClusterSearchProps = {
    nodeNetworkStates: states,
    nodes,
    stateLoaded: true,
    collectorEnabled: true,
    gateLoaded: true,
};

/** A host that owns the lookup and keeps the box and the answer apart, as a title row and a pane would. */
const Host: React.FC<{ onState?: (state: ClusterSearchState) => void; showResults?: boolean }> = ({
    onState,
    showResults = true,
}) => {
    const search = useClusterSearch(SOURCES);
    onState?.(search);
    return (
        <>
            <header data-testid="host-title-row">
                <ClusterSearchInput search={search} />
            </header>
            <main data-testid="host-pane">
                {showResults && <ClusterSearchResultsPanel search={search} />}
            </main>
        </>
    );
};

describe('the cluster search in parts (ovn-recon-gbr.3)', () => {
    let container: HTMLDivElement;
    let root: Root;
    let fetchMock: jest.Mock;
    let locations: LocationRecord[];

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        locations = [];
        fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => lookup(), text: async () => '' });
        global.fetch = fetchMock as unknown as typeof fetch;
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        jest.restoreAllMocks();
    });

    const flush = async () => {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    };

    const render = async (element: React.ReactElement, initialEntry = '/a/host/page') => {
        await act(async () => {
            root.render(
                <TestRouter initialEntry={initialEntry} onLocation={(record) => locations.push(record)}>
                    {element}
                </TestRouter>,
            );
        });
        await flush();
    };

    const titleRow = () => container.querySelector('[data-testid="host-title-row"]')!;
    const pane = () => container.querySelector('[data-testid="host-pane"]')!;
    const box = () => titleRow().querySelector<HTMLInputElement>('input[aria-label="Find an IP, CIDR, MAC or name in the cluster"]')!;
    const lookupUrls = (): string[] =>
        fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/lookup/'));

    const search = async (value: string) => {
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            setter?.call(box(), value);
            box().dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => {
            box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        await flush();
    };

    it('draws the box and the answer apart, with no card or title around either', async () => {
        await render(<Host />);

        expect(container.querySelector('.pf-v6-c-card')).toBeNull();
        expect(container.textContent).not.toContain('Find in cluster');
        expect(box()).not.toBeNull();
        // The box is only the box: the hint and the answer belong to the panel.
        expect(titleRow().querySelector('[data-testid="search-hint"]')).toBeNull();
        expect(pane().querySelector('[data-testid="search-hint"]')).not.toBeNull();
        expect(pane().querySelector('input')).toBeNull();
    });

    it('answers in the panel what is submitted in the box, with one lookup behind both', async () => {
        await render(<Host />);

        await search('203.0.113.70');

        expect(locations[locations.length - 1].search).toBe('?q=203.0.113.70');
        expect(lookupUrls()).toHaveLength(1);
        expect(lookupUrls()[0]).toContain('/lookup/ip/203.0.113.70');
        expect(titleRow().querySelector('[data-testid="search-results"]')).toBeNull();
        const results = pane().querySelector('[data-testid="search-results"]')!;
        expect(results.textContent).toContain('Results for IP 203.0.113.70');
        expect(results.querySelectorAll('[data-testid="search-result"]')).toHaveLength(1);
    });

    it('starts from the search already in the page URL', async () => {
        await render(<Host />, '/a/host/page?q=203.0.113.70');

        expect(box().value).toBe('203.0.113.70');
        expect(lookupUrls()).toHaveLength(1);
        expect(pane().querySelector('[data-testid="search-results"]')).not.toBeNull();
    });

    it('gives the owner the answer whether or not the panel is drawn', async () => {
        const seen: ClusterSearchState[] = [];
        await render(<Host showResults={false} onState={(state) => seen.push(state)} />);

        await search('203.0.113.70');

        const last = seen[seen.length - 1];
        expect(pane().textContent).toBe('');
        expect(last.submitted).toBe('203.0.113.70');
        expect(last.query).toMatchObject({ kind: 'ip', value: '203.0.113.70' });
        expect(last.busy).toBe(false);
        expect(last.results?.resultCount).toBe(1);
    });

    it('clears the search from the box', async () => {
        await render(<Host />, '/a/host/page?q=203.0.113.70&keep=1');

        const clear = titleRow().querySelector<HTMLButtonElement>('button[aria-label="Reset"]')!;
        await act(async () => {
            clear.click();
        });
        await flush();

        expect(locations[locations.length - 1].search).toBe('?keep=1');
        expect(pane().querySelector('[data-testid="search-results"]')).toBeNull();
        expect(pane().querySelector('[data-testid="search-hint"]')).not.toBeNull();
    });
});
