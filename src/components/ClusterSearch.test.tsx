import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import { LookupHit, LookupResponse, NodeNetworkState } from '../types';
import ClusterSearch, { ClusterSearchProps } from './ClusterSearch';
import { LocationRecord, TestRouter } from './testRouter';

// Every address here is from a documentation range (RFC 5737, RFC 3849).

const GENERATED_AT = new Date().toISOString();

const hit = (overrides: Partial<LookupHit> = {}): LookupHit => ({
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
    ...overrides,
});

const lookup = (hits: LookupHit[], overrides: Partial<LookupResponse> = {}): LookupResponse => ({
    query: { kind: 'ip', value: '203.0.113.70' },
    hits,
    total: hits.length,
    limit: 200,
    truncated: false,
    zones: ['node-a', 'node-b'].map((node) => ({ node, snapshotGeneratedAt: GENERATED_AT, sourceHealth: 'healthy' })),
    warnings: [],
    ...overrides,
});

const coveringRoute = (node: string, router: string, prefix: string): LookupHit =>
    hit({
        node,
        table: 'Logical_Router_Static_Route',
        rowName: undefined,
        construct: { kind: 'router', name: router, uuid: `${router}-${node}` },
        owner: undefined,
        matchedField: 'ipPrefix',
        matchedValue: prefix,
        matchType: 'containment',
    });

const ok = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) });

const states = [
    {
        metadata: { name: 'node-a' },
        status: {
            currentState: {
                interfaces: [
                    { name: 'ens4', type: 'ethernet', state: 'up', 'mac-address': '02:00:00:AA:BB:46', ipv4: { address: [{ ip: '198.51.100.20', 'prefix-length': 24 }] } },
                ],
                routes: {
                    running: [
                        { destination: '198.51.100.0/24', 'next-hop-address': '0.0.0.0', 'next-hop-interface': 'ens4', 'table-id': 254 },
                    ],
                },
            },
        },
    },
] as unknown as NodeNetworkState[];

const nodes = ['node-a', 'node-b'].map((name) => ({ metadata: { name } })) as K8sResourceCommon[];

