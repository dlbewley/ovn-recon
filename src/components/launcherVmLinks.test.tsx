import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { LogicalDatabase, LogicalTopologySnapshot } from '../types';
import { LinkOutProvider } from '../linkOut/LinkOut';
import { KUBEVIRT, NO_KUBEVIRT } from '../linkOut/testCapabilities';
import ConstructDrawerBody, { DrawerBodyProps } from './ConstructDrawerBody';
import { buildLadderModel } from './logicalLadderModel';
import { policyIndexFor } from './policyIndex';
import PolicyBody from './PolicyTables';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';

/**
 * A VM's port wherever the logical view names its pod (ovn-recon-zdt.5). The
 * captured snapshots hold no VM, so one is added to cnv-1: a launcher pod whose VMI
 * exists, with a NAT rule and a port group, and a launcher pod with no VMI.
 */

const VM_POD = 'virt-launcher-db-1-x7k2p';
const ORPHAN_POD = 'virt-launcher-gone-abcde';
const VM_PATH = '/k8s/ns/shop/kubevirt.io~v1~VirtualMachine/db-1';
const VM_POD_PATH = `/k8s/ns/shop/core~v1~Pod/${VM_POD}`;

const mockCapabilities = jest.fn();
jest.mock('../linkOut/useConsoleCapabilities', () => ({
    useConsoleCapabilities: () => mockCapabilities() ?? jest.requireActual('../linkOut/registry').NO_CAPABILITIES,
}));

const mockVmiWatch = jest.fn();
const mockIndex = jest.requireActual('../linkOut/launcherVm').launcherVmIndex([{
    metadata: {
        namespace: 'shop',
        name: 'db-1',
        ownerReferences: [{ apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine', name: 'db-1', controller: true }],
    },
}]);
jest.mock('../linkOut/useLauncherVmIndex', () => ({
    useLauncherVmIndex: (enabled: boolean) => {
        mockVmiWatch(enabled);
        return enabled ? mockIndex : jest.requireActual('../linkOut/launcherVm').NO_LAUNCHER_VMS;
    },
}));

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    useK8sWatchResource: () => [[], true, undefined],
}));

jest.mock('react-router', () => ({
    Link: ({ to, children, title }: { to: string; children: React.ReactNode; title?: string }) => (
        <a href={String(to)} title={title}>{children}</a>
    ),
}));

jest.mock('@patternfly/react-code-editor', () => ({
    CodeEditor: ({ code }: { code: string }) => <pre>{code}</pre>,
    Language: { json: 'json' },
}));

const captured = (cnv1 as unknown as LogicalTopologySnapshot).database as LogicalDatabase;

const databaseWithVm = (): LogicalDatabase => {
    const database: LogicalDatabase = JSON.parse(JSON.stringify(captured));
    const port = (uuid: string, pod: string, ip: string) => ({
        uuid,
        name: `shop_${pod}`,
        addresses: [`0a:58:0a:83:01:fa ${ip}`],
        up: true,
        externalIds: { namespace: 'shop', pod: 'true' },
    });
    database.logicalSwitchPorts.push(port('lsp-vm', VM_POD, '10.131.1.250'), port('lsp-orphan', ORPHAN_POD, '10.131.1.251'));
    database.logicalSwitches.find((row) => row.name === 'cnv-1')!.ports!.push('lsp-vm', 'lsp-orphan');
    database.nats.push(
        { uuid: 'nat-vm', type: 'snat', externalIp: '192.168.4.72', logicalIp: '10.131.1.250' },
        { uuid: 'nat-orphan', type: 'snat', externalIp: '192.168.4.72', logicalIp: '10.131.1.251' },
    );
    database.logicalRouters.find((row) => row.name === 'GR_cnv-1')!.nat!.push('nat-vm', 'nat-orphan');
    database.portGroups!.push({ uuid: 'pg-vm', name: 'a_vm_group', ports: ['lsp-vm'], acls: [], externalIds: {} });
    return database;
};

const database = databaseWithVm();
const model = buildLadderModel(database);
const construct = (name: string) => model.constructs.find((candidate) => candidate.name === name)!;

