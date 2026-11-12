import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { NavigationType, Route, Routes } from 'react-router';

import { LogicalDatabase, LogicalTopologySnapshot } from '../types';
import ConstructDetails from './ConstructDetails';
import { fetchClusterTopology, fetchCollectorSnapshot, SnapshotFetchOptions } from './collectorApi';
import { LocationRecord, TestRouter } from './testRouter';
import { matchRefs, policyForPort, policyIndexFor } from './policyIndex';
import { describeOwner, networkRoleResolverFor, ownerOf } from './ovnOwner';
import { referencedAddressSets, switchPortGroups } from './policyRows';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';
import cnv2 from '../../collector/fixtures/snapshots/cnv-2.json';

const mockNodeNetworkStates: { metadata: { name: string } }[] = [];
const mockPods: unknown[] = [];
const mockGate = { enabled: true, loaded: true, loadError: undefined as Error | undefined };

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    DocumentTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useK8sWatchResource: (resource: { groupVersionKind?: { kind?: string } } | null) =>
        (resource?.groupVersionKind?.kind === 'Pod' ? [mockPods, true, undefined] : [mockNodeNetworkStates, true, undefined]),
}));

jest.mock('./useOvnCollectorFeatureGate', () => ({
    useOvnCollectorFeatureGate: () => mockGate,
}));

jest.mock('@patternfly/react-code-editor', () => ({
    CodeEditor: ({ code }: { code: string }) => <pre data-testid="code-editor">{code}</pre>,
    Language: { json: 'json' },
}));

jest.mock('./useServiceReads', () => ({
    useServiceNetworks: () => ({ serviceNetworks: ['172.30.0.0/16'], loaded: true }),
    useKubeService: () => ({ loaded: false }),
    useServiceEndpointSlices: () => ({ slices: [], loaded: false }),
}));

jest.mock('./collectorApi', () => ({
    ...jest.requireActual('./collectorApi'),
    fetchCollectorSnapshot: jest.fn(),
    fetchClusterTopology: jest.fn(),
}));
const fetchSnapshot = fetchCollectorSnapshot as jest.MockedFunction<typeof fetchCollectorSnapshot>;
const fetchCluster = fetchClusterTopology as jest.MockedFunction<typeof fetchClusterTopology>;

const SECTION_KEYS: Array<keyof LogicalDatabase> = ['acls', 'portGroups', 'addressSets', 'loadBalancers', 'loadBalancerGroups'];

/** The fixture as the ladder request returns it: no optional sections. */
const ladderSnapshot = (fixture: unknown): LogicalTopologySnapshot => {
    const snapshot = fixture as LogicalTopologySnapshot;
    const database = { ...snapshot.database } as LogicalDatabase;
    for (const key of SECTION_KEYS) delete database[key];
    return { ...snapshot, database };
};

const FIXTURES: Record<string, unknown> = { 'cnv-1': cnv1, 'cnv-2': cnv2 };

/** Each request, as (node, include). */
const requests = () =>
    fetchSnapshot.mock.calls.map(([node, options]) => [node, [...((options as SnapshotFetchOptions | undefined)?.include ?? [])]]);

