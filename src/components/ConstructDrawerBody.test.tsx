import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { LogicalDatabase, LogicalTopologySnapshot } from '../types';
import { buildLadderModel } from './logicalLadderModel';
import ConstructDrawerBody, {
    MAX_PORT_ACLS,
    MAX_SERVICE_ROWS,
    natRuleText,
    staticRouteText,
} from './ConstructDrawerBody';
import { policyForPort, policyIndexFor } from './policyIndex';
import { fetchCollectorSnapshot } from './collectorApi';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';

jest.mock('react-router', () => ({
    Link: ({ to, children, title }: { to: string; children: React.ReactNode; title?: string }) => (
        <a href={String(to)} title={title}>{children}</a>
    ),
}));

// Monaco does not run under jsdom; the Config tab's editor renders as a pre.
jest.mock('@patternfly/react-code-editor', () => ({
    CodeEditor: ({ code }: { code: string }) => <pre data-testid="code-editor">{code}</pre>,
    Language: { json: 'json' },
}));

// The drawer loads the optional sections itself; only the request is faked.
jest.mock('./collectorApi', () => ({
    ...jest.requireActual('./collectorApi'),
    fetchCollectorSnapshot: jest.fn(),
}));
const fetchSnapshot = fetchCollectorSnapshot as jest.MockedFunction<typeof fetchCollectorSnapshot>;

const database = (cnv1 as unknown as LogicalTopologySnapshot).database as LogicalDatabase;
const model = buildLadderModel(database);
const byName = (name: string) =>
    model.constructs.find((construct) => construct.name === name);