describe('launcher pods shown as their VirtualMachine (ovn-recon-zdt.5)', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        mockCapabilities.mockReset();
        mockVmiWatch.mockClear();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const renderDrawer = (name: string) => {
        act(() => {
            root.render(<ConstructDrawerBody construct={construct(name)} model={model} database={database} />);
        });
    };
    const click = (element: Element | null | undefined) => {
        expect(element).toBeTruthy();
        act(() => {
            element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    };
    const button = (label: string) =>
        [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
    const links = (scope: Element = container) =>
        [...scope.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);
    const portRow = (pod: string) =>
        [...container.querySelectorAll('tr[data-testid^="port-row-"]')]
            .find((row) => row.textContent?.includes(pod));
    const filter = (label: string, text: string) => {
        const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    };
    const openPorts = () => {
        renderDrawer('cnv-1');
        click(button('Ports'));
        filter('Filter ports', 'virt-launcher');
    };
    const openWorkloadPorts = () => {
        renderDrawer('cnv-1');
        filter('Filter workload ports', 'virt-launcher');
    };
    const openNatGroup = () => {
        renderDrawer('GR_cnv-1');
        const group = [...container.querySelectorAll('table[aria-label="NAT rules"] tbody > tr')]
            .find((row) => row.querySelector('[data-testid="nat-group-logical"]'));
        click(group?.querySelector('button'));
        return container.querySelector('[data-testid="nat-group-addresses"]')!;
    };
    /** The last cell of the address's line: a port range column may come between. */
    const natOwner = (addresses: Element, ip: string) => {
        const cells = [...addresses.children];
        const columns = (addresses as HTMLElement).style.gridTemplateColumns.split(' ').length;
        return cells[cells.findIndex((cell) => cell.textContent === ip) + columns - 1];
    };
    const openPortGroup = () => {
        const props = {
            construct: construct('cnv-1'),
            policy: {
                status: 'ready',
                index: policyIndexFor(database),
                database,
                switchUuid: database.logicalSwitches.find((row) => row.name === 'cnv-1')!.uuid,
            },
            databaseNode: 'cnv-1',
            // The table is paged, and the page owns this filter.
            query: 'a_vm_group',
        } as unknown as DrawerBodyProps;
        act(() => {
            root.render(<LinkOutProvider><PolicyBody {...props} /></LinkOutProvider>);
        });
        click(container.querySelector('#policy-view-groups'));
        click(container.querySelector('tr[data-testid="rule-row-pg-vm"] button'));
    };

    describe('with KubeVirt', () => {
        beforeEach(() => mockCapabilities.mockReturnValue(KUBEVIRT));

        const expectVm = (scope: Element) => {
            expect(links(scope)).toEqual(expect.arrayContaining([
                ['VM shop/db-1', VM_PATH],
                [`Pod ${VM_POD}`, VM_POD_PATH],
            ]));
            expect(links(scope).map(([text]) => text)).not.toContain(`shop/${VM_POD}`);
        };

        it('names the VM on the Ports tab and keeps the pod as a secondary link', () => {
            openPorts();
            expectVm(portRow(VM_POD)!);
        });

        it('finds the port by the name it now shows', () => {
            openPorts();
            filter('Filter ports', 'vm shop/db-1');
            expect(portRow(VM_POD)).toBeDefined();
            expect(portRow(ORPHAN_POD)).toBeUndefined();
        });

        it('names the VM in the workload port list', () => {
            openWorkloadPorts();
            expect(links()).toEqual(expect.arrayContaining([['VM shop/db-1', VM_PATH]]));
        });

        it('names the VM in an expanded NAT group', () => {
            expectVm(natOwner(openNatGroup(), '10.131.1.250'));
        });

        it('names the VM among the ports of a port group', () => {
            openPortGroup();
            expectVm(container);
        });

        it('shows a launcher pod with no VMI as the pod it is', () => {
            openPorts();
            expect(links(portRow(ORPHAN_POD)!)).toEqual([
                [`shop/${ORPHAN_POD}`, `/k8s/ns/shop/core~v1~Pod/${ORPHAN_POD}`],
            ]);
            expect(links(natOwner(openNatGroup(), '10.131.1.251'))).toEqual([
                [`shop/${ORPHAN_POD}`, `/k8s/ns/shop/core~v1~Pod/${ORPHAN_POD}`],
            ]);
        });

        it('watches VMIs only while a launcher pod is on screen', () => {
            const plain = buildLadderModel(captured);
            act(() => {
                root.render(
                    <ConstructDrawerBody
                        construct={plain.constructs.find((candidate) => candidate.name === 'cnv-1')!}
                        model={plain}
                        database={captured}
                    />,
                );
            });
            click(button('Ports'));
            expect(mockVmiWatch).toHaveBeenCalled();
            expect(mockVmiWatch).not.toHaveBeenCalledWith(true);

            openPorts();
            expect(mockVmiWatch).toHaveBeenLastCalledWith(true);
        });
    });

    describe.each([
        ['the kubevirt.io kinds are absent', NO_KUBEVIRT],
        ['nothing is known about them yet', undefined],
    ])('when %s', (_title, capabilities) => {
        beforeEach(() => mockCapabilities.mockReturnValue(capabilities));

        const podOnly = (scope: Element) => {
            expect(links(scope)).toEqual([[`shop/${VM_POD}`, VM_POD_PATH]]);
        };

        afterEach(() => {
            expect(container.querySelector('[data-testid="launcher-vm"]')).toBeNull();
            expect(container.innerHTML).not.toContain('kubevirt.io~v1');
            expect(mockVmiWatch).not.toHaveBeenCalledWith(true);
        });

        it('leaves the Ports tab as it was', () => {
            openPorts();
            podOnly(portRow(VM_POD)!);
        });

        it('leaves the workload port list as it was', () => {
            openWorkloadPorts();
            expect(links()).toEqual(expect.arrayContaining([[`shop/${VM_POD}`, VM_POD_PATH]]));
        });

        it('leaves an expanded NAT group as it was', () => {
            podOnly(natOwner(openNatGroup(), '10.131.1.250'));
        });

        it('leaves the ports of a port group as they were', () => {
            openPortGroup();
            expect(links()).toEqual(expect.arrayContaining([[`shop/${VM_POD}`, VM_POD_PATH]]));
        });
    });
});