describe('ConstructDetails', () => {
    let container: HTMLDivElement;
    let root: Root;
    let locations: LocationRecord[];
    const current = () => locations[locations.length - 1];

    /** A fresh mount at a URL: a MemoryRouter reads its initial entry once. */
    const renderAt = async (entry: string) => {
        act(() => root.unmount());
        root = createRoot(container);
        await act(async () => {
            root.render(
                <TestRouter initialEntry={entry} onLocation={(record) => locations.push(record)}>
                    <Routes>
                        <Route path="/ovn-recon/ovn/:node/:kind/:name" element={<ConstructDetails />} />
                        <Route path="*" element={<div data-testid="elsewhere" />} />
                    </Routes>
                </TestRouter>,
            );
        });
    };

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        locations = [];
        mockNodeNetworkStates.splice(0, mockNodeNetworkStates.length);
        mockPods.splice(0, mockPods.length);
        mockGate.enabled = true;
        fetchSnapshot.mockReset();
        fetchCluster.mockReset();
        fetchSnapshot.mockImplementation(async (node, options) => {
            const fixture = FIXTURES[node];
            if (!fixture) throw new Error(`no fixture for ${node}`);
            return options?.include?.length ? (fixture as LogicalTopologySnapshot) : ladderSnapshot(fixture);
        });
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const tabLabels = () => [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    const activeTab = () => container.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
    const click = async (element: Element | null | undefined) => {
        expect(element).toBeTruthy();
        await act(async () => {
            element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    };
    const clickTab = (label: string) =>
        click([...container.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === label));
    const setValue = async (element: HTMLInputElement | HTMLSelectElement, value: string) => {
        await act(async () => {
            const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
            element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
        });
    };
    const portRows = () => [...container.querySelectorAll('tr[data-testid^="port-row-"]')];

    describe('rendering', () => {
        it('renders a switch from its node snapshot with the tabs a switch has', async () => {
            await renderAt('/ovn-recon/ovn/cnv-1/switch/cnv-1');
            expect(container.querySelector('h1')?.textContent).toContain('cnv-1');
            expect(tabLabels()).toEqual(['Overview', 'Relationships', 'Ports', 'Policy', 'Services', 'Config']);
            expect(activeTab()).toBe('Overview');
            // The overview is the drawer's, without the drawer's own link in.
            expect(container.querySelector('[data-testid="identifiers"]')).not.toBeNull();
            expect(container.querySelector('[data-testid="open-details"]')).toBeNull();
        });

        it('renders a router with a Routes and NAT tab', async () => {
            await renderAt('/ovn-recon/ovn/cnv-1/router/GR_cnv-1');
            expect(tabLabels()).toEqual(['Overview', 'Relationships', 'Services', 'Routes and NAT', 'Config']);
        });

        it('says so for an unknown kind, an unknown name and a disabled feature gate', async () => {
            await renderAt('/ovn-recon/ovn/cnv-1/port/whatever');
            expect(container.textContent).toContain('No detail page for this kind');
            expect(fetchSnapshot).not.toHaveBeenCalled();

            await renderAt('/ovn-recon/ovn/cnv-1/switch/no-such-switch');
            expect(container.querySelector('[data-testid="construct-not-in-zone"]')).not.toBeNull();
            expect(container.textContent).toContain('No Logical_Switch named no-such-switch');

            mockGate.enabled = false;
            await renderAt('/ovn-recon/ovn/cnv-1/switch/cnv-1');
            expect(container.textContent).toContain('Logical OVN view is disabled');
        });

        it('links back to both ladders with select=KIND:NAME', async () => {
            await renderAt('/ovn-recon/ovn/cnv-1/router/GR_cnv-1');
            const hrefs = [...container.querySelectorAll('nav a')].map((anchor) => anchor.getAttribute('href'));
            expect(hrefs).toEqual(['/ovn-recon', '/ovn-recon/ovn?select=router:GR_cnv-1', '/ovn-recon/ovn/cnv-1?select=router:GR_cnv-1']);
        });
    });

    describe('network behaviour', () => {
        it('loads sections per tab, only once each, never the aggregate, and never polls', async () => {
            const setIntervalSpy = jest.spyOn(window, 'setInterval');
            await renderAt('/ovn-recon/ovn/cnv-1/switch/cnv-1');
            expect(requests()).toEqual([['cnv-1', []]]);

            await clickTab('Ports');
            expect(requests()).toEqual([['cnv-1', []], ['cnv-1', ['policy']]]);

            await clickTab('Services');
            expect(requests().slice(2)).toEqual([['cnv-1', ['policy', 'services']]]);

            await clickTab('Ports');
            await clickTab('Overview');
            expect(requests()).toHaveLength(3);

            const refresh = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Refresh');
            await click(refresh);
            expect(requests().slice(3)).toEqual(
                expect.arrayContaining([['cnv-1', []], ['cnv-1', ['policy', 'services']]]),
            );
            expect(requests()).toHaveLength(5);

            expect(fetchCluster).not.toHaveBeenCalled();
            expect(setIntervalSpy.mock.calls.filter(([, delay]) => (delay ?? 0) >= 1000)).toHaveLength(0);
            setIntervalSpy.mockRestore();
        });

        it('requests the ladder snapshot and the tab section at once when landing on a tab', async () => {
            await renderAt('/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=ports');
            expect(requests()).toEqual([['cnv-1', []], ['cnv-1', ['policy']]]);
        });

        it('shows a failed section request in the tab only', async () => {
            fetchSnapshot.mockImplementation(async (node, options) => {
                if (options?.include?.length) throw new Error('section request failed');
                return ladderSnapshot(FIXTURES[node]);
            });
            await renderAt('/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=ports');
            expect(container.textContent).toContain('section request failed');
            expect(portRows().length).toBeGreaterThan(0);

            expect(container.textContent).toContain('Section rows failed to load');
            await clickTab('Overview');
            // The overview renders from the ladder snapshot; only the ACL line,
            // which reads the section, names the failure.
            expect(container.textContent).not.toContain('Section rows failed to load');
            expect(container.querySelector('[data-testid="identifiers"]')).not.toBeNull();
            expect(container.querySelector('[data-testid="policy-error"]')).not.toBeNull();
        });
    });

    describe('URL state', () => {
        it('reads tab and q from the URL and writes filter changes with replace', async () => {
            await renderAt('/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=ports&q=stor-cnv-1');
            expect(activeTab()).toBe('Ports');
            const input = container.querySelector<HTMLInputElement>('input[aria-label="Filter ports"]')!;
            expect(input.value).toBe('stor-cnv-1');
            expect(portRows()).toHaveLength(1);

            await setValue(input, 'openshift-storage');
            expect(current().search).toBe('?tab=ports&q=openshift-storage');
            expect(current().navigationType).toBe(NavigationType.Replace);
            expect(portRows().length).toBeGreaterThan(1);
        });

        it('switches tabs with replace, dropping the filter', async () => {
            await renderAt('/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=ports&q=stor');
            await clickTab('Config');
            expect(current().search).toBe('?tab=config');
            expect(current().navigationType).toBe(NavigationType.Replace);
            await clickTab('Overview');
            expect(current().search).toBe('');
        });

        it('paginates the ports and expands, turns to and records the port in the URL', async () => {
            await renderAt('/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=ports');
            // 75 ports, 50 to a page.
            expect(portRows()).toHaveLength(50);
            expect(container.querySelector('[data-testid="rule-table-pager"]')).not.toBeNull();

            const row = portRows()[0];
            await click(row.querySelector('button'));
            expect(current().search).toMatch(/^\?tab=ports&port=/);
            expect(current().navigationType).toBe(NavigationType.Replace);
            const portName = new URLSearchParams(current().search).get('port')!;

            // Reloading the URL restores the expanded port.
            await renderAt(`/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=ports&port=${encodeURIComponent(portName)}`);
            expect(container.querySelectorAll('[data-testid="port-summary"]')).toHaveLength(1);
        });

        it('turns to the page of a port beyond the first', async () => {
            const database = (cnv1 as unknown as LogicalTopologySnapshot).database!;
            const switchRow = database.logicalSwitches.find((row) => row.name === 'cnv-1')!;
            const ports = database.logicalSwitchPorts.filter((port) => switchRow.ports.includes(port.uuid));
            // The model sorts ports by type then name; the last is on page two.
            const last = [...ports].sort(
                (a, b) => (a.type || 'vif').localeCompare(b.type || 'vif') || a.name.localeCompare(b.name),
            ).pop()!;
            await renderAt(`/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=ports&port=${encodeURIComponent(last.name)}`);
            expect(portRows()).toHaveLength(25);
            expect(container.querySelectorAll('[data-testid="port-summary"]')).toHaveLength(1);
        });
    });

    describe('zones', () => {
        it("moves a node-named construct to the selected node's own copy", async () => {
            mockNodeNetworkStates.push({ metadata: { name: 'cnv-2' } }, { metadata: { name: 'cnv-1' } });
            await renderAt('/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=ports');
            const select = container.querySelector<HTMLSelectElement>('select[aria-label="Node database"]')!;
            expect([...select.options].map((option) => option.value)).toEqual(['cnv-1', 'cnv-2']);

            await setValue(select, 'cnv-2');
            expect(current().pathname).toBe('/ovn-recon/ovn/cnv-2/switch/cnv-2');
            expect(current().search).toBe('?tab=ports');
            expect(current().navigationType).toBe(NavigationType.Push);
            expect(container.querySelector('[data-testid="construct-not-in-zone"]')).toBeNull();
        });

        it('keeps a cluster-wide name when moving to another node', async () => {
            mockNodeNetworkStates.push({ metadata: { name: 'cnv-2' } }, { metadata: { name: 'cnv-1' } });
            await renderAt('/ovn-recon/ovn/cnv-1/switch/transit_switch');
            const select = container.querySelector<HTMLSelectElement>('select[aria-label="Node database"]')!;
            await setValue(select, 'cnv-2');
            expect(current().pathname).toBe('/ovn-recon/ovn/cnv-2/switch/transit_switch');
        });

        it('says when the zone has no such row', async () => {
            await renderAt('/ovn-recon/ovn/cnv-2/switch/cnv-1?tab=ports');
            expect(container.querySelector('[data-testid="construct-not-in-zone"]')?.textContent).toContain(
                'node cnv-2',
            );
        });

        it('finds a construct that exists in both zones', async () => {
            await renderAt('/ovn-recon/ovn/cnv-2/router/ovn_cluster_router');
            expect(container.querySelector('[data-testid="construct-not-in-zone"]')).toBeNull();
            expect(tabLabels()).toContain('Routes and NAT');
        });
    });

    describe('tabs', () => {
        it('lists every static route and every NAT rule, grouped or one row per rule', async () => {
            await renderAt('/ovn-recon/ovn/cnv-1/router/GR_cnv-1?tab=routes');
            const natRows = () =>
                container.querySelectorAll('table[aria-label="NAT rules"] tr[data-testid^="rule-row-"]');
            expect(natRows()).toHaveLength(2);
            expect(container.textContent).not.toMatch(/and \d+ more/);
            expect(
                container.querySelectorAll('table[aria-label="Static routes"] tr[data-testid^="rule-row-"]'),
            ).toHaveLength(3);

            await click(container.querySelector('#nat-view-rules'));
            // 74 rules, 50 to a page.
            expect(natRows()).toHaveLength(50);

            const input = container.querySelector<HTMLInputElement>('input[aria-label="Filter routes and NAT"]')!;
            await setValue(input, '100.64.0.5');
            expect(natRows()).toHaveLength(1);
            expect(current().search).toBe('?tab=routes&q=100.64.0.5');
        });

        it('navigates a relationship to the peer detail page in the same zone', async () => {
            await renderAt('/ovn-recon/ovn/cnv-1/switch/join?tab=relationships');
            const peer = [...container.querySelectorAll('button')].find((button) =>
                button.textContent?.includes('(GR_cnv-1)'),
            );
            await click(peer);
            expect(current().pathname).toBe('/ovn-recon/ovn/cnv-1/router/GR_cnv-1');
            expect(current().search).toBe('?tab=relationships');
        });

        it('shows the Services body on the page', async () => {
            await renderAt('/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=services');
            expect(container.querySelector('[data-testid="services-summary"]')).not.toBeNull();
        });

        it('shows the Config rows uncapped', async () => {
            await renderAt('/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=config');
            const payload = JSON.parse(container.querySelector('[data-testid="code-editor"]')!.textContent!);
            expect(payload.ports).toHaveLength(75);
            expect(payload.portsOmitted).toBeUndefined();
        });
    });
    describe('Policy tab (cnv-1 node switch)', () => {
        const full = (cnv1 as unknown as LogicalTopologySnapshot).database as LogicalDatabase;
        const index = policyIndexFor(full);
        const nodeSwitch = full.logicalSwitches.find((row) => row.name === 'cnv-1')!;
        const acls = index.aclsBySwitch.get(nodeSwitch.uuid)!.all;
        const roleOf = networkRoleResolverFor(full);
        const aclRows = () => [...container.querySelectorAll('table[aria-label="ACLs"] tr[data-testid^="rule-row-"]')];
        const summary = () => container.querySelector('[data-testid="acl-summary"]')?.textContent ?? '';
        const select = (label: string) => container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
        const filter = () => container.querySelector<HTMLInputElement>('input[aria-label="Filter ACLs"]')!;
        const rowFor = (uuid: string) =>
            aclRows().find((candidate) => candidate.getAttribute('data-testid') === `rule-row-${uuid}`);

        it('lists every ACL on the switch, paginated', async () => {
            await renderAt('/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=policy');
            expect(requests()).toEqual([['cnv-1', []], ['cnv-1', ['policy']]]);
            expect(summary().startsWith(`${acls.length} ACLs`)).toBe(true);
            expect(aclRows()).toHaveLength(Math.min(50, acls.length));
        });

        it('narrows by direction, action and owner type', async () => {
            await renderAt('/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=policy');
            const toLport = acls.filter((acl) => acl.direction === 'to-lport');
            await setValue(select('Filter by direction'), 'to-lport');
            expect(summary().startsWith(`${toLport.length} of ${acls.length} ACLs`)).toBe(true);

            const action = toLport[0].action;
            const byAction = toLport.filter((acl) => acl.action === action);
            await setValue(select('Filter by action'), action);
            expect(summary().startsWith(`${byAction.length} of ${acls.length} ACLs`)).toBe(true);

            await setValue(select('Filter by direction'), 'all');
            await setValue(select('Filter by action'), 'all');
            const kind = describeOwner(ownerOf(acls[0].externalIds), roleOf).kind;
            const byKind = acls.filter((acl) => describeOwner(ownerOf(acl.externalIds), roleOf).kind === kind);
            expect(byKind.length).toBeLessThan(acls.length);
            await setValue(select('Filter by owner type'), kind);
            expect(summary().startsWith(`${byKind.length} of ${acls.length} ACLs`)).toBe(true);
        });

        it('sorts by priority', async () => {
            await renderAt('/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=policy');
            const header = [...container.querySelectorAll('table[aria-label="ACLs"] th button')].find(
                (button) => button.textContent === 'Priority',
            );
            await click(header);
            const priorityOf = (row: Element) => parseInt(row.querySelectorAll('td')[1].textContent ?? '', 10);
            expect(priorityOf(aclRows()[0])).toBe(Math.min(...acls.map((acl) => acl.priority)));
            await click(header);
            expect(priorityOf(aclRows()[0])).toBe(Math.max(...acls.map((acl) => acl.priority)));
        });

        it('lays the ACL columns out with Match widest and clamped to two lines', async () => {
            await renderAt('/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=policy');
            const table = container.querySelector('table[aria-label="ACLs"]')!;
            const headers = [...table.querySelectorAll('thead th')];
            // The row toggle, then five columns. Tier shares Priority's cell, direction
            // Action's, owner type Owner's and the port count Applied via's; every ACL
            // here is on one network, which the summary says once.
            expect(headers.map((th) => th.textContent)).toEqual([
                'Row expansion', 'Priority', 'Action', 'Owner', 'Applied via', 'Match',
            ]);
            expect(summary()).toContain('all on Default cluster network');
            // Match has the largest share; the two short columns hug their content.
            const widthOf = (th: Element) => Number(/pf-m-width-(\d+)/.exec(th.className)?.[1] ?? 0);
            expect(headers.map(widthOf)).toEqual([0, 0, 0, 20, 20, 45]);

            const acl = acls.reduce((longest, candidate) => (candidate.match.length > longest.match.length ? candidate : longest));
            await setValue(filter(), acl.match);
            const row = rowFor(acl.uuid)!;
            const cells = [...row.querySelectorAll('td')];
            expect(cells).toHaveLength(6);
            for (const position of [1, 2]) expect(cells[position].className).toContain('pf-m-fit-content');
            expect(cells[1].textContent).toBe(`${acl.priority}tier ${acl.tier}`);
            expect(cells[2].textContent).toBe(`${acl.action}${acl.direction}`);
            const kind = describeOwner(ownerOf(acl.externalIds), roleOf).kind;
            expect(cells[3].querySelector('[data-testid="owner-kind"]')?.textContent?.startsWith(kind)).toBe(true);
            expect(cells[4].querySelector('[data-testid="acl-via-ports"]')?.textContent).toMatch(/\d+ ports? here$/);

            // Collapsed: the whole expression is in the cell, cut to two lines by CSS, not wrapped without limit.
            const match = cells[5].querySelector<HTMLElement>('[data-testid="acl-match"]')!;
            expect(match.textContent).toBe(acl.match);
            expect(match.getAttribute('data-clamp-lines')).toBe('2');
            expect(match.style.overflow).toBe('hidden');
            expect(match.style.display).toBe('-webkit-box');
            // The owner's name and the group's keep to the lines a row allows, too.
            expect(cells[3].querySelector<HTMLElement>('[data-testid="owner-name"]')!.style.overflow).toBe('hidden');
            expect(cells[4].querySelector<HTMLElement>('[data-testid="acl-via"] div')!.style.overflow).toBe('hidden');

            // Expanded: the full expression, unclamped.
            await click(row.querySelector('button'));
            const detail = container.querySelector<HTMLElement>(`[data-testid="acl-detail-${acl.uuid}"]`)!;
            const full = [...detail.querySelectorAll('code')].find((code) => code.textContent === acl.match)!;
            expect(full).toBeDefined();
            expect(full.closest('[data-clamp-lines]')).toBeNull();
        });

        it('merges owner type into the Owner cell of port groups and address sets', async () => {
            await renderAt('/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=policy');
            await click(container.querySelector('#policy-view-groups'));
            const titles = (label: string) =>
                [...container.querySelectorAll(`table[aria-label="${label}"] thead th`)].map((th) => th.textContent);
            expect(titles('Port groups')).toEqual(['Row expansion', 'Owner', 'Network', 'OVN name', 'Ports here', 'ACLs']);
            expect(container.querySelector('table[aria-label="Port groups"] [data-testid="owner-kind"]')).not.toBeNull();
            await click(container.querySelector('#policy-view-sets'));
            expect(titles('Address sets')).toEqual(['Row expansion', 'Name', 'Owner', 'Addresses', 'ACLs naming it']);
        });

        it('links a NetworkPolicy owner', async () => {
            const linked = acls.find((acl) => describeOwner(ownerOf(acl.externalIds), roleOf).target?.kind === 'NetworkPolicy')!;
            expect(linked).toBeDefined();
            const description = describeOwner(ownerOf(linked.externalIds), roleOf);
            await renderAt(`/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=policy&q=${encodeURIComponent(description.name!)}`);
            expect(rowFor(linked.uuid)?.querySelector(`a[href="${description.target!.path}"]`)).not.toBeNull();
        });

        it('resolves @ and $ references in the expanded row', async () => {
            const withGroup = acls.find((acl) => matchRefs(acl).portGroups.some((name) => index.portGroupByName.has(name)))!;
            const withSet = acls.find((acl) => matchRefs(acl).addressSets.some((name) => index.addressSetByName.has(name)))!;
            expect(withGroup).toBeDefined();
            expect(withSet).toBeDefined();
            for (const [acl, sigil] of [[withGroup, '@'], [withSet, '$']] as const) {
                await renderAt('/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=policy');
                await setValue(filter(), acl.match);
                await click(rowFor(acl.uuid)?.querySelector('button'));
                const detail = container.querySelector(`[data-testid="acl-detail-${acl.uuid}"]`)!;
                const refs = matchRefs(acl);
                const name = sigil === '@'
                    ? refs.portGroups.find((candidate) => index.portGroupByName.has(candidate))!
                    : refs.addressSets.find((candidate) => index.addressSetByName.has(candidate))!;
                const line = [...detail.querySelectorAll('div')].find((div) => div.textContent?.startsWith(`${sigil}${name} `));
                expect(line).toBeDefined();
                expect(line!.textContent).not.toContain('unresolved');
            }
        });

        it('lists only the port groups with a port here and counts the others', async () => {
            const { here, elsewhere } = switchPortGroups(index, full, nodeSwitch.uuid);
            await renderAt('/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=policy');
            await click(container.querySelector('#policy-view-groups'));
            expect(container.querySelector('[data-testid="rule-table-summary"]')?.textContent).toContain(
                `${here.length} port groups`,
            );
            expect(container.querySelector('[data-testid="port-groups-elsewhere"]')?.textContent).toBe(
                `${elsewhere} port groups in this zone have no port here.`,
            );
        });

        it('lists the address sets the ACLs reference', async () => {
            const sets = referencedAddressSets(index, acls);
            await renderAt('/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=policy');
            await click(container.querySelector('#policy-view-sets'));
            expect(container.querySelector('[data-testid="rule-table-summary"]')?.textContent).toContain(
                `${sets.length} address sets named by the ACLs`,
            );
        });

        it('adds policy columns to Ports and lands "ACLs for this port" on the Policy tab for that port', async () => {
            await renderAt('/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=ports');
            const headers = () =>
                [...container.querySelectorAll('table[aria-label="Switch ports"] > thead th')].map((th) => th.textContent);
            expect(headers()).toEqual(['Row expansion', 'Name', 'Type', 'Addresses', 'Up', 'Port groups', 'ACLs']);

            const portUuid = nodeSwitch.ports.find((uuid) => policyForPort(index, uuid).acls.length > 1)!;
            const portName = full.logicalSwitchPorts.find((row) => row.uuid === portUuid)!.name;
            const expected = policyForPort(index, portUuid).acls.length;
            await renderAt(`/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=ports&port=${encodeURIComponent(portName)}`);
            const link = container.querySelector('[data-testid="port-acls-link"]')!;
            expect(link).not.toBeNull();
            const href = link.getAttribute('href')!;
            expect(new URLSearchParams(href.split('?')[1]).get('tab')).toBe('policy');
            expect(new URLSearchParams(href.split('?')[1]).get('port')).toBe(portName);
            const before = requests().length;
            await click(link);
            expect(activeTab()).toBe('Policy');
            expect(container.querySelector('[data-testid="policy-port"]')?.textContent).toContain(portName);
            expect(summary().startsWith(`${expected} ACLs`)).toBe(true);
            // Moving between Ports and Policy fetched nothing more.
            expect(requests()).toHaveLength(before);

            const showAll = [...container.querySelectorAll('button')].find(
                (button) => button.textContent === 'Show all ACLs on the switch',
            );
            await click(showAll);
            expect(current().search).toBe('?tab=policy');
            expect(summary().startsWith(`${acls.length} ACLs`)).toBe(true);
        });

        it('leaves the Ports policy columns out without the section', async () => {
            fetchSnapshot.mockImplementation(async (node, options) => {
                if (options?.include?.length) throw new Error('section request failed');
                return ladderSnapshot(FIXTURES[node]);
            });
            await renderAt('/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=ports');
            const headers = [...container.querySelectorAll('table[aria-label="Switch ports"] > thead th')].map((th) => th.textContent);
            expect(headers).toEqual(['Row expansion', 'Name', 'Type', 'Addresses', 'Up']);
            await clickTab('Policy');
            expect(container.querySelector('[data-testid="policy-not-collected"]')).not.toBeNull();
        });
    });
    it('opens with the findings on this construct (ovn-recon-7i6.3)', async () => {
        const port = 'openshift-mtv_forklift-volume-populator-controller-6d5f776884-cllnz';
        mockPods.push({
            metadata: { namespace: 'openshift-mtv', name: 'forklift-volume-populator-controller-6d5f776884-cllnz' },
            status: { phase: 'Running', startTime: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
        });
        fetchSnapshot.mockImplementation(async () => {
            const snapshot = JSON.parse(JSON.stringify(ladderSnapshot(cnv1))) as LogicalTopologySnapshot;
            snapshot.database!.logicalSwitchPorts.find((row) => row.name === port)!.up = false;
            return snapshot;
        });
        await renderAt('/ovn-recon/ovn/cnv-1/switch/cnv-1');

        const section = container.querySelector('[data-testid="construct-findings"]');
        expect([...(section?.querySelectorAll('[data-testid="finding"]') ?? [])].map((entry) => entry.getAttribute('data-rule')))
            .toEqual(['lsp-down']);

        // A router of the same zone carries none.
        await renderAt('/ovn-recon/ovn/cnv-1/router/ovn_cluster_router');
        expect(container.querySelector('[data-testid="construct-findings"]')).toBeNull();
    });
});