describe('ConstructDrawerBody', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const render = (name: string) => {
        const construct = byName(name);
        expect(construct).toBeDefined();
        act(() => {
            root.render(<ConstructDrawerBody construct={construct!} model={model} />);
        });
    };

    it('lists NAT rules on a gateway router, capped with a more-note', () => {
        render('GR_cnv-1');
        const text = container.textContent ?? '';
        expect(text).toContain('NAT rules (74)');
        expect(text).toContain('snat 192.168.4.72');
        expect(text).toMatch(/and \d+ more/);
    });

    it('shows gateway port hosting resolved to a node name, falling back to the chassis id', () => {
        const construct = byName('ovn_cluster_router');
        const chassisId = '91bc7389-d1b9-4fef-9f4c-52e3eedab004';
        act(() => {
            root.render(
                <ConstructDrawerBody
                    construct={construct!}
                    model={model}
                    nodeHref={(node) => `/ovn-recon/ovn/${node}`}
                    nodeForChassis={(chassis) => (chassis === chassisId ? 'cnv-1' : undefined)}
                />,
            );
        });
        let text = container.textContent ?? '';
        expect(text).toContain('Gateway ports');
        expect(text).toContain('rtos-cnv-1');
        expect(text).toContain('hosted on cnv-1');
        expect(container.querySelector('a[href="/ovn-recon/ovn/cnv-1"]')).not.toBeNull();
        // One candidate that is also the host: no candidate list.
        expect(text).not.toContain('candidates:');

        act(() => {
            root.render(<ConstructDrawerBody construct={construct!} model={model} />);
        });
        text = container.textContent ?? '';
        expect(text).toContain('hosted on 91bc7389…');
    });

    it('flags a gateway port no chassis hosts and lists its candidates', () => {
        const base = byName('ovn_cluster_router')!;
        const construct = {
            ...base,
            gatewayPorts: [
                {
                    port: 'rtos-orphan',
                    hostingChassis: undefined,
                    candidates: [
                        { chassisName: 'chassis-a', priority: 2 },
                        { chassisName: 'chassis-b', priority: 1 },
                    ],
                },
            ],
        };
        act(() => {
            root.render(
                <ConstructDrawerBody
                    construct={construct}
                    model={model}
                    nodeForChassis={(chassis) => (chassis === 'chassis-a' ? 'node-a' : undefined)}
                />,
            );
        });
        const text = container.textContent ?? '';
        expect(text).toContain('Not hosted');
        expect(text).toContain('candidates:');
        expect(text).toContain('node-a (priority 2)');
        expect(text).toContain('chassis-b (priority 1)');
    });

    it('shows the admin state only when the NB row sets it', () => {
        const base = byName('ovn_cluster_router')!;
        render('ovn_cluster_router');
        expect(container.textContent).not.toContain('Admin state');

        act(() => {
            root.render(<ConstructDrawerBody construct={{ ...base, enabled: false }} model={model} />);
        });
        expect(container.textContent).toContain('Admin state');
        expect(container.textContent).toContain('Disabled');
    });

    it('counts references to tables not yet collected', () => {
        render('cnv-1');
        let text = container.textContent ?? '';
        expect(text).toMatch(/ACLs\d+ \(rows not collected yet\)/);
        expect(text).toMatch(/Load balancers.*\d+ direct · \d+ groups/);
        expect(text).toMatch(/QoS rules\d+/);

        render('GR_cnv-1');
        text = container.textContent ?? '';
        expect(text).toContain('Load balancers');
        expect(text).not.toContain('Routing policies');

        render('ovn_cluster_router');
        text = container.textContent ?? '';
        expect(text).toMatch(/Routing policies\d+/);
        expect(text).not.toContain('ACLs');
    });

    it('renders NAT match and route extras in the rule text', () => {
        expect(
            natRuleText(
                {
                    uuid: 'n',
                    type: 'snat',
                    externalIp: '192.0.2.1',
                    logicalIp: '10.0.0.0/24',
                    match: 'ip4.dst == $set',
                    priority: 5,
                    gatewayPort: 'lrp-1',
                },
                (uuid) => (uuid === 'lrp-1' ? 'rtoe-GR_x' : undefined),
            ),
        ).toBe('snat 192.0.2.1 ⇄ 10.0.0.0/24, match ip4.dst == $set, priority 5, on rtoe-GR_x');
        expect(natRuleText({ uuid: 'n', type: 'snat', externalIp: '1.1.1.1', logicalIp: '10.0.0.1' })).toBe(
            'snat 1.1.1.1 ⇄ 10.0.0.1',
        );
        expect(
            staticRouteText({
                uuid: 'r',
                ipPrefix: '0.0.0.0/0',
                nexthop: '10.0.0.1',
                routeTable: 'rt1',
                bfd: 'bfd-1',
                selectionFields: ['ip_src', 'ip_dst'],
            }),
        ).toBe('0.0.0.0/0 → 10.0.0.1, table rt1, bfd, ecmp(ip_src ip_dst)');
    });

    it('lists static routes with nexthops', () => {
        render('ovn_cluster_router');
        const text = container.textContent ?? '';
        expect(text).toMatch(/Static routes \(\d+\)/);
        expect(text).toContain('→');
    });

    it('links the owning CUDN from a UDN construct', () => {
        render('cluster_udn_example.p.cudn_ovn_layer2_switch');
        const link = [...container.querySelectorAll('a')].find((anchor) =>
            anchor.getAttribute('href')?.includes('ClusterUserDefinedNetwork'),
        );
        expect(link?.getAttribute('href')).toBe(
            '/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/example-p-cudn',
        );
    });

    it('renders a filterable pod list linking each port to its Pod', () => {
        render('cnv-1');
        expect(container.querySelector('input[aria-label="Filter workload ports"]')).not.toBeNull();
        const podLink = [...container.querySelectorAll('a')].find((anchor) =>
            anchor.getAttribute('href')?.includes('/k8s/ns/'),
        );
        expect(podLink).toBeDefined();
        expect(podLink?.getAttribute('href')).toMatch(/^\/k8s\/ns\/[^/]+\/core~v1~Pod\/.+$/);
    });

    it('links seam constructs across to the physical view', () => {
        const construct = byName('ext_cnv-1');
        act(() => {
            root.render(
                <ConstructDrawerBody
                    construct={construct!}
                    model={model}
                    physicalHref={(node) => `/ovn-recon/node-network-state/${node}`}
                />,
            );
        });
        const seamLink = [...container.querySelectorAll('a')].find((anchor) =>
            anchor.getAttribute('href')?.includes('/ovn-recon/node-network-state/'),
        );
        expect(seamLink?.getAttribute('href')).toBe('/ovn-recon/node-network-state/cnv-1');
        expect(seamLink?.textContent).toContain('br-ex on cnv-1');
    });

    it('uses the page node for seam links on localnet switches', () => {
        const construct = byName('cluster_udn_machinenet_ovn_localnet_switch');
        act(() => {
            root.render(
                <ConstructDrawerBody
                    construct={construct!}
                    model={model}
                    fallbackNode="cnv-1"
                    physicalHref={(node) => `/ovn-recon/node-network-state/${node}`}
                />,
            );
        });
        expect(container.textContent).toContain('Bridge mapping on cnv-1');
    });

    const clickTab = (label: string) => {
        const tab = [...container.querySelectorAll('button')].find(
            (button) => button.textContent === label,
        );
        expect(tab).toBeDefined();
        act(() => {
            tab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    };

    it('renders the three drawer tabs', () => {
        render('GR_cnv-1');
        const tabLabels = [...container.querySelectorAll('button')].map((button) => button.textContent);
        for (const label of ['Overview', 'Relationships', 'Config']) {
            expect(tabLabels).toContain(label);
        }
    });

    it('moves the selection from a Relationships entry', () => {
        const construct = byName('GR_cnv-1');
        const onSelect = jest.fn();
        act(() => {
            root.render(
                <ConstructDrawerBody construct={construct!} model={model} onSelectConstruct={onSelect} />,
            );
        });
        clickTab('Relationships');
        const entry = [...container.querySelectorAll('button')].find((button) =>
            button.textContent?.includes('Join switch'),
        );
        expect(entry).toBeDefined();
        act(() => {
            entry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(onSelect).toHaveBeenCalledTimes(1);
        const selectedUuid = onSelect.mock.calls[0][0] as string;
        expect(model.constructByUuid.get(selectedUuid)?.role).toBe('join-switch');
    });

    it('keeps the Relationships tab selected when the selection moves', () => {
        const first = byName('GR_cnv-1');
        const second = byName('ovn_cluster_router');
        const render = (construct: typeof first) =>
            act(() => {
                root.render(
                    <ConstructDrawerBody construct={construct!} model={model} onSelectConstruct={jest.fn()} />,
                );
            });
        render(first);
        clickTab('Relationships');
        // Simulate following a link: the page swaps the construct prop.
        render(second);
        const relationshipsTab = [...container.querySelectorAll('button')].find(
            (button) => button.textContent === 'Relationships',
        );
        expect(relationshipsTab?.getAttribute('aria-selected')).toBe('true');
    });

    it('shows raw NB rows on the Config tab when a database is supplied', () => {
        const construct = byName('GR_cnv-1');
        act(() => {
            root.render(
                <ConstructDrawerBody
                    construct={construct!}
                    model={model}
                    database={database}
                    databaseNode="cnv-1"
                />,
            );
        });
        clickTab('Config');
        const text = container.textContent ?? '';
        expect(text).toContain('Logical_Router rows from node cnv-1');
        expect(container.querySelector('[data-testid="code-editor"]')?.textContent).toContain('"logicalRouter"');
    });

    it('labels the Config tab as model-derived without a database', () => {
        render('GR_cnv-1');
        clickTab('Config');
        expect(container.textContent).toContain('As modeled by OVN Recon');
    });

    it('filters the pod list by query', () => {
        render('cnv-1');
        const input = container.querySelector<HTMLInputElement>('input[aria-label="Filter workload ports"]');
        expect(input).not.toBeNull();
        act(() => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            setter?.call(input, 'no-such-pod-name-xyz');
            input!.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(container.textContent).toContain('No ports match.');
    });
});

describe('ConstructDrawerBody Ports tab', () => {
    let container: HTMLDivElement;
    let root: Root;
    const chassisId = '91bc7389-d1b9-4fef-9f4c-52e3eedab004';
    const switchRow = (name: string) => database.logicalSwitches.find((row) => row.name === name)!;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const renderConstruct = (
        name: string,
        props: Partial<React.ComponentProps<typeof ConstructDrawerBody>> = {},
    ) => {
        const construct = byName(name);
        expect(construct).toBeDefined();
        act(() => {
            root.render(<ConstructDrawerBody construct={construct!} model={model} {...props} />);
        });
    };

    const tabLabels = () =>
        [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);

    const clickTab = (label: string) => {
        const tab = [...container.querySelectorAll('button')].find((button) => button.textContent === label);
        expect(tab).toBeDefined();
        act(() => {
            tab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    };

    const selectedTab = () =>
        [...container.querySelectorAll('button[aria-selected="true"]')].map((tab) => tab.textContent)[0];

    const portRows = () => [...container.querySelectorAll('tr[data-testid^="port-row-"]')];

    const setInputValue = (input: HTMLInputElement | HTMLSelectElement, value: string) => {
        act(() => {
            const prototype = input instanceof HTMLSelectElement
                ? window.HTMLSelectElement.prototype
                : window.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
            setter?.call(input, value);
            input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
        });
    };

    it('offers the Ports tab on switches only', () => {
        renderConstruct('cnv-1');
        expect(tabLabels()).toEqual(['Overview', 'Relationships', 'Ports', 'Config']);

        renderConstruct('GR_cnv-1');
        expect(tabLabels()).toEqual(['Overview', 'Relationships', 'Config']);

        renderConstruct('cluster_udn_machinenet_ovn_localnet_switch');
        expect(tabLabels()).toContain('Ports');
    });

    it('lists every port on the switch, one row per Logical_Switch_Port', () => {
        renderConstruct('cnv-1');
        clickTab('Ports');
        expect(portRows()).toHaveLength(switchRow('cnv-1').ports.length);
        expect(container.querySelector('input[aria-label="Filter ports"]')?.getAttribute('placeholder'))
            .toBe(`Filter ${switchRow('cnv-1').ports.length} ports`);

        renderConstruct('transit_switch');
        expect(portRows()).toHaveLength(switchRow('transit_switch').ports.length);
    });

    it('renders pod ports as Pod links and other ports by OVN name', () => {
        renderConstruct('cnv-1');
        clickTab('Ports');
        const podLink = [...container.querySelectorAll('tbody a')].find((anchor) =>
            anchor.getAttribute('href')?.startsWith('/k8s/ns/openshift-storage/core~v1~Pod/'),
        );
        expect(podLink).toBeDefined();
        expect(podLink?.textContent).toMatch(/^openshift-storage\//);
        // The router port on the node switch has no Pod to link to.
        expect(container.querySelector('tbody code')?.textContent).toBeDefined();
        const text = container.textContent ?? '';
        expect(text).toContain('stor-cnv-1');
    });

    it('resolves requested-chassis to a node name when a Node claims it, else the id', () => {
        renderConstruct('cnv-1', {
            nodeHref: (node) => `/ovn-recon/ovn/${node}`,
            nodeForChassis: (chassis) => (chassis === chassisId ? 'cnv-1' : undefined),
        });
        clickTab('Ports');
        const nodeLinks = container.querySelectorAll('tbody a[href="/ovn-recon/ovn/cnv-1"]');
        expect(nodeLinks.length).toBeGreaterThan(0);
        expect(nodeLinks[0].getAttribute('title')).toBe(chassisId);

        renderConstruct('cnv-1');
        expect(container.querySelector('tbody a[href="/ovn-recon/ovn/cnv-1"]')).toBeNull();
        expect(container.textContent).toContain('91bc7389…');
    });

    it('shows addresses, port security and the binding state per row', () => {
        renderConstruct('cnv-1');
        clickTab('Ports');
        const podRow = portRows().find((row) => row.textContent?.includes('openshift-storage/'));
        expect(podRow).toBeDefined();
        const codes = [...podRow!.querySelectorAll('code')].map((code) => code.textContent);
        // The pod's address appears twice: addresses and port_security.
        const macAndIp = codes.find((code) => /^0a:58:/.test(code ?? ''));
        expect(macAndIp).toBeDefined();
        expect(codes.filter((code) => code === macAndIp)).toHaveLength(2);
        expect(podRow!.textContent).toContain('Up');

        renderConstruct('ext_cnv-1');
        const localnetRow = portRows().find((row) => row.textContent?.includes('localnet'));
        expect(localnetRow?.textContent).toContain('Down');
    });

    it('filters by port type and by text', () => {
        renderConstruct('transit_switch');
        clickTab('Ports');
        const total = switchRow('transit_switch').ports.length;
        expect(portRows()).toHaveLength(total);

        const select = container.querySelector<HTMLSelectElement>('select[aria-label="Filter by port type"]');
        expect(select).not.toBeNull();
        const options = [...select!.options].map((option) => option.textContent);
        expect(options[0]).toBe(`All types (${total})`);
        expect(options).toContain('remote (9)');
        expect(options).toContain('router (1)');

        setInputValue(select!, 'remote');
        expect(portRows()).toHaveLength(9);
        expect(portRows().every((row) => row.textContent?.includes('remote'))).toBe(true);

        setInputValue(select!, 'router');
        expect(portRows()).toHaveLength(1);

        setInputValue(select!, 'all');
        const input = container.querySelector<HTMLInputElement>('input[aria-label="Filter ports"]');
        setInputValue(input!, 'tstor-cnv-3');
        expect(portRows()).toHaveLength(1);
        expect(portRows()[0].textContent).toContain('tstor-cnv-3');

        setInputValue(input!, 'no-such-port');
        expect(portRows()).toHaveLength(0);
        expect(container.textContent).toContain('No ports match.');
    });

    it('expands a row to the raw NB row and a port-groups placeholder', () => {
        // The ladder database: no policy section, and no node to load it from.
        const ladderDatabase: LogicalDatabase = { ...database };
        delete ladderDatabase.acls;
        delete ladderDatabase.portGroups;
        delete ladderDatabase.addressSets;
        renderConstruct('transit_switch', { database: ladderDatabase });
        clickTab('Ports');
        expect(container.querySelector('[data-testid="code-editor"]')).toBeNull();

        const row = portRows().find((candidate) => candidate.textContent?.includes('tstor-cnv-3'))!;
        const toggle = row.querySelector('button');
        expect(toggle).not.toBeNull();
        act(() => {
            toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        const editor = container.querySelector('[data-testid="code-editor"]');
        expect(editor).not.toBeNull();
        const raw = JSON.parse(editor!.textContent ?? '{}') as { name: string; up?: boolean; type?: string };
        expect(raw.name).toBe('tstor-cnv-3');
        expect(raw.type).toBe('remote');
        expect(raw.up).toBe(true);
        expect(container.textContent).toContain('Port groups:');
        expect(container.textContent).toContain('not collected yet');
    });

    it('resets expanded rows when the selection moves and keeps the tab between switches', () => {
        renderConstruct('transit_switch', { onSelectConstruct: jest.fn() });
        clickTab('Ports');
        act(() => {
            portRows()[0].querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(container.querySelector('[data-testid="code-editor"]')).not.toBeNull();

        // Hop to another switch: still on Ports, nothing expanded.
        renderConstruct('join', { onSelectConstruct: jest.fn() });
        expect(selectedTab()).toBe('Ports');
        expect(portRows()).toHaveLength(switchRow('join').ports.length);
        expect(container.querySelector('[data-testid="code-editor"]')).toBeNull();

        // Hop to a router: no Ports tab, so Overview shows.
        renderConstruct('ovn_cluster_router', { onSelectConstruct: jest.fn() });
        expect(tabLabels()).not.toContain('Ports');
        expect(selectedTab()).toBe('Overview');
        expect(container.textContent).toContain('OVN name');

        // And back to a switch returns to Ports.
        renderConstruct('join', { onSelectConstruct: jest.fn() });
        expect(selectedTab()).toBe('Ports');
    });
});

describe('ConstructDrawerBody Services tab', () => {
    let container: HTMLDivElement;
    let root: Root;

    // What the ladder pages hold: the same database without the optional
    // sections, which only a request that names them returns.
    const ladderDatabase: LogicalDatabase = { ...database };
    delete ladderDatabase.loadBalancers;
    delete ladderDatabase.loadBalancerGroups;
    delete ladderDatabase.acls;
    delete ladderDatabase.portGroups;
    delete ladderDatabase.addressSets;
    const udnSwitch = 'cluster_udn_example.p.cudn_ovn_layer2_switch';

    beforeEach(() => {
        fetchSnapshot.mockReset();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const renderConstruct = (
        name: string,
        props: Partial<React.ComponentProps<typeof ConstructDrawerBody>> = { database, databaseNode: 'cnv-1' },
    ) => {
        const construct = byName(name);
        expect(construct).toBeDefined();
        act(() => {
            root.render(<ConstructDrawerBody construct={construct!} model={model} {...props} />);
        });
    };

    const tabLabels = () => [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    const selectedTab = () =>
        [...container.querySelectorAll('button[aria-selected="true"]')].map((tab) => tab.textContent)[0];
    const clickTab = (label: string) => {
        const tab = [...container.querySelectorAll('button')].find((button) => button.textContent === label);
        expect(tab).toBeDefined();
        act(() => {
            tab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    };
    const serviceRows = () => [...container.querySelectorAll('tr[data-testid^="service-row-"]')];
    const setFilter = (value: string) => {
        const input = container.querySelector<HTMLInputElement>('input[aria-label="Filter services"]');
        expect(input).not.toBeNull();
        act(() => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            setter?.call(input, value);
            input!.dispatchEvent(new Event('input', { bubbles: true }));
        });
    };
    const overviewValue = (term: string) => {
        const group = [...container.querySelectorAll('dt')].find((candidate) => candidate.textContent === term);
        return group?.parentElement?.querySelector('dd')?.textContent ?? '';
    };

    it('offers the tab on constructs that attach load balancers, and only those', () => {
        renderConstruct('cnv-1');
        expect(tabLabels()).toEqual(['Overview', 'Relationships', 'Ports', 'Services', 'Config']);

        renderConstruct('GR_cnv-1');
        expect(tabLabels()).toEqual(['Overview', 'Relationships', 'Services', 'Config']);

        renderConstruct(udnSwitch);
        expect(tabLabels()).toContain('Services');

        renderConstruct('ovn_cluster_router');
        expect(tabLabels()).toEqual(['Overview', 'Relationships', 'Config']);

        renderConstruct('join');
        expect(tabLabels()).toEqual(['Overview', 'Relationships', 'Ports', 'Config']);
        expect(fetchSnapshot).not.toHaveBeenCalled();
    });

    it('replaces the not-collected note on the Overview with direct and per-group counts', () => {
        renderConstruct('cnv-1');
        const value = overviewValue('Load balancers');
        expect(value).toMatch(/^22 direct · \d+ via clusterLBGroup · 0 via clusterSwitchLBGroup/);
        expect(value).toMatch(/\d+ VIPs without endpoints$/);
        expect(value).not.toContain('not collected');

        renderConstruct('GR_cnv-1');
        expect(overviewValue('Load balancers')).toMatch(/^22 direct · \d+ via clusterLBGroup · 0 via clusterRouterLBGroup/);
    });

    it('says a UDN switch sees no load balancers because its groups are empty', () => {
        renderConstruct(udnSwitch);
        const expected =
            '0 load balancers; groups cluster_udn_example.p.cudn_clusterLBGroup and ' +
            'cluster_udn_example.p.cudn_clusterSwitchLBGroup are empty';
        expect(overviewValue('Load balancers')).toBe(expected);

        clickTab('Services');
        expect(container.querySelector('[data-testid="services-empty"]')?.textContent).toBe(`${expected}.`);
        expect(serviceRows()).toHaveLength(0);
        expect(container.querySelector('table')).toBeNull();
    });

    it('caps the rendered rows and says how many matched', () => {
        renderConstruct('cnv-1');
        clickTab('Services');
        expect(serviceRows()).toHaveLength(MAX_SERVICE_ROWS);
        const cap = container.querySelector('[data-testid="services-cap"]')?.textContent ?? '';
        expect(cap).toMatch(new RegExp(`^Showing ${MAX_SERVICE_ROWS} of \\d+ VIPs; narrow the filter`));
        expect(Number(/of (\d+) VIPs/.exec(cap)?.[1])).toBeGreaterThan(MAX_SERVICE_ROWS);
        expect(container.textContent).toContain('Load_Balancer rows from node cnv-1');

        // A filter that brings the matches under the cap drops the notice.
        setFilter('openshift-dns/');
        expect(container.querySelector('[data-testid="services-cap"]')).toBeNull();
        expect(serviceRows().length).toBeGreaterThan(0);
        expect(serviceRows().length).toBeLessThan(MAX_SERVICE_ROWS);
    });

    it('finds the Service behind a VIP and links to it', () => {
        renderConstruct('cnv-1');
        clickTab('Services');
        setFilter('172.30.0.1:443');
        const rows = serviceRows();
        expect(rows).toHaveLength(1);
        const link = rows[0].querySelector('a');
        expect(link?.textContent).toBe('default/kubernetes');
        expect(link?.getAttribute('href')).toBe('/k8s/ns/default/core~v1~Service/kubernetes');
        const cells = [...rows[0].querySelectorAll('td')].map((cell) => cell.textContent);
        expect(cells.slice(2)).toEqual(['tcp', '172.30.0.1:443', '3', 'node-local', 'direct']);
        expect(rows[0].querySelector('span[title]')?.getAttribute('title')).toBe('node_router+switch on cnv-1');

        setFilter('no-such-service');
        expect(serviceRows()).toHaveLength(0);
        expect(container.textContent).toContain('No services match.');
    });

    it('filters by backend, and shows the node switch only its own variant of a per-node Service', () => {
        renderConstruct('cnv-1');
        clickTab('Services');
        setFilter('172.30.0.10:53');
        // DNS is materialised per node: the switch sees node_switch rows
        // (TCP and UDP), the gateway router the node_router ones.
        expect(serviceRows().map((row) => row.querySelectorAll('td')[2].textContent).sort()).toEqual(['tcp', 'udp']);
        const backend = database.loadBalancers!.find(
            (row) => row.name === 'Service_openshift-dns/dns-default_UDP_node_switch_cnv-1',
        )!.vips['172.30.0.10:53'];
        setFilter(backend);
        expect(serviceRows().some((row) => row.textContent?.includes('openshift-dns/dns-default'))).toBe(true);
    });

    it('expands a row to its backends and flags a VIP without endpoints', () => {
        renderConstruct('cnv-1');
        clickTab('Services');
        setFilter('ovn-recon-fixture/dual-stack-echo');
        const rows = serviceRows();
        expect(rows.map((row) => row.querySelectorAll('td')[3].textContent)).toEqual([
            '[fd02::fa0a]:8080',
            '172.30.250.10:8080',
        ]);
        expect(rows[0].querySelectorAll('td')[6].textContent).toBe('clusterLBGroup');
        act(() => {
            rows[0].querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(container.textContent).toContain('[fd01:0:0:5::c8]:8080');
        expect(container.textContent).toContain('Service_ovn-recon-fixture/dual-stack-echo_TCP_cluster');

        const idle = database.loadBalancers!.find((row) => Object.values(row.vips).includes(''))!;
        const idleVip = Object.entries(idle.vips).find(([, backends]) => backends === '')![0];
        setFilter(idleVip);
        const idleRow = serviceRows().find((row) => row.textContent?.includes('No endpoints'));
        expect(idleRow).toBeDefined();
        act(() => {
            idleRow!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(container.textContent).toContain('the Service has no ready endpoints');
        expect(container.textContent).toContain('OVN rejects connections to this VIP');
    });

    it('adds the referenced load balancer rows to the Config tab', () => {
        renderConstruct('cnv-1');
        clickTab('Config');
        const payload = JSON.parse(container.querySelector('[data-testid="code-editor"]')!.textContent ?? '{}') as {
            loadBalancers?: Array<{ name: string }>;
            loadBalancerGroups?: Array<{ name: string }>;
        };
        expect(payload.loadBalancers).toHaveLength(22);
        expect(payload.loadBalancerGroups?.map((group) => group.name)).toEqual(['clusterLBGroup', 'clusterSwitchLBGroup']);
    });

    it('keeps the stored tab across a hop to a construct without services', () => {
        renderConstruct('cnv-1');
        clickTab('Services');
        setFilter('kubernetes');

        renderConstruct('ovn_cluster_router');
        expect(selectedTab()).toBe('Overview');

        renderConstruct('GR_cnv-1');
        expect(selectedTab()).toBe('Services');
        // A different construct starts with a clean filter.
        expect(container.querySelector<HTMLInputElement>('input[aria-label="Filter services"]')?.value).toBe('');
    });

    it('keeps the not-collected rendering when no section is at hand', () => {
        renderConstruct('cnv-1', { database: ladderDatabase });
        expect(tabLabels()).toEqual(['Overview', 'Relationships', 'Ports', 'Config']);
        expect(overviewValue('Load balancers')).toBe('22 direct · 2 groups (rows not collected yet)');
        expect(fetchSnapshot).not.toHaveBeenCalled();
    });

    it('loads the section from the node the ladder database came from', async () => {
        let resolve: (snapshot: LogicalTopologySnapshot) => void = () => undefined;
        fetchSnapshot.mockReturnValue(new Promise((done) => { resolve = done; }));

        renderConstruct('cnv-1', { database: ladderDatabase, databaseNode: 'cnv-1', sectionsRefreshKey: 't1' });
        expect(fetchSnapshot).toHaveBeenCalledTimes(1);
        // Both optional sections travel in one request.
        expect(fetchSnapshot).toHaveBeenCalledWith('cnv-1', { include: ['policy', 'services'] });
        // The tab is offered while the section is on its way.
        expect(tabLabels()).toContain('Services');
        expect(overviewValue('Load balancers')).toBe('22 direct · 2 groups (loading…)');
        clickTab('Services');
        expect(container.textContent).toContain('Loading services');

        await act(async () => resolve(cnv1 as unknown as LogicalTopologySnapshot));
        expect(serviceRows()).toHaveLength(MAX_SERVICE_ROWS);
        clickTab('Overview');
        expect(overviewValue('Load balancers')).toMatch(/^22 direct · \d+ via clusterLBGroup/);

        // A construct that needs neither section (a router without load
        // balancers) costs no request.
        renderConstruct('ovn_cluster_router', { database: ladderDatabase, databaseNode: 'cnv-1', sectionsRefreshKey: 't1' });
        expect(fetchSnapshot).toHaveBeenCalledTimes(1);
        // Back on a construct with load balancers on the same node: the rows
        // already loaded show at once while the request is repeated.
        renderConstruct('GR_cnv-1', { database: ladderDatabase, databaseNode: 'cnv-1', sectionsRefreshKey: 't1' });
        expect(overviewValue('Load balancers')).toMatch(/^22 direct · \d+ via clusterLBGroup/);
        await act(async () => undefined);
        expect(fetchSnapshot).toHaveBeenCalledTimes(2);

        // The same snapshot does not refetch; a newer one does.
        renderConstruct('GR_cnv-1', { database: ladderDatabase, databaseNode: 'cnv-1', sectionsRefreshKey: 't1' });
        await act(async () => undefined);
        expect(fetchSnapshot).toHaveBeenCalledTimes(2);
        renderConstruct('GR_cnv-1', { database: ladderDatabase, databaseNode: 'cnv-1', sectionsRefreshKey: 't2' });
        await act(async () => undefined);
        expect(fetchSnapshot).toHaveBeenCalledTimes(3);
    });

    it('drops the tab when the collector does not deliver the section', async () => {
        // A collector that answers without the section (an entry cached by
        // an older version, say) leaves the drawer with the ladder only.
        fetchSnapshot.mockResolvedValue({
            ...(cnv1 as unknown as LogicalTopologySnapshot),
            database: ladderDatabase,
        });
        renderConstruct('cnv-1', { database: ladderDatabase, databaseNode: 'cnv-1' });
        clickTab('Services');
        await act(async () => undefined);
        expect(tabLabels()).not.toContain('Services');
        expect(selectedTab()).toBe('Overview');
        expect(overviewValue('Load balancers')).toBe('22 direct · 2 groups (rows not collected yet)');
    });

    it('falls back to the reference counts when the request fails', async () => {
        fetchSnapshot.mockRejectedValue(new Error('Collector request failed'));
        renderConstruct('GR_cnv-1', { database: ladderDatabase, databaseNode: 'cnv-1' });
        await act(async () => undefined);
        expect(tabLabels()).not.toContain('Services');
        expect(overviewValue('Load balancers')).toBe('22 direct · 2 groups (rows not collected yet)');
    });
});

describe('ConstructDrawerBody policy plane', () => {
    let container: HTMLDivElement;
    let root: Root;

    // What the ladder pages hold: no optional section.
    const ladderDatabase: LogicalDatabase = { ...database };
    delete ladderDatabase.loadBalancers;
    delete ladderDatabase.loadBalancerGroups;
    delete ladderDatabase.acls;
    delete ladderDatabase.portGroups;
    delete ladderDatabase.addressSets;
    const udnSwitch = 'cluster_udn_example.p.cudn_ovn_layer2_switch';
    const policyPod = 'openshift-monitoring_alertmanager-main-1';

    beforeEach(() => {
        fetchSnapshot.mockReset();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const renderConstruct = (
        name: string,
        props: Partial<React.ComponentProps<typeof ConstructDrawerBody>> = { database, databaseNode: 'cnv-1' },
        ladder = model,
    ) => {
        const construct = ladder.constructs.find((candidate) => candidate.name === name);
        expect(construct).toBeDefined();
        act(() => {
            root.render(<ConstructDrawerBody construct={construct!} model={ladder} {...props} />);
        });
    };

    const tabLabels = () => [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    const clickTab = (label: string) => {
        const tab = [...container.querySelectorAll('button')].find((button) => button.textContent === label);
        expect(tab).toBeDefined();
        act(() => {
            tab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    };
    const overviewValue = (term: string) => {
        const group = [...container.querySelectorAll('dt')].find((candidate) => candidate.textContent === term);
        return group?.parentElement?.querySelector('dd')?.textContent;
    };
    const portRows = () => [...container.querySelectorAll('tr[data-testid^="port-row-"]')];
    const expandPort = (text: string) => {
        const row = portRows().find((candidate) => candidate.textContent?.includes(text));
        expect(row).toBeDefined();
        act(() => {
            row!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    };
    const portPolicy = () => container.querySelector('[data-testid="port-policy"]');
    const groupRows = () => [...container.querySelectorAll('tr[data-testid^="port-group-"]')];
    const aclRows = () => [...container.querySelectorAll('tr[data-testid^="port-acl-"]')];
    const hrefs = (scope: Element | null) =>
        [...(scope?.querySelectorAll('a') ?? [])].map((anchor) => anchor.getAttribute('href') ?? '');

    it('shows a switch its direct and via-port-group ACL counts on the Overview', () => {
        renderConstruct('cnv-1');
        expect(overviewValue('ACLs')).toMatch(/^1 direct · \d+ via \d+ port groups$/);
        expect(overviewValue('ACLs')).not.toContain('not collected');

        // The layer2 UDN switch: its own node and isolation ACLs, plus the
        // cluster port group its management port is in.
        renderConstruct(udnSwitch);
        expect(overviewValue('ACLs')).toBe('2 direct · 4 via 1 port group');
        expect(fetchSnapshot).not.toHaveBeenCalled();
    });

    it('leaves switches without ACLs and every router without the line', () => {
        renderConstruct('transit_switch');
        expect(overviewValue('ACLs')).toBeUndefined();
        renderConstruct('GR_cnv-1');
        expect(overviewValue('ACLs')).toBeUndefined();
        renderConstruct('ovn_cluster_router');
        expect(overviewValue('ACLs')).toBeUndefined();
        // And no Policy tab anywhere: the full tables belong to the detail page.
        expect(tabLabels()).toEqual(['Overview', 'Relationships', 'Config']);
        renderConstruct('cnv-1');
        expect(tabLabels()).toEqual(['Overview', 'Relationships', 'Ports', 'Services', 'Config']);
    });

    it('lists a pod port\'s groups with owner links and the ACLs that apply to it', () => {
        renderConstruct('cnv-1');
        clickTab('Ports');
        expandPort('openshift-monitoring/alertmanager-main-1');

        const port = database.logicalSwitchPorts.find((row) => row.name === policyPod)!;
        const expected = policyForPort(policyIndexFor(database), port.uuid);
        expect(portPolicy()?.textContent).toContain(`Port groups (${expected.groups.length})`);
        expect(portPolicy()?.textContent).toContain(`ACLs that apply (${expected.acls.length})`);
        expect(portPolicy()?.textContent).not.toContain('not collected');
        expect(groupRows()).toHaveLength(expected.groups.length);
        expect(aclRows()).toHaveLength(expected.acls.length);

        // The NetworkPolicy that selects the pod is a link, and so is its namespace.
        const policyGroup = groupRows().find((row) => row.textContent?.startsWith('NetworkPolicy'))!;
        expect(policyGroup.textContent).toContain('openshift-monitoring/');
        expect(hrefs(policyGroup).some((href) =>
            href.startsWith('/k8s/ns/openshift-monitoring/networking.k8s.io~v1~NetworkPolicy/'),
        )).toBe(true);
        expect(policyGroup.textContent).toContain('Default cluster network');
        const namespaceGroup = groupRows().find((row) => row.textContent?.startsWith('Namespace'))!;
        expect(hrefs(namespaceGroup)).toContain('/k8s/cluster/projects/openshift-monitoring');
        const denyGroup = groupRows().find((row) => row.textContent?.startsWith('NetpolNamespace'))!;
        expect(denyGroup.textContent).toMatch(/\((Ingress|Egress)\)/);

        // ACL rows in display order: from-lport first, priority descending within.
        const rendered = aclRows().map((row) => row.getAttribute('data-testid')!.slice('port-acl-'.length));
        expect(rendered).toEqual(expected.acls.map((applied) => applied.acl.uuid));
        const first = expected.acls[0].acl;
        expect(aclRows()[0].textContent).toContain(String(first.priority));
        expect(aclRows()[0].textContent).toContain(first.direction);
        expect(aclRows()[0].textContent).toContain(first.action);
        expect(aclRows()[0].querySelector('code')?.textContent).toBe(first.match);
        // The node ACL set on the switch itself applies to the port too.
        expect(aclRows().some((row) => row.textContent?.includes('set on the switch'))).toBe(true);
        // A NetworkPolicy ACL names its policy as a link.
        const policyAcl = aclRows().find((row) => row.textContent?.includes('NetworkPolicy openshift-monitoring/'))!;
        expect(hrefs(policyAcl).some((href) => href.includes('networking.k8s.io~v1~NetworkPolicy'))).toBe(true);
        // Hashed names in a match are spelled out.
        expect(portPolicy()?.textContent).toMatch(/@a\d+ (NetworkPolicy|NetpolNamespace|Namespace) /);
    });

    it('shows a port in a single group, and one in none', () => {
        renderConstruct('cnv-1');
        clickTab('Ports');
        expandPort('k8s-cnv-1');
        expect(groupRows()).toHaveLength(1);
        expect(groupRows()[0].textContent).toContain('ClusterclusterPortGroup');
        expect(aclRows().some((row) => row.textContent?.includes('MulticastCluster'))).toBe(true);

        renderConstruct('transit_switch');
        expandPort('tstor-cnv-3');
        expect(portPolicy()?.textContent).toContain('This port is in no port group.');
        expect(portPolicy()?.textContent).toContain('No ACL applies to this port.');
    });

    it('loads the policy section when a switch is selected, and says so meanwhile', async () => {
        let resolve: (snapshot: LogicalTopologySnapshot) => void = () => undefined;
        fetchSnapshot.mockReturnValue(new Promise((done) => { resolve = done; }));

        renderConstruct('cnv-1', { database: ladderDatabase, databaseNode: 'cnv-1', sectionsRefreshKey: 't1' });
        expect(fetchSnapshot).toHaveBeenCalledTimes(1);
        expect(fetchSnapshot).toHaveBeenCalledWith('cnv-1', { include: ['policy', 'services'] });
        expect(overviewValue('ACLs')).toBe('1 (rows not collected yet) ');
        expect(container.querySelector('[aria-label="Loading ACLs"]')).not.toBeNull();

        clickTab('Ports');
        expandPort('openshift-monitoring/alertmanager-main-1');
        expect(portPolicy()?.textContent).toContain('Port groups: not collected yet');
        expect(container.querySelector('[aria-label="Loading port groups"]')).not.toBeNull();

        await act(async () => resolve(cnv1 as unknown as LogicalTopologySnapshot));
        expect(portPolicy()?.textContent).toContain('Port groups (');
        expect(groupRows().length).toBeGreaterThan(1);
        clickTab('Overview');
        expect(overviewValue('ACLs')).toMatch(/^1 direct · \d+ via \d+ port groups$/);

        // Another switch on the same node reuses the rows: no second request.
        renderConstruct('join', { database: ladderDatabase, databaseNode: 'cnv-1', sectionsRefreshKey: 't1' });
        await act(async () => undefined);
        expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    });

    it('requests the section for a switch that attaches no load balancer', async () => {
        fetchSnapshot.mockResolvedValue(cnv1 as unknown as LogicalTopologySnapshot);
        renderConstruct('join', { database: ladderDatabase, databaseNode: 'cnv-1' });
        await act(async () => undefined);
        expect(fetchSnapshot).toHaveBeenCalledWith('cnv-1', { include: ['policy', 'services'] });
    });

    it('keeps the not-collected rendering when the collector does not deliver the section', async () => {
        fetchSnapshot.mockResolvedValue({
            ...(cnv1 as unknown as LogicalTopologySnapshot),
            database: ladderDatabase,
        });
        renderConstruct('cnv-1', { database: ladderDatabase, databaseNode: 'cnv-1' });
        await act(async () => undefined);
        expect(overviewValue('ACLs')).toBe('1 (rows not collected yet)');
        expect(container.querySelector('[aria-label="Loading ACLs"]')).toBeNull();
        clickTab('Ports');
        expandPort('openshift-monitoring/alertmanager-main-1');
        expect(portPolicy()?.textContent).toBe('Port groups: not collected yet');
    });

    it('shows a failed request inline and keeps the drawer usable', async () => {
        fetchSnapshot.mockRejectedValue(new Error('Collector request failed'));
        renderConstruct('cnv-1', { database: ladderDatabase, databaseNode: 'cnv-1' });
        await act(async () => undefined);
        expect(overviewValue('ACLs')).toBe('1 (rows not collected yet)Policy rows failed to load: Collector request failed');
        expect(tabLabels()).toEqual(['Overview', 'Relationships', 'Ports', 'Config']);
        clickTab('Ports');
        expect(portRows().length).toBeGreaterThan(50);
        expandPort('openshift-monitoring/alertmanager-main-1');
        expect(portPolicy()?.textContent).toContain('Port groups: not collected yet');
        expect(portPolicy()?.textContent).toContain('Policy rows failed to load: Collector request failed');
    });

    it('says a port from another zone has no groups here (cluster view)', () => {
        const nodeSwitch = byName('cnv-1')!;
        const foreign = {
            ...nodeSwitch.ports.find((port) => port.name === policyPod)!,
            uuid: 'port-in-another-zone',
            name: 'shop_web-on-cnv-2',
            namespace: 'shop',
            pod: 'web-on-cnv-2',
        };
        act(() => {
            root.render(
                <ConstructDrawerBody
                    construct={{ ...nodeSwitch, ports: [foreign] }}
                    model={model}
                    database={database}
                    databaseNode="cnv-1"
                />,
            );
        });
        clickTab('Ports');
        expandPort('shop/web-on-cnv-2');
        expect(portPolicy()?.textContent).toContain("this port is not in node cnv-1's zone");
        expect(groupRows()).toHaveLength(0);
    });

    it('adds the ACL rows set on the switch to the Config tab', () => {
        renderConstruct(udnSwitch);
        clickTab('Config');
        const payload = JSON.parse(container.querySelector('[data-testid="code-editor"]')!.textContent ?? '{}') as {
            logicalSwitch: { acls: string[] };
            acls?: Array<{ uuid: string }>;
        };
        expect(payload.acls?.map((row) => row.uuid).sort()).toEqual([...payload.logicalSwitch.acls].sort());
    });

    describe('on a secondary network', () => {
        const network = 'cluster_udn_vlan-1924';
        const controller = `${network}-network-controller`;
        const owned = (type: string, name: string, extra: Record<string, string> = {}) => ({
            'k8s.ovn.org/owner-controller': controller,
            'k8s.ovn.org/owner-type': type,
            'k8s.ovn.org/name': name,
            ...extra,
        });
        const manyAcls = Array.from({ length: MAX_PORT_ACLS + 10 }, (_, rule) => ({
            uuid: `acl-rule-${rule}`,
            name: `NP:demo-mirror:restrict:Ingress:${rule}`,
            priority: 1001,
            direction: 'to-lport',
            action: 'allow-related',
            match: `ip4.src == 192.0.2.${rule}/32 && outport == @a900`,
            tier: 2,
            // A MultiNetworkPolicy: owner-type is NetworkPolicy all the same.
            externalIds: owned('NetworkPolicy', 'demo-mirror:restrict', { direction: 'Ingress', 'gress-index': String(rule) }),
        }));
        const secondary: LogicalDatabase = {
            logicalRouters: [],
            logicalRouterPorts: [],
            logicalSwitches: [{
                uuid: 'ls-vlan',
                name: 'cluster_udn_vlan.1924_ovn_localnet_switch',
                ports: ['lsp-vm', 'lsp-localnet'],
                externalIds: {
                    'k8s.ovn.org/network': network,
                    'k8s.ovn.org/role': 'secondary',
                    'k8s.ovn.org/topology': 'localnet',
                },
            }],
            logicalSwitchPorts: [
                {
                    uuid: 'lsp-vm',
                    name: 'cluster_udn_vlan.1924_demo-mirror_virt-launcher-vm-a-x7k2p',
                    addresses: ['02:00:00:00:00:01'],
                    externalIds: { namespace: 'demo-mirror', pod: 'true' },
                },
                { uuid: 'lsp-localnet', name: 'cluster_udn_vlan.1924_ovn_localnet_port', type: 'localnet' },
            ],
            nats: [],
            staticRoutes: [],
            acls: [
                ...manyAcls,
                {
                    uuid: 'acl-deny',
                    name: 'NP:demo-mirror:Ingress',
                    priority: 1000,
                    direction: 'to-lport',
                    action: 'drop',
                    match: 'outport == @a901',
                    tier: 2,
                    externalIds: owned('NetpolNamespace', 'demo-mirror', { direction: 'Ingress', type: 'defaultDeny' }),
                },
            ],
            portGroups: [
                {
                    uuid: 'pg-policy',
                    name: 'a900',
                    ports: ['lsp-vm'],
                    acls: manyAcls.map((row) => row.uuid),
                    externalIds: owned('NetworkPolicy', 'demo-mirror:restrict'),
                },
                {
                    uuid: 'pg-deny',
                    name: 'a901',
                    ports: ['lsp-vm'],
                    acls: ['acl-deny'],
                    externalIds: owned('NetpolNamespace', 'demo-mirror', { direction: 'Ingress' }),
                },
            ],
            addressSets: [],
        };
        const secondaryModel = buildLadderModel(secondary);

        it('links a NetworkPolicy-typed owner to its MultiNetworkPolicy', () => {
            renderConstruct(
                'cluster_udn_vlan.1924_ovn_localnet_switch',
                { database: secondary, databaseNode: 'cnv-1' },
                secondaryModel,
            );
            // No ACL on the switch itself, yet its ports collect some.
            expect(overviewValue('ACLs')).toBe(`${MAX_PORT_ACLS + 11} via 2 port groups`);

            clickTab('Ports');
            expandPort('virt-launcher-vm-a-x7k2p');
            const policyGroup = groupRows().find((row) => row.textContent?.startsWith('MultiNetworkPolicy'))!;
            expect(policyGroup).toBeDefined();
            expect(hrefs(policyGroup)).toContain(
                '/k8s/ns/demo-mirror/k8s.cni.cncf.io~v1beta1~MultiNetworkPolicy/restrict',
            );
            // The network column links the CUDN the controller serves.
            expect(hrefs(policyGroup).some((href) => href.includes('ClusterUserDefinedNetwork/vlan-1924'))).toBe(true);
            expect(aclRows()[0].textContent).toContain('MultiNetworkPolicy demo-mirror/restrict');
        });

        it('caps the ACL list of a port and says how many more there are', () => {
            renderConstruct(
                'cluster_udn_vlan.1924_ovn_localnet_switch',
                { database: secondary, databaseNode: 'cnv-1' },
                secondaryModel,
            );
            clickTab('Ports');
            expandPort('virt-launcher-vm-a-x7k2p');
            expect(portPolicy()?.textContent).toContain(`ACLs that apply (${MAX_PORT_ACLS + 11})`);
            expect(aclRows()).toHaveLength(MAX_PORT_ACLS);
            expect(container.querySelector('[data-testid="port-acl-cap"]')?.textContent).toBe('… and 11 more');
        });

        it('does not link a policy whose network role is unknown in the zone', () => {
            const unknownRole: LogicalDatabase = {
                ...secondary,
                logicalSwitches: [{ ...secondary.logicalSwitches[0], externalIds: { 'k8s.ovn.org/network': network } }],
            };
            renderConstruct(
                'cluster_udn_vlan.1924_ovn_localnet_switch',
                { database: unknownRole, databaseNode: 'cnv-1' },
                buildLadderModel(unknownRole),
            );
            clickTab('Ports');
            expandPort('virt-launcher-vm-a-x7k2p');
            const policyGroup = groupRows().find((row) => row.textContent?.includes('demo-mirror/restrict'))!;
            expect(policyGroup.textContent?.startsWith('NetworkPolicy')).toBe(true);
            expect(hrefs(policyGroup).some((href) => href.includes('NetworkPolicy/'))).toBe(false);
            expect(policyGroup.querySelector('[title*="MultiNetworkPolicy"]')).not.toBeNull();
        });
    });
});
