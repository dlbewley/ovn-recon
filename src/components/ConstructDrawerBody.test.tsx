import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { LogicalDatabase, LogicalTopologySnapshot } from '../types';
import { buildLadderModel } from './logicalLadderModel';
import ConstructDrawerBody, { natRuleText, staticRouteText } from './ConstructDrawerBody';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';

jest.mock('react-router', () => ({
    Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
        <a href={String(to)}>{children}</a>
    ),
}));

// Monaco does not run under jsdom; the Config tab's editor renders as a pre.
jest.mock('@patternfly/react-code-editor', () => ({
    CodeEditor: ({ code }: { code: string }) => <pre data-testid="code-editor">{code}</pre>,
    Language: { json: 'json' },
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
