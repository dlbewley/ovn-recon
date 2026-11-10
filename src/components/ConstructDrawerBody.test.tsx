import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { LogicalDatabase, LogicalTopologySnapshot } from '../types';
import { buildLadderModel } from './logicalLadderModel';
import ConstructDrawerBody, {
    MAX_PORT_ACLS,
    rowAddresses,
} from './ConstructDrawerBody';
import { policyForPort, policyIndexFor } from './policyIndex';
import { fetchCollectorLookup, fetchCollectorSnapshot } from './collectorApi';
import { podAddressIndex } from './routerRules';
import { serviceOf } from './serviceIndex';
import { SERVICE_PAGE_SIZE } from './ServiceTables';
import { LookupHit, LookupResponse } from '../types';

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
// The Services tab looks backends on other nodes up through the collector.
jest.mock('./collectorApi', () => ({
    ...jest.requireActual('./collectorApi'),
    fetchCollectorSnapshot: jest.fn(),
    fetchCollectorLookup: jest.fn(),
}));
const fetchSnapshot = fetchCollectorSnapshot as jest.MockedFunction<typeof fetchCollectorSnapshot>;
const fetchLookup = fetchCollectorLookup as jest.MockedFunction<typeof fetchCollectorLookup>;

// The Services tab's two Kubernetes reads (the SDK does not load under jest):
// the cluster Network config, and one Service while its row is expanded.
const mockServiceNetworks: { value: { serviceNetworks: string[]; loaded: boolean; error?: string } } = {
    value: { serviceNetworks: ['172.30.0.0/16', 'fd02::/112'], loaded: true },
};
const mockKubeServices = new Map<string, unknown>();
jest.mock('./useServiceReads', () => ({
    useServiceNetworks: () => mockServiceNetworks.value,
    useKubeService: (namespace: string, name: string) => {
        const service = mockKubeServices.get(`${namespace}/${name}`);
        return service ? { service, loaded: true } : { loaded: false };
    },
}));

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

    const renderWithDatabase = (name: string) => {
        const construct = byName(name);
        expect(construct).toBeDefined();
        act(() => {
            root.render(<ConstructDrawerBody construct={construct!} model={model} database={database} />);
        });
    };

    it('folds per-pod SNAT on a gateway router into one row that expands to the pods', () => {
        renderWithDatabase('GR_cnv-1');
        const text = container.textContent ?? '';
        expect(text).toContain('NAT rules (74)');
        expect(text).not.toMatch(/and \d+ more/);
        expect(container.querySelector('[data-testid="nat-type-counts"]')?.textContent).toBe('SNAT 74');

        const table = container.querySelector('table[aria-label="NAT rules"]')!;
        const rows = table.querySelectorAll('tbody > tr[data-testid^="rule-row-"]');
        expect(rows).toHaveLength(2);
        expect(rows[0].querySelector('[data-testid="nat-group-logical"]')?.textContent).toBe(
            '73 logical IPs in 10.131.0.0/23',
        );
        expect(rows[1].textContent).toContain('100.64.0.5');
        // Port range column: some of the folded rows carry one.
        expect(rows[0].textContent).toMatch(/32768-60999 \(\d+ of 73\)/);

        expect(container.querySelector('[data-testid="nat-group-addresses"]')).toBeNull();
        const toggle = rows[0].querySelector('button')!;
        act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        const addresses = container.querySelector('[data-testid="nat-group-addresses"]')!;
        expect(addresses.textContent).toContain('10.131.1.193');
        const podLink = [...addresses.querySelectorAll('a')].find((a) =>
            a.textContent === 'hive/hiveadmission-6b44465788-fnxq7');
        expect(podLink?.getAttribute('href')).toBe('/k8s/ns/hive/core~v1~Pod/hiveadmission-6b44465788-fnxq7');
    });

    it('keeps dnat_and_snat rows as rows of their own with a count chip', () => {
        const construct = byName('GR_cnv-1')!;
        const withFip = {
            ...construct,
            natRules: [
                ...construct.natRules,
                { uuid: 'fip-1', type: 'dnat_and_snat' as const, externalIp: '192.168.4.200', logicalIp: '10.131.1.193' },
            ],
        };
        act(() => {
            root.render(<ConstructDrawerBody construct={withFip} model={model} database={database} />);
        });
        expect(container.querySelector('[data-testid="nat-type-counts"]')?.textContent).toBe('DNAT+SNAT 1 SNAT 74');
        const fipRow = container.querySelector('[data-testid="rule-row-fip-1"]')!;
        expect(fipRow.textContent).toContain('DNAT+SNAT');
        expect(fipRow.textContent).toContain('192.168.4.200');
        expect(fipRow.textContent).toContain('hive/hiveadmission-6b44465788-fnxq7');
        expect(fipRow.querySelector('button')).toBeNull();
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

    it('shows NAT match, priority and gateway port as columns when set', () => {
        const construct = byName('GR_cnv-1')!;
        const gatewayPort = database.logicalRouterPorts.find((port) => port.name === 'rtoe-GR_cnv-1')!;
        const extended = {
            ...construct,
            natRules: [
                {
                    uuid: 'n1',
                    type: 'snat' as const,
                    externalIp: '192.0.2.1',
                    logicalIp: '10.0.0.0/24',
                    match: 'ip4.dst == $set',
                    priority: 5,
                    gatewayPort: gatewayPort.uuid,
                },
            ],
        };
        act(() => {
            root.render(<ConstructDrawerBody construct={extended} model={model} database={database} />);
        });
        const headers = [...container.querySelectorAll('table[aria-label="NAT rules"] thead th')].map(
            (th) => th.textContent,
        );
        expect(headers).toEqual(['Type', 'External IP', 'Logical IP', 'Match', 'Priority', 'Gateway port']);
        const row = container.querySelector('[data-testid="rule-row-n1"]')!;
        expect(row.textContent).toContain('ip4.dst == $set');
        expect(row.textContent).toContain('rtoe-GR_cnv-1');
    });

    it('lists static routes as a table, default first, src-ip last, next hops resolved', () => {
        renderWithDatabase('ovn_cluster_router');
        const text = container.textContent ?? '';
        expect(text).toMatch(/Static routes \(\d+\)/);
        const rows = [...container.querySelectorAll('table[aria-label="Static routes"] tbody > tr')];
        const policies = rows.map((row) => row.querySelector('td[data-label="Policy"]')?.textContent);
        const firstSrc = policies.indexOf('src-ip');
        expect(firstSrc).toBeGreaterThan(0);
        expect(policies.slice(firstSrc).every((policy) => policy === 'src-ip')).toBe(true);

        const transit = rows.find((row) => row.textContent?.startsWith('10.130.0.0/23'))!;
        expect(transit.textContent).toContain('→ node ctrl-3');
        const join = rows.find((row) => row.textContent?.startsWith('10.131.0.0/23'))!;
        expect(join.textContent).toContain('→ rtoj-GR_cnv-1 (GR_cnv-1)');
    });

    it('calls out the default route and renders flags', () => {
        const construct = byName('GR_cnv-1')!;
        const extended = {
            ...construct,
            staticRouteRules: [
                { uuid: 'r2', ipPrefix: '10.0.0.0/8', nexthop: '192.168.4.9', routeTable: 'rt1', bfd: 'bfd-1' },
                ...construct.staticRouteRules,
                { uuid: 'r3', ipPrefix: '10.1.0.0/16', nexthop: '192.168.4.9', selectionFields: ['ip_src', 'ip_dst'] },
            ],
        };
        act(() => {
            root.render(<ConstructDrawerBody construct={extended} model={model} database={database} />);
        });
        const rows = [...container.querySelectorAll('table[aria-label="Static routes"] tbody > tr')];
        expect(rows[0].querySelector('td[data-label="Prefix"]')?.textContent).toBe('0.0.0.0/0 default');
        expect(rows[0].textContent).toContain('on-link via rtoe-GR_cnv-1');
        const r2 = container.querySelector('[data-testid="rule-row-r2"]')!;
        expect(r2.querySelector('td[data-label="Route table"]')?.textContent).toBe('rt1');
        expect(r2.querySelector('td[data-label="Flags"]')?.textContent).toBe('BFD');
        const r3 = container.querySelector('[data-testid="rule-row-r3"]')!;
        expect(r3.querySelector('td[data-label="Flags"]')?.textContent).toBe('ECMP ip_src,ip_dst');
        expect(r3.querySelector('td[data-label="Route table"]')?.textContent).toBe('main');
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

    const click = (element: Element | null | undefined) => {
        expect(element).toBeTruthy();
        act(() => {
            element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    };

    /** Expand the first row whose text includes `text`; returns its details row. */
    const expandPort = (text: string) => {
        const row = portRows().find((candidate) => candidate.textContent?.includes(text));
        expect(row).toBeDefined();
        click(row!.querySelector('button'));
        return row!.nextElementSibling as HTMLElement;
    };

    const showRawRow = () =>
        click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Show raw row'));

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
        // The chassis is a fact of the expanded row, not a table column.
        expect(container.querySelector('tbody a[href="/ovn-recon/ovn/cnv-1"]')).toBeNull();
        const details = expandPort('openshift-storage/');
        const nodeLinks = details.querySelectorAll('[data-testid="port-summary"] a[href="/ovn-recon/ovn/cnv-1"]');
        expect(nodeLinks.length).toBe(1);
        expect(nodeLinks[0].getAttribute('title')).toBe(chassisId);

        renderConstruct('cnv-1');
        expect(container.querySelector('tbody a[href="/ovn-recon/ovn/cnv-1"]')).toBeNull();
        expect(container.querySelector('[data-testid="port-summary"]')?.textContent).toContain('91bc7389…');
    });

    it('shows four columns that fit the drawer: name, type, IPs and the binding state', () => {
        renderConstruct('cnv-1');
        clickTab('Ports');
        const headers = [...container.querySelectorAll('table[aria-label="Switch ports"] > thead th')]
            .map((th) => th.textContent);
        expect(headers).toEqual(['Row expansion', 'Name', 'Type', 'Addresses', 'Up']);

        const podRow = portRows().find((row) => row.textContent?.includes('openshift-storage/'));
        expect(podRow).toBeDefined();
        const codes = [...podRow!.querySelectorAll('code')].map((code) => code.textContent ?? '');
        // The row shows the IP without the MAC every entry repeats.
        expect(codes.some((code) => /^\d+\.\d+\.\d+\.\d+$/.test(code))).toBe(true);
        expect(codes.some((code) => code.startsWith('0a:58:'))).toBe(false);
        expect(podRow!.textContent).toContain('Up');

        // The full entries, port security included, are in the expanded summary.
        const summary = expandPort('openshift-storage/').querySelector('[data-testid="port-summary"]')!;
        const summaryCodes = [...summary.querySelectorAll('code')].map((code) => code.textContent ?? '');
        expect(summaryCodes.filter((code) => /^0a:58:\S+ \S+/.test(code)).length).toBeGreaterThanOrEqual(2);
        expect(summary.textContent).toContain('Port security');

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

    it('expands a row to a port-groups placeholder, with the raw NB row behind a toggle', () => {
        // The ladder database: no policy section, and no node to load it from.
        const ladderDatabase: LogicalDatabase = { ...database };
        delete ladderDatabase.acls;
        delete ladderDatabase.portGroups;
        delete ladderDatabase.addressSets;
        renderConstruct('transit_switch', { database: ladderDatabase });
        clickTab('Ports');
        expect(container.querySelector('[data-testid="code-editor"]')).toBeNull();

        expandPort('tstor-cnv-3');
        // Expanding shows the summary, not the raw row.
        expect(container.querySelector('[data-testid="port-summary"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="code-editor"]')).toBeNull();
        showRawRow();
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
        click(portRows()[0].querySelector('button'));
        expect(container.querySelector('[data-testid="port-summary"]')).not.toBeNull();

        // Hop to another switch: still on Ports, nothing expanded.
        renderConstruct('join', { onSelectConstruct: jest.fn() });
        expect(selectedTab()).toBe('Ports');
        expect(portRows()).toHaveLength(switchRow('join').ports.length);
        expect(container.querySelector('[data-testid="port-summary"]')).toBeNull();

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
        fetchLookup.mockReset();
        fetchLookup.mockImplementation((_kind, value) => Promise.resolve(lookupOf(value, [])));
        mockKubeServices.clear();
        mockServiceNetworks.value = { serviceNetworks: ['172.30.0.0/16', 'fd02::/112'], loaded: true };
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
    const serviceRows = () => [...container.querySelectorAll('tr[data-testid^="rule-row-"]')];
    const NODE_TABLE = 'Services on this node';
    const CLUSTER_TABLE = 'Cluster-wide services';
    const rowsOf = (table: string) => [
        ...container.querySelectorAll(`table[aria-label="${table}"] tr[data-testid^="rule-row-"]`),
    ];
    const rowOf = (table: string, label: string) =>
        rowsOf(table).find((row) => row.querySelector('td[data-label="Service"]')?.textContent === label);
    const cellsOf = (row: Element): Record<string, Element> =>
        Object.fromEntries([...row.querySelectorAll('td[data-label]')].map((cell) => [cell.getAttribute('data-label'), cell]));
    const sectionText = (section: 'node' | 'cluster') =>
        container.querySelector(`[data-testid="services-section-${section}"]`)?.textContent ?? '';
    const toggleSection = (section: 'node' | 'cluster') => {
        const button = container.querySelector(`[data-testid="services-section-${section}"]`)?.closest('button');
        expect(button).toBeTruthy();
        act(() => {
            button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    };
    const expandRow = (row: Element) => {
        act(() => {
            row.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    };
    const select = (label: string, value: string) => {
        const element = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
        expect(element).not.toBeNull();
        act(() => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
            setter?.call(element, value);
            element!.dispatchEvent(new Event('change', { bubbles: true }));
        });
    };
    /** "namespace/name" of the load balancers set directly on a switch or router. */
    const directServices = (name: string) => {
        const row = [...database.logicalSwitches, ...database.logicalRouters].find((candidate) => candidate.name === name)!;
        const byUuid = new Map(database.loadBalancers!.map((lb) => [lb.uuid, lb]));
        return new Set(
            (row.loadBalancer ?? []).map((uuid) => {
                const owner = serviceOf(byUuid.get(uuid)!)!;
                return `${owner.namespace}/${owner.name}`;
            }),
        );
    };
    const lookupOf = (address: string, hits: Array<Partial<LookupHit>>): LookupResponse => ({
        query: { kind: 'ip', value: address },
        hits: hits.map((hit) => ({
            node: 'cnv-2',
            table: 'Logical_Switch_Port',
            rowUuid: 'lsp-1',
            network: 'default',
            matchedField: 'addresses',
            matchedValue: address,
            matchType: 'exact',
            snapshotGeneratedAt: '2026-11-10T00:00:00Z',
            ...hit,
        })) as LookupHit[],
        total: hits.length,
        limit: 200,
        truncated: false,
        zones: [],
        warnings: [],
    });
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

    it('states the split on the Overview in the Services tab\'s words', () => {
        renderConstruct('cnv-1');
        const value = overviewValue('Load balancers');
        expect(value).toMatch(/^22 here · \d+ cluster-wide · \d+ VIPs without endpoints$/);
        expect(value).not.toContain('not collected');
        // The per-group detail moved to the tooltip.
        expect(container.querySelector('[data-testid="load-balancer-split"]')?.getAttribute('title')).toMatch(
            /^22 direct · \d+ via clusterLBGroup · 0 via clusterSwitchLBGroup$/,
        );
        clickTab('Services');
        expect(container.querySelector('[data-testid="services-summary"]')?.textContent).toBe(`Load balancers: ${value}`);

        renderConstruct('GR_cnv-1');
        clickTab('Overview');
        expect(overviewValue('Load balancers')).toMatch(/^22 here · \d+ cluster-wide/);
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

    it('lists one row per Service in two sections, node-scoped first and the cluster-wide one collapsed', () => {
        renderConstruct('cnv-1');
        clickTab('Services');
        const here = directServices('cnv-1');
        expect(sectionText('node')).toBe(`On this node (cnv-1) · ${here.size} Services · 22 load balancers`);
        const cluster = /^Cluster-wide \(shared by every node switch and gateway router\) · (\d+) Services · (\d+) load balancers$/.exec(
            sectionText('cluster'),
        );
        expect(cluster).not.toBeNull();
        const clusterServices = Number(cluster![1]);
        // Far fewer rows than the VIPs the old table listed one by one.
        const vipCount = database.loadBalancers!.reduce((sum, row) => sum + Object.keys(row.vips).length, 0);
        expect(here.size + clusterServices).toBeLessThan(vipCount);

        const nodeRows = rowsOf(NODE_TABLE);
        expect(nodeRows).toHaveLength(here.size);
        expect(new Set(nodeRows.map((row) => cellsOf(row).Service.textContent))).toEqual(here);
        // Collapsed: only its count, no table.
        expect(container.querySelector(`table[aria-label="${CLUSTER_TABLE}"]`)).toBeNull();
        const nodeSection = container.querySelector('[data-testid="services-section-node"]')!;
        const clusterSection = container.querySelector('[data-testid="services-section-cluster"]')!;
        expect(nodeSection.compareDocumentPosition(clusterSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        toggleSection('cluster');
        expect(clusterServices).toBeGreaterThan(SERVICE_PAGE_SIZE);
        expect(rowsOf(CLUSTER_TABLE)).toHaveLength(SERVICE_PAGE_SIZE);
        expect(container.querySelector('[data-testid="rule-table-pager"]')).not.toBeNull();
        expect(container.textContent).not.toMatch(/narrow the filter/);
        expect(container.textContent).toContain('Load_Balancer rows from node cnv-1');
    });

    it('finds the Service behind a VIP and links to it', () => {
        renderConstruct('cnv-1');
        clickTab('Services');
        setFilter('172.30.0.1:443');
        const rows = rowsOf(NODE_TABLE);
        expect(rows).toHaveLength(1);
        const cells = cellsOf(rows[0]);
        const link = cells.Service.querySelector('a');
        expect(link?.textContent).toBe('default/kubernetes');
        expect(link?.getAttribute('href')).toBe('/k8s/ns/default/core~v1~Service/kubernetes');
        expect(cells.Type.textContent).toBe('ClusterIP (inferred)');
        expect(cells.Ports.textContent).toBe('443/TCP');
        expect(cells.VIPs.textContent).toBe('1');
        expect(cells.Backends.textContent).toBe('3');
        expect(sectionText('cluster')).toMatch(/· 0 of \d+ Services$/);

        setFilter('no-such-service');
        expect(serviceRows()).toHaveLength(0);
        expect(container.textContent).toContain('No services match.');
    });

    it('folds a Service with several ports and protocols into one row that expands to every VIP', () => {
        renderConstruct('cnv-1');
        clickTab('Services');
        // DNS is materialised per node: the switch sees its own node_switch
        // rows, over TCP and UDP, as one row.
        const dns = rowOf(NODE_TABLE, 'openshift-dns/dns-default')!;
        expect(cellsOf(dns).Ports.textContent).toBe('53/TCP53/UDP9154/TCP');
        expect(cellsOf(dns).VIPs.textContent).toBe('3');
        expandRow(dns);
        const vips = [...container.querySelectorAll('[data-testid="service-vip"]')];
        expect(vips.map((vip) => vip.querySelector('code')?.textContent)).toEqual([
            '172.30.0.10:53',
            '172.30.0.10:53',
            '172.30.0.10:9154',
        ]);
        expect(vips.map((vip) => vip.textContent).join('\n')).toContain('UDP');
        const detail = container.querySelector('[data-testid="service-detail"]')!.textContent ?? '';
        expect(detail).toContain('Service_openshift-dns/dns-default_UDP_node_switch_cnv-1');
        expect(detail).toContain('(set directly)');

        // A Service with many node ports collapses its chips.
        const frr = rowOf(NODE_TABLE, 'demo-cl-frr-01/frr-bgp-demo-frr1')!;
        expect(cellsOf(frr).Type.textContent).toBe('NodePort (inferred)');
        expect(cellsOf(frr).Ports.textContent).toMatch(/\d+ more$/);
    });

    it('shows a backend in this zone with its pod beside the address', () => {
        renderConstruct('cnv-1');
        clickTab('Services');
        toggleSection('cluster');
        setFilter('cert-manager/cert-manager-webhook');
        const row = rowOf(CLUSTER_TABLE, 'cert-manager/cert-manager-webhook')!;
        expandRow(row);
        const owner = podAddressIndex(database)('10.131.0.6')!;
        const backend = [...container.querySelectorAll('[data-testid="service-backend"]')].find((line) =>
            line.querySelector('code')?.textContent?.startsWith('10.131.0.6:'),
        )!;
        const link = backend.querySelector('a')!;
        expect(link.textContent).toBe(`${owner.namespace}/${owner.pod}`);
        expect(link.getAttribute('href')).toBe(`/k8s/ns/${owner.namespace}/core~v1~Pod/${owner.pod}`);
        // In-zone owners need no lookup.
        expect(fetchLookup).not.toHaveBeenCalledWith('ip', '10.131.0.6');
    });

    it('looks backends on other nodes up on expand, and resolves an address on two ports to nothing', async () => {
        fetchLookup.mockImplementation((_kind, value) =>
            Promise.resolve(
                value === '10.129.4.200'
                    ? lookupOf(value, [
                        { owner: { kind: 'Pod', namespace: 'ovn-recon-fixture', name: 'echo-a' } },
                        // The same port again through another field.
                        { matchedField: 'portSecurity', owner: { kind: 'Pod', namespace: 'ovn-recon-fixture', name: 'echo-a' } },
                    ])
                    : value === '10.130.0.200'
                        ? lookupOf(value, [
                            { rowUuid: 'lsp-a', owner: { kind: 'Pod', namespace: 'blue', name: 'one' } },
                            { rowUuid: 'lsp-b', node: 'cnv-3', owner: { kind: 'Pod', namespace: 'green', name: 'two' } },
                        ])
                        : lookupOf(value, []),
            ),
        );
        renderConstruct('cnv-1');
        clickTab('Services');
        toggleSection('cluster');
        setFilter('dual-stack-echo');
        const row = rowOf(CLUSTER_TABLE, 'ovn-recon-fixture/dual-stack-echo')!;
        expect(cellsOf(row).VIPs.textContent).toBe('2');
        expect(cellsOf(row).Type.textContent).toBe('ClusterIP (inferred)');
        expect(fetchLookup).not.toHaveBeenCalled();

        expandRow(row);
        await act(async () => undefined);
        expect(fetchLookup.mock.calls.map(([, value]) => value).sort()).toEqual([
            '10.129.4.200',
            '10.130.0.200',
            'fd01:0:0:5::c8',
            'fd01:0:0:6::c8',
        ]);
        const lines = [...container.querySelectorAll('[data-testid="service-backend"]')];
        const line = (backend: string) => lines.find((candidate) => candidate.querySelector('code')?.textContent === backend)!;
        expect(line('10.129.4.200:8080').textContent).toBe('10.129.4.200:8080 ovn-recon-fixture/echo-a on cnv-2');
        expect(line('10.130.0.200:8080').querySelector('a')).toBeNull();
        expect(line('[fd01:0:0:5::c8]:8080').querySelector('a')).toBeNull();

        // Collapse and expand again: answered from the tab's cache.
        expandRow(row);
        expandRow(row);
        await act(async () => undefined);
        expect(fetchLookup).toHaveBeenCalledTimes(4);
    });

    it('says when backends on other nodes could not be looked up', async () => {
        fetchLookup.mockRejectedValue(new Error('Collector request failed (404)'));
        renderConstruct('cnv-1');
        clickTab('Services');
        toggleSection('cluster');
        setFilter('dual-stack-echo');
        expandRow(rowOf(CLUSTER_TABLE, 'ovn-recon-fixture/dual-stack-echo')!);
        await act(async () => undefined);
        expect(container.querySelector('[data-testid="backend-lookup-error"]')?.textContent).toBe(
            '4 backends on other nodes could not be looked up: Collector request failed (404)',
        );
    });

    it('narrows by type, protocol, namespace and missing endpoints', () => {
        renderConstruct('cnv-1');
        clickTab('Services');
        toggleSection('cluster');
        const allNode = rowsOf(NODE_TABLE).length;

        select('Filter by type', 'NodePort');
        expect(rowsOf(NODE_TABLE).length).toBeGreaterThan(0);
        expect(rowsOf(NODE_TABLE).length).toBeLessThan(allNode);
        expect(rowsOf(NODE_TABLE).every((row) => cellsOf(row).Type.textContent?.includes('NodePort'))).toBe(true);
        // Node ports are per node: none is shared cluster-wide.
        expect(rowsOf(CLUSTER_TABLE)).toHaveLength(0);

        select('Filter by type', 'LoadBalancer');
        expect(rowsOf(NODE_TABLE)).toHaveLength(0);
        expect(rowsOf(CLUSTER_TABLE).map((row) => cellsOf(row).Service.textContent)).toContain(
            'demo-cl-frr-01/frr-bgp-demo-frr1',
        );
        select('Filter by type', '');

        select('Filter by protocol', 'udp');
        // The Services whose load balancers set on the switch carry UDP.
        const switchRow = database.logicalSwitches.find((row) => row.name === 'cnv-1')!;
        const udpHere = new Set(
            database.loadBalancers!
                .filter((row) => switchRow.loadBalancer!.includes(row.uuid) && row.protocol === 'udp')
                .map((row) => `${serviceOf(row)!.namespace}/${serviceOf(row)!.name}`),
        );
        expect(udpHere.has('openshift-dns/dns-default')).toBe(true);
        expect(new Set(rowsOf(NODE_TABLE).map((row) => cellsOf(row).Service.textContent))).toEqual(udpHere);
        select('Filter by protocol', '');

        select('Filter by namespace', 'openshift-dns');
        expect(rowsOf(NODE_TABLE).map((row) => cellsOf(row).Service.textContent)).toEqual(['openshift-dns/dns-default']);
        select('Filter by namespace', '');

        const checkbox = container.querySelector<HTMLInputElement>('#services-without-endpoints')!;
        const withoutCount = Number(/\((\d+)\)/.exec(checkbox.closest('.pf-v6-c-check')?.textContent ?? '')?.[1]);
        act(() => {
            checkbox.click();
        });
        const idle = [...rowsOf(NODE_TABLE), ...rowsOf(CLUSTER_TABLE)];
        expect(idle).toHaveLength(withoutCount);
        expect(idle.every((row) => /No endpoints|without endpoints/.test(cellsOf(row).Backends.textContent ?? ''))).toBe(true);
        expandRow(idle[0]);
        expect(container.textContent).toContain('the Service has no ready endpoints, and OVN rejects connections to this VIP');
    });

    it('sorts by a column', () => {
        renderConstruct('cnv-1');
        clickTab('Services');
        const header = [...container.querySelectorAll(`table[aria-label="${NODE_TABLE}"] th button`)].find(
            (button) => button.textContent === 'VIPs',
        )!;
        act(() => {
            header.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        const ascending = rowsOf(NODE_TABLE).map((row) => Number(cellsOf(row).VIPs.textContent));
        expect(ascending).toEqual([...ascending].sort((a, b) => a - b));
        act(() => {
            header.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        const descending = rowsOf(NODE_TABLE).map((row) => Number(cellsOf(row).VIPs.textContent));
        expect(descending).toEqual([...descending].sort((a, b) => b - a));
    });

    it('reads the Service on expand and keeps its types declared', () => {
        mockKubeServices.set('openshift-dns/dns-default', {
            metadata: { name: 'dns-default', namespace: 'openshift-dns' },
            spec: { type: 'ClusterIP', clusterIPs: ['172.30.0.10'], internalTrafficPolicy: 'Cluster' },
        });
        renderConstruct('cnv-1');
        clickTab('Services');
        const typeOf = () => cellsOf(rowOf(NODE_TABLE, 'openshift-dns/dns-default')!).Type;
        expect(typeOf().querySelector('[data-testid="vip-class"]')?.getAttribute('data-basis')).toBe('inferred');

        expandRow(rowOf(NODE_TABLE, 'openshift-dns/dns-default')!);
        expect(container.querySelector('[data-testid="service-declared"]')?.textContent).toBe('Declared type ClusterIP');
        expect(typeOf().textContent).toBe('ClusterIP');
        expect(typeOf().querySelector('[data-testid="vip-class"]')?.getAttribute('data-basis')).toBe('declared');

        // Collapsed again, the row keeps what was read.
        expandRow(rowOf(NODE_TABLE, 'openshift-dns/dns-default')!);
        expect(container.querySelector('[data-testid="service-declared"]')).toBeNull();
        expect(typeOf().textContent).toBe('ClusterIP');
    });

    it('says what the types rest on, including when the service network cannot be read', () => {
        renderConstruct('cnv-1');
        clickTab('Services');
        expect(container.querySelector('[data-testid="services-basis"]')?.textContent).toContain(
            'inferred from OVN and the service network 172.30.0.0/16, fd02::/112',
        );

        mockServiceNetworks.value = { serviceNetworks: [], loaded: true, error: 'networks.config.openshift.io "cluster" is forbidden' };
        renderConstruct('GR_cnv-1');
        expect(container.querySelector('[data-testid="services-basis"]')?.textContent).toContain(
            'the cluster Network config could not be read (networks.config.openshift.io "cluster" is forbidden)',
        );
        // Without it the external addresses on the node's own subnet still
        // read as external; the rest of the gateway router's rows as ClusterIP.
        toggleSection('cluster');
        select('Filter by type', 'LoadBalancer');
        expect(rowsOf(CLUSTER_TABLE).length).toBeGreaterThan(0);
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
        expect(rowsOf(NODE_TABLE)).toHaveLength(directServices('cnv-1').size);
        clickTab('Overview');
        expect(overviewValue('Load balancers')).toMatch(/^22 here · \d+ cluster-wide/);

        // A construct that needs neither section (a router without load
        // balancers) costs no request.
        renderConstruct('ovn_cluster_router', { database: ladderDatabase, databaseNode: 'cnv-1', sectionsRefreshKey: 't1' });
        expect(fetchSnapshot).toHaveBeenCalledTimes(1);
        // Back on a construct with load balancers on the same node: the rows
        // already loaded show at once while the request is repeated.
        renderConstruct('GR_cnv-1', { database: ladderDatabase, databaseNode: 'cnv-1', sectionsRefreshKey: 't1' });
        expect(overviewValue('Load balancers')).toMatch(/^22 here · \d+ cluster-wide/);
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

    it('orders an expanded port as summary, then policy, then the raw row on request', () => {
        renderConstruct('cnv-1');
        clickTab('Ports');
        expandPort('openshift-monitoring/alertmanager-main-1');

        const summary = container.querySelector('[data-testid="port-summary"]');
        const raw = container.querySelector('[data-testid="port-raw"]');
        expect(summary).not.toBeNull();
        expect(portPolicy()).not.toBeNull();
        expect(raw).not.toBeNull();
        const follows = (first: Element, second: Element) =>
            Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
        expect(follows(summary!, portPolicy()!)).toBe(true);
        expect(follows(portPolicy()!, raw!)).toBe(true);

        // The summary answers the first questions; the raw row stays folded.
        const terms = [...summary!.querySelectorAll('dt')].map((term) => term.textContent);
        expect(terms).toEqual(['Addresses', 'Port security', 'State', 'Requested chassis', 'OVN name']);
        expect(container.querySelector('[data-testid="code-editor"]')).toBeNull();
        const toggle = [...raw!.querySelectorAll('button')].find((button) => button.textContent === 'Show raw row')!;
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        act(() => {
            toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(toggle.textContent).toBe('Hide raw row');
        const editor = raw!.querySelector('[data-testid="code-editor"]');
        expect(JSON.parse(editor!.textContent ?? '{}').name).toBe(policyPod);
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

        it('links the same rows to a NetworkPolicy when the controller\'s network is primary', () => {
            // A NetworkPolicy in a namespace served by a primary UDN is
            // written by that network's controller, in the very same shape.
            const primary: LogicalDatabase = {
                ...secondary,
                logicalSwitches: [{
                    ...secondary.logicalSwitches[0],
                    externalIds: { ...secondary.logicalSwitches[0].externalIds, 'k8s.ovn.org/role': 'primary' },
                }],
            };
            renderConstruct(
                'cluster_udn_vlan.1924_ovn_localnet_switch',
                { database: primary, databaseNode: 'cnv-1' },
                buildLadderModel(primary),
            );
            clickTab('Ports');
            expandPort('virt-launcher-vm-a-x7k2p');
            const policyGroup = groupRows().find((row) => row.textContent?.includes('demo-mirror/restrict'))!;
            expect(policyGroup.textContent?.startsWith('NetworkPolicy')).toBe(true);
            expect(hrefs(policyGroup)).toContain('/k8s/ns/demo-mirror/networking.k8s.io~v1~NetworkPolicy/restrict');
            expect(container.textContent).not.toContain('MultiNetworkPolicy');
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

describe('rowAddresses', () => {
    it('drops the leading MAC and keeps every IP, one per line', () => {
        expect(rowAddresses(['0a:58:0a:83:00:1f 10.131.0.31'])).toEqual(['10.131.0.31']);
        expect(rowAddresses(['0a:58:0a:83:00:1f 10.131.0.31 fd01:0:0:3::1f'])).toEqual(['10.131.0.31', 'fd01:0:0:3::1f']);
    });

    it('passes keywords and bare MACs through', () => {
        expect(rowAddresses(['router'])).toEqual(['router']);
        expect(rowAddresses(['unknown', '0a:58:0a:83:00:1f'])).toEqual(['unknown', '0a:58:0a:83:00:1f']);
        expect(rowAddresses(undefined)).toEqual([]);
    });
});