describe('ClusterSearch', () => {
    let container: HTMLDivElement;
    let root: Root;
    let fetchMock: jest.Mock;
    let locations: LocationRecord[];

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        locations = [];
        fetchMock = jest.fn().mockResolvedValue(ok(lookup([hit()])));
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

    const element = (props: Partial<ClusterSearchProps>, initialEntry: string) => (
        <TestRouter initialEntry={initialEntry} onLocation={(record) => locations.push(record)}>
            <ClusterSearch
                nodeNetworkStates={states}
                nodes={nodes}
                stateLoaded
                collectorEnabled
                gateLoaded
                {...props}
            />
        </TestRouter>
    );

    const render = async (props: Partial<ClusterSearchProps> = {}, initialEntry = '/ovn-recon') => {
        await act(async () => {
            root.render(element(props, initialEntry));
        });
        await flush();
    };

    const box = () => container.querySelector<HTMLInputElement>('input[aria-label="Find an IP, CIDR, MAC or name in the cluster"]')!;

    const type = async (value: string) => {
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            setter?.call(box(), value);
            box().dispatchEvent(new Event('input', { bubbles: true }));
        });
    };

    const pressEnter = async () => {
        await act(async () => {
            box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        await flush();
    };

    const search = async (value: string) => {
        await type(value);
        await pressEnter();
    };

    const click = async (target: Element | null | undefined) => {
        expect(target).toBeTruthy();
        await act(async () => {
            (target as HTMLElement).click();
        });
        await flush();
    };

    const buttonWithText = (text: string) =>
        Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes(text));

    const lookupUrls = (): string[] =>
        fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/lookup/'));

    const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
    const text = () => container.textContent ?? '';
    const lastLocation = () => locations[locations.length - 1];

    describe('when it asks the collector', () => {
        it('asks nothing while typing and exactly once on Enter', async () => {
            await render();
            expect(byTestId('search-hint')).not.toBeNull();

            // Each keystroke is a change; none of them is a request.
            for (const partial of ['2', '203.0', '203.0.113.7', '203.0.113.70']) {
                await type(partial);
            }
            expect(fetchMock).not.toHaveBeenCalled();
            expect(byTestId('search-results')).toBeNull();

            await pressEnter();
            expect(lookupUrls()).toEqual(['/api/plugins/ovn-recon/api/v1/lookup/ip/203.0.113.70']);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(byTestId('search-results')).not.toBeNull();
        });

        it('submits from the search button as well', async () => {
            await render();
            await type('203.0.113.70');
            await click(container.querySelector('button[aria-label="Search"]'));
            expect(lookupUrls()).toHaveLength(1);
        });

        it('asks nothing for an empty box', async () => {
            await render();
            await search('   ');
            expect(fetchMock).not.toHaveBeenCalled();
            expect(byTestId('search-results')).toBeNull();
            expect(byTestId('search-hint')).not.toBeNull();
        });

        it.each([
            ['203.0.113.70', '/lookup/ip/203.0.113.70', 'IP 203.0.113.70'],
            ['2001:DB8:0:0::10', '/lookup/ip/2001%3Adb8%3A%3A10', 'IP 2001:db8::10'],
            ['203.0.113.70/26', '/lookup/cidr/203.0.113.64%2F26', 'CIDR 203.0.113.64/26'],
            ['02-00-00-AA-BB-46', '/lookup/mac/02%3A00%3A00%3Aaa%3Abb%3A46', 'MAC 02:00:00:aa:bb:46'],
            ['thanos-querier', '/lookup/name/thanos-querier', 'name "thanos-querier"'],
        ])('reads "%s" and says how it was read', async (input, path, described) => {
            let release: (value: unknown) => void = () => undefined;
            fetchMock.mockReturnValue(new Promise((resolve) => {
                release = resolve;
            }));
            await render();
            await search(input);

            // The value travels in the path. The console drops query strings
            // on the way to the collector, so there must be none.
            expect(lookupUrls()).toEqual([`/api/plugins/ovn-recon/api/v1${path}`]);
            expect(lookupUrls()[0]).not.toContain('?');
            expect(byTestId('search-status')!.textContent).toBe(`Searching for ${described}…`);
            expect(container.querySelector('[role="progressbar"]')).not.toBeNull();

            release(ok(lookup([])));
            await flush();
            expect(byTestId('search-status')).toBeNull();
            expect(text()).toContain(`Results for ${described}`);
        });

        it('keeps the previous results on screen until the new ones arrive', async () => {
            await render();
            await search('203.0.113.70');
            expect(text()).toContain('shop_web-7b7bd6f866-nhwtv');

            let release: (value: unknown) => void = () => undefined;
            fetchMock.mockReturnValue(new Promise((resolve) => {
                release = resolve;
            }));
            await search('203.0.113.71');

            expect(byTestId('search-status')!.textContent).toBe('Searching for IP 203.0.113.71…');
            expect(text()).toContain('Results for IP 203.0.113.70');
            expect(text()).toContain('shop_web-7b7bd6f866-nhwtv');

            release(ok(lookup([hit({ rowName: 'shop_api-5d9c7c9b4-x2x7q', matchedValue: '02:00:00:00:00:47 203.0.113.71' })])));
            await flush();
            expect(byTestId('search-status')).toBeNull();
            expect(text()).toContain('Results for IP 203.0.113.71');
            expect(text()).toContain('shop_api-5d9c7c9b4-x2x7q');
            expect(text()).not.toContain('shop_web-7b7bd6f866-nhwtv');
        });

        it('ignores an answer that a newer search has overtaken', async () => {
            const releases: ((value: unknown) => void)[] = [];
            fetchMock.mockImplementation(() => new Promise((resolve) => {
                releases.push(resolve);
            }));
            await render();
            await search('203.0.113.70');
            await search('203.0.113.71');

            releases[1](ok(lookup([hit({ rowName: 'shop_second' })])));
            await flush();
            releases[0](ok(lookup([hit({ rowName: 'shop_first' })])));
            await flush();

            expect(text()).toContain('shop_second');
            expect(text()).not.toContain('shop_first');
        });

        it('waits for the collector gate before deciding whether to ask', async () => {
            await render({ gateLoaded: false, collectorEnabled: false }, '/ovn-recon?q=203.0.113.70');
            expect(fetchMock).not.toHaveBeenCalled();
            expect(byTestId('search-status')).not.toBeNull();
            expect(byTestId('search-partial')).toBeNull();

            await act(async () => {
                root.render(element({ gateLoaded: true, collectorEnabled: true }, '/ovn-recon?q=203.0.113.70'));
            });
            await flush();
            expect(lookupUrls()).toHaveLength(1);
            expect(byTestId('search-status')).toBeNull();
        });
    });

    describe('results', () => {
        it('groups hits by kind and links each to the view that shows it', async () => {
            fetchMock.mockResolvedValue(ok(lookup([
                hit(),
                hit({
                    rowName: 'shop_virt-launcher-db-1-x7k2p',
                    construct: { kind: 'switch', name: 'cluster_udn_blue_ovn_layer2_switch', uuid: 's' },
                    network: 'cluster_udn_blue',
                    owner: { kind: 'Pod', namespace: 'shop', name: 'virt-launcher-db-1-x7k2p' },
                }),
                hit({
                    table: 'Logical_Router_Port',
                    rowName: 'rtos-node-a',
                    construct: { kind: 'router', name: 'ovn_cluster_router', uuid: 'r' },
                    owner: undefined,
                    matchedField: 'networks',
                    matchedValue: '203.0.113.65/26',
                }),
                hit({
                    table: 'Load_Balancer',
                    rowName: 'Service_shop/web_TCP_cluster',
                    construct: undefined,
                    owner: { kind: 'Service', namespace: 'shop', name: 'web' },
                    matchedField: 'vips',
                    matchedValue: '203.0.113.70:443',
                }),
            ])));
            await render();
            await search('203.0.113.70');

            const pods = byTestId('search-group-pod-port')!;
            expect(pods.textContent).toContain('Pod and VM ports (2)');
            expect(pods.textContent).toContain('Switch port on switch node-a');
            expect(pods.querySelector('a[href="/ovn-recon/ovn/node-a?select=switch:node-a"]')!.textContent).toBe('Logical view');
            expect(pods.querySelector('a[href="/k8s/ns/shop/core~v1~Pod/web-7b7bd6f866-nhwtv"]')!.textContent).toBe('shop/web-7b7bd6f866-nhwtv');
            // Each hit names its network; a user-defined one links to its resource.
            expect(pods.textContent).toContain('Default cluster network');
            expect(pods.querySelector('a[href="/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/blue"]')!.textContent).toBe('blue');
            expect(pods.textContent).toContain('(VM db-1)');

            const routers = byTestId('search-group-router-port')!;
            expect(routers.querySelector('a[href="/ovn-recon/ovn/node-a?select=router:ovn_cluster_router"]')).not.toBeNull();

            const services = byTestId('search-group-service-vip')!;
            // One row per Service and address: the port is a chip, the zones are counted.
            expect(services.textContent).toContain('VIP 203.0.113.70');
            expect(services.textContent).toContain('443/TCP');
            expect(services.textContent).toContain('Programmed in 1 of 2 zones');
            expect(services.textContent).toContain('not in node-b');
            expect(services.querySelector('a[href="/k8s/ns/shop/core~v1~Service/web"]')!.textContent).toBe('shop/web');
            expect(services.querySelector('a[data-view="logical"]')).toBeNull();

            expect(text()).toContain('Results for IP 203.0.113.70 · 4 results');
            expect(byTestId('search-searched')!.textContent).toMatch(
                /^Searched 2 collector zone snapshots \(oldest collected [^)]+\) and the NodeNetworkState of 1 node\.$/,
            );
            expect(byTestId('search-partial')).toBeNull();
        });

        it('merges hits from the watched NodeNetworkStates, linked to the physical view', async () => {
            fetchMock.mockResolvedValue(ok(lookup([
                hit({ rowName: 'k8s-node-a', owner: undefined, matchedValue: '02:00:00:aa:bb:46 198.51.100.20' }),
            ])));
            await render();
            await search('02:00:00:aa:bb:46');

            expect(byTestId('search-group-switch-port')).not.toBeNull();
            const interfaces = byTestId('search-group-node-interface')!;
            expect(interfaces.textContent).toContain('ens4');
            expect(interfaces.textContent).toContain('MAC 02:00:00:AA:BB:46');
            expect(interfaces.querySelector('a[href="/ovn-recon/node-network-state/node-a?select=iface:ens4"]')!.textContent).toBe('Physical view');
            expect(container.querySelectorAll('[data-testid="search-result"][data-source="collector"]')).toHaveLength(1);
            expect(container.querySelectorAll('[data-testid="search-result"][data-source="cluster"]')).toHaveLength(1);
        });

        it('folds a result seen in many zones and reveals the rest on request', async () => {
            const zones = ['node-a', 'node-b', 'node-c', 'node-d', 'node-e'];
            fetchMock.mockResolvedValue(ok(lookup(zones.map((node) => hit({
                node,
                table: 'Logical_Router_Port',
                rowName: 'rtoj-ovn_cluster_router',
                construct: { kind: 'router', name: 'ovn_cluster_router', uuid: node },
                owner: undefined,
                matchedField: 'networks',
                matchedValue: '203.0.113.1/26',
            })))));
            await render();
            await search('203.0.113.1');

            expect(container.querySelectorAll('[data-testid="search-result"]')).toHaveLength(1);
            expect(container.querySelectorAll('a[data-view="logical"]')).toHaveLength(3);
            expect(container.querySelector('a[href="/ovn-recon/ovn?select=router:ovn_cluster_router"]')!.textContent).toBe('Cluster view');

            await click(buttonWithText('and 2 more zones'));
            expect(container.querySelectorAll('a[data-view="logical"]')).toHaveLength(5);
            expect(container.querySelector('a[href="/ovn-recon/ovn/node-e?select=router:ovn_cluster_router"]')).not.toBeNull();
        });

        it('keeps covering routes folded, collapsed and out of the result groups', async () => {
            fetchMock.mockResolvedValue(ok(lookup([
                hit(),
                ...['node-a', 'node-b'].flatMap((node) => [
                    coveringRoute(node, 'ovn_cluster_router', '203.0.113.0/24'),
                    coveringRoute(node, 'ovn_cluster_router', '203.0.113.64/26'),
                    coveringRoute(node, `GR_${node}`, '203.0.113.0/24'),
                ]),
            ])));
            await render();
            await search('203.0.113.70');

            // One exact result; six covering hits counted but not listed with it.
            expect(container.querySelectorAll('[data-testid="search-result"]')).toHaveLength(1);
            expect(text()).toContain('1 result · 6 covering routes and subnets');
            expect(byTestId('search-group-route')).toBeNull();

            const covering = byTestId('search-covering')!;
            const toggle = buttonWithText('Routes and subnets that cover 203.0.113.70 (6 in 3 groups)');
            expect(toggle!.getAttribute('aria-expanded')).toBe('false');
            expect(covering.querySelectorAll('[data-testid="search-covering-entry"]')).toHaveLength(0);

            await click(toggle);
            const groups = Array.from(covering.querySelectorAll('[data-testid="search-covering-group"]'));
            expect(groups.map((group) => group.querySelector('button')!.textContent)).toEqual([
                'Router ovn_cluster_router · Default cluster network · 2 prefixes · 2 zones',
                'Router GR_node-a · Default cluster network · 1 prefix',
                'Router GR_node-b · Default cluster network · 1 prefix',
            ]);
            // Each group opens on its own.
            expect(covering.querySelectorAll('[data-testid="search-covering-entry"]')).toHaveLength(0);
            await click(groups[0].querySelector('button'));
            const entries = Array.from(groups[0].querySelectorAll('[data-testid="search-covering-entry"]'));
            expect(entries.map((entry) => entry.querySelector('td')!.textContent)).toEqual([
                'Static route 203.0.113.64/26',
                'Static route 203.0.113.0/24',
            ]);
            expect(groups[0].querySelector('a[href="/ovn-recon/ovn/node-b?select=router:ovn_cluster_router"]')).not.toBeNull();
            expect(groups[0].querySelector('a[href="/ovn-recon/ovn?select=router:ovn_cluster_router"]')).not.toBeNull();
        });

        it('opens the covering routes when nothing holds the address itself', async () => {
            fetchMock.mockResolvedValue(ok(lookup([coveringRoute('node-a', 'ovn_cluster_router', '198.51.100.0/24')])));
            await render();
            await search('198.51.100.77');

            expect(byTestId('search-empty')!.textContent).toContain('Nothing holds IP 198.51.100.77 itself');
            expect(buttonWithText('Routes and subnets that cover 198.51.100.77')!.getAttribute('aria-expanded')).toBe('true');
            // The collector's router and the node's own kernel table, side by side.
            expect(Array.from(container.querySelectorAll('[data-testid="search-covering-group"]')).map((group) => group.querySelector('button')!.textContent)).toEqual([
                'Router ovn_cluster_router · Default cluster network · 1 prefix',
                'Kernel routes on node-a · 1 prefix',
            ]);
        });
    });

    describe('states', () => {
        it('says what was searched and where when nothing matches', async () => {
            fetchMock.mockResolvedValue(ok(lookup([])));
            await render();
            await search('192.0.2.99');

            expect(byTestId('search-empty')!.textContent).toBe(
                'No match for IP 192.0.2.99 in 2 collector zone snapshots and the NodeNetworkState of 1 node.',
            );
            expect(container.querySelectorAll('[data-testid="search-result"]')).toHaveLength(0);
            expect(byTestId('search-covering')).toBeNull();
            expect(byTestId('search-partial')).toBeNull();
        });

        it('does not claim "no match" while NodeNetworkState is still loading', async () => {
            fetchMock.mockResolvedValue(ok(lookup([])));
            await render({ stateLoaded: false, nodeNetworkStates: undefined }, '/ovn-recon?q=192.0.2.99');
            expect(byTestId('search-empty')).toBeNull();
            expect(byTestId('search-status')).not.toBeNull();
        });

        it('shows the cluster hits and says the result is partial when the collector is disabled', async () => {
            await render({ collectorEnabled: false });
            await search('198.51.100.20');

            expect(fetchMock).not.toHaveBeenCalled();
            expect(byTestId('search-group-node-interface')!.textContent).toContain('ens4');
            const partial = byTestId('search-partial')!;
            expect(partial.textContent).toContain('Partial result: the collector is not enabled');
            expect(partial.textContent).toContain('Only node interfaces, kernel routes and node addresses were searched');
            expect(byTestId('search-searched')!.textContent).toBe('Searched the NodeNetworkState of 1 node.');
        });

        it('shows the cluster hits and says the result is partial when the collector is unreachable', async () => {
            fetchMock.mockRejectedValue(new Error('connection refused'));
            await render();
            await search('198.51.100.20');

            expect(byTestId('search-group-node-interface')!.textContent).toContain('ens4');
            const partial = byTestId('search-partial')!;
            expect(partial.textContent).toContain('Partial result: the collector could not be reached');
            expect(partial.textContent).toContain('connection refused');
            expect(byTestId('search-status')).toBeNull();
        });

        it('says so when neither half finds anything and the collector is unreachable', async () => {
            fetchMock.mockRejectedValue(new Error('connection refused'));
            await render();
            await search('192.0.2.99');
            expect(byTestId('search-empty')!.textContent).toBe('No match for IP 192.0.2.99 in the NodeNetworkState of 1 node.');
            expect(byTestId('search-partial')).not.toBeNull();
        });

        it("shows the collector's reason inline when it rejects the value", async () => {
            const reason = '"198.51.100.20" is not an IP address; expected /api/v1/lookup/<ip|mac|cidr|name>/<value>';
            fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => `${reason}\n`, json: async () => ({}) });
            await render();
            await search('198.51.100.20');

            const rejected = byTestId('search-rejected')!;
            expect(rejected.textContent).toContain('The collector could not search for IP 198.51.100.20');
            expect(rejected.textContent).toContain(reason);
            // A refusal is an answer: no other proxy prefix is tried.
            expect(fetchMock).toHaveBeenCalledTimes(1);
            // What the browser found on its own is still shown.
            expect(byTestId('search-group-node-interface')!.textContent).toContain('ens4');
        });

        it('names the zones that were not searched, the warnings and a cut result', async () => {
            fetchMock.mockResolvedValue(ok(lookup([hit()], {
                total: 412,
                limit: 1,
                truncated: true,
                zones: [{ node: 'node-a', snapshotGeneratedAt: GENERATED_AT, sourceHealth: 'healthy' }],
                warnings: [{ code: 'ZONE_NOT_CACHED', message: 'node-b: no cached snapshot; not searched' }],
            })));
            await render();
            await search('203.0.113.70');

            const partial = byTestId('search-partial')!;
            expect(partial.textContent).toContain('Partial result');
            expect(partial.textContent).toContain('their OVN zones were not searched: node-b');
            expect(partial.textContent).toContain('ZONE_NOT_CACHED: node-b: no cached snapshot; not searched');
            expect(partial.textContent).toContain('returned the first 1 of 412 matches');
            expect(byTestId('search-searched')!.textContent).toContain('1 collector zone snapshot');
        });

        it('says so when NodeNetworkState could not be read', async () => {
            await render({ nodeNetworkStates: [], stateError: 'nodenetworkstates.nmstate.io is forbidden' });
            await search('203.0.113.70');
            expect(byTestId('search-state-error')!.textContent).toContain('nodenetworkstates.nmstate.io is forbidden');
            expect(byTestId('search-group-pod-port')).not.toBeNull();
        });
    });

    describe('the search in the page URL', () => {
        it('writes the submitted search to ?q= without adding a history entry', async () => {
            await render({}, '/ovn-recon?keep=1');
            await search('203.0.113.0/24');

            expect(lastLocation()).toMatchObject({ pathname: '/ovn-recon', search: '?keep=1&q=203.0.113.0/24', navigationType: 'REPLACE' });
        });

        it('runs the search in the URL once on arrival and shows it in the box', async () => {
            await render({}, '/ovn-recon?q=203.0.113.70');

            expect(box().value).toBe('203.0.113.70');
            expect(lookupUrls()).toEqual(['/api/plugins/ovn-recon/api/v1/lookup/ip/203.0.113.70']);
            expect(text()).toContain('shop_web-7b7bd6f866-nhwtv');
        });

        it('repeats the search when the same text is submitted again', async () => {
            await render({}, '/ovn-recon?q=203.0.113.70');
            await pressEnter();
            expect(lookupUrls()).toHaveLength(2);
            expect(lastLocation().search).toBe('?q=203.0.113.70');
        });

        it('clears the results and the parameter with the box', async () => {
            await render({}, '/ovn-recon?q=203.0.113.70');
            expect(byTestId('search-results')).not.toBeNull();

            await click(container.querySelector('button[aria-label="Reset"]'));
            expect(box().value).toBe('');
            expect(lastLocation().search).toBe('');
            expect(byTestId('search-results')).toBeNull();
            expect(byTestId('search-hint')).not.toBeNull();
            expect(lookupUrls()).toHaveLength(1);
        });
    });

    describe('one line per answer (ovn-recon-tpp.8)', () => {
        const lb = (node: string, rowName: string, vip: string): LookupHit =>
            hit({
                node,
                table: 'Load_Balancer',
                rowName,
                construct: undefined,
                owner: { kind: 'Service', namespace: 'openshift-dns', name: 'dns-default' },
                matchedField: 'vips',
                matchedValue: vip,
            });

        it('shows a Service VIP once, with its ports and zones, and its load balancer rows on request', async () => {
            fetchMock.mockResolvedValue(ok(lookup([
                lb('node-a', 'Service_openshift-dns/dns-default_TCP_node_router_node-a', '198.51.100.10:53'),
                lb('node-a', 'Service_openshift-dns/dns-default_UDP_node_router_node-a', '198.51.100.10:53'),
                lb('node-b', 'Service_openshift-dns/dns-default_TCP_node_router_node-b', '198.51.100.10:53'),
                lb('node-b', 'Service_openshift-dns/dns-default_UDP_node_router_node-b', '198.51.100.10:53'),
                lb('node-a', 'Service_openshift-dns/dns-default_TCP_cluster', '198.51.100.10:9154'),
                lb('node-b', 'Service_openshift-dns/dns-default_TCP_cluster', '198.51.100.10:9154'),
            ], { query: { kind: 'ip', value: '198.51.100.10' } })));
            await render();
            await search('198.51.100.10');

            const services = byTestId('search-group-service-vip')!;
            expect(services.textContent).toContain('Service VIPs (1)');
            expect(services.querySelectorAll('[data-testid="search-result"]')).toHaveLength(1);
            expect(Array.from(services.querySelectorAll('.pf-v6-c-label')).map((label) => label.textContent)).toEqual([
                '53/TCP', '53/UDP', '9154/TCP',
            ]);
            expect(byTestId('search-zone-count')!.textContent).toBe('Programmed in 2 of 2 zones');
            expect(services.querySelector('a[href="/k8s/ns/openshift-dns/core~v1~Service/dns-default"]')).not.toBeNull();
            expect(byTestId('search-member')).toBeNull();

            await click(buttonWithText('Show the 5 load balancer rows'));
            const members = Array.from(container.querySelectorAll('[data-testid="search-member"]'));
            expect(members.map((member) => member.firstElementChild!.textContent)).toEqual([
                'Service_openshift-dns/dns-default_TCP_cluster',
                'Service_openshift-dns/dns-default_TCP_node_router_node-a',
                'Service_openshift-dns/dns-default_UDP_node_router_node-a',
                'Service_openshift-dns/dns-default_TCP_node_router_node-b',
                'Service_openshift-dns/dns-default_UDP_node_router_node-b',
            ]);
            // The cluster-wide row says its own port, which is not the VIP's alone.
            expect(members[0].textContent).toContain('VIP 198.51.100.10:9154');
        });

        it('leads a name search with the exact node interface and folds per-node ports, keeping each link', async () => {
            fetchMock.mockResolvedValue(ok(lookup(['node-a', 'node-b'].map((node) => hit({
                node,
                rowName: `ens4_${node}`,
                construct: { kind: 'switch', name: `ext_${node}`, uuid: node },
                owner: undefined,
                matchedField: 'name',
                matchedValue: `ens4_${node}`,
                matchType: 'substring',
            })), { query: { kind: 'name', value: 'ens4' } })));
            await render();
            await search('ens4');

            const groups = Array.from(container.querySelectorAll('[data-testid^="search-group-"]')).map((group) => group.getAttribute('data-testid'));
            expect(groups).toEqual(['search-group-node-interface', 'search-group-switch-port']);
            const ports = byTestId('search-group-switch-port')!;
            expect(ports.querySelectorAll('[data-testid="search-result"]')).toHaveLength(1);
            expect(ports.textContent).toContain('ens4_<node>');
            expect(ports.textContent).toContain('starts with the text');
            expect(ports.textContent).toContain('On 2 nodes: node-a, node-b');

            await click(buttonWithText('Show the 2 rows'));
            expect(ports.querySelector('a[href="/ovn-recon/ovn/node-a?select=switch:ext_node-a"]')!.textContent).toBe('Logical view');
            expect(ports.querySelector('a[href="/ovn-recon/ovn/node-b?select=switch:ext_node-b"]')!.textContent).toBe('Logical view');
        });

        it('lists the groups with their counts only above two groups', async () => {
            const routerPort = hit({
                table: 'Logical_Router_Port',
                rowName: 'rtoe-GR_node-a',
                construct: { kind: 'router', name: 'GR_node-a', uuid: 'r' },
                owner: undefined,
                matchedField: 'networks',
                matchedValue: '198.51.100.20/24',
            });
            fetchMock.mockResolvedValue(ok(lookup([routerPort], { query: { kind: 'ip', value: '198.51.100.20' } })));
            await render();
            await search('198.51.100.20');
            expect(container.querySelectorAll('[data-testid^="search-group-"]')).toHaveLength(2);
            expect(byTestId('search-jump-list')).toBeNull();

            fetchMock.mockResolvedValue(ok(lookup([
                routerPort,
                hit({ table: 'NAT', rowName: undefined, construct: { kind: 'router', name: 'GR_node-a', uuid: 'r' }, owner: undefined, matchedField: 'externalIp', matchedValue: '198.51.100.20' }),
            ], { query: { kind: 'ip', value: '198.51.100.20' } })));
            await click(container.querySelector('button[aria-label="Search"]'));
            const jump = byTestId('search-jump-list')!;
            expect(jump.textContent).toBe('Jump to: Router ports (1) · NAT rules (1) · Node interfaces (1) · Covering routes and subnets (1)');
            expect(container.querySelector('#ovn-recon-search-nat')).not.toBeNull();

            // The covering section opens when it is jumped to.
            const coveringToggle = () => byTestId('search-covering')!.querySelector('button')!;
            expect(coveringToggle().getAttribute('aria-expanded')).toBe('false');
            await click(buttonWithText('Covering routes and subnets (1)'));
            expect(coveringToggle().getAttribute('aria-expanded')).toBe('true');
        });
    });
});
