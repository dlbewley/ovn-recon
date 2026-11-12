import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter } from 'react-router';

import { OwnerName } from '../components/ConstructDrawerBody';
import { ChipLink } from '../components/drawerKit';
import { FactList } from '../topology/facts';
import { ConsoleLink, SecondaryLinks, StaticLinkOutProvider } from './LinkOut';
import { ConsoleCapabilities, LinkTarget } from './registry';
import { BARE, OCP_4_22, OCP_5_1 } from './testCapabilities';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    useK8sWatchResource: () => [[], true, undefined],
}));

jest.mock('@patternfly/react-code-editor', () => ({
    CodeEditor: ({ code }: { code: string }) => <pre>{code}</pre>,
    Language: { yaml: 'yaml' },
}));

const iface: LinkTarget = { type: 'node-interface', node: 'worker-1', name: 'ens192', interfaceType: 'ethernet' };

describe('link-out components (ovn-recon-zdt.4)', () => {
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

    const render = (node: React.ReactNode, capabilities?: ConsoleCapabilities) => {
        act(() => {
            root.render(
                <MemoryRouter>
                    {capabilities
                        ? <StaticLinkOutProvider capabilities={capabilities}>{node}</StaticLinkOutProvider>
                        : node}
                </MemoryRouter>
            );
        });
    };

    const anchors = () => [...container.querySelectorAll('a')].map((a) => ({
        text: a.textContent,
        href: a.getAttribute('href'),
        owner: a.getAttribute('data-link-owner'),
        target: a.getAttribute('target'),
    }));

    describe('ConsoleLink', () => {
        const policy: LinkTarget = {
            type: 'resource',
            ref: { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', namespace: 'demo', name: 'restrict' },
        };

        it('links in-app, in the same tab, and says which plugin owns the page', () => {
            render(<ConsoleLink target={policy}>restrict</ConsoleLink>, OCP_4_22);
            expect(anchors()).toEqual([{
                text: 'restrict',
                href: '/k8s/ns/demo/networking.k8s.io~v1~NetworkPolicy/restrict',
                owner: 'networking-console-plugin',
                target: null,
            }]);
        });

        it('falls back to the console\'s page with no provider at all', () => {
            render(<ConsoleLink target={policy}>restrict</ConsoleLink>);
            expect(anchors()).toEqual([{
                text: 'restrict',
                href: '/k8s/ns/demo/networking.k8s.io~v1~NetworkPolicy/restrict',
                owner: 'console',
                target: null,
            }]);
        });

        it('renders the text alone when no page is there', () => {
            render(<ConsoleLink target={{ type: 'physical-network', name: 'physnet' }}>physnet</ConsoleLink>, BARE);
            expect(anchors()).toEqual([]);
            expect(container.textContent).toBe('physnet');
        });

        it('renders nothing at all when asked to hide an absent page', () => {
            render(
                <ConsoleLink target={{ type: 'physical-network', name: 'physnet' }} hideWhenAbsent>
                    Open in Physical networks
                </ConsoleLink>,
                BARE,
            );
            expect(container.textContent).toBe('');
        });
    });

    describe('SecondaryLinks', () => {
        it('offers nmstate\'s interface details for an interface when the plugin is loaded', () => {
            render(<SecondaryLinks target={iface} />, OCP_5_1);
            expect(anchors()).toEqual([{
                text: 'Interface details in nmstate',
                href: '/k8s/cluster/nmstate.io~v1beta1~NodeNetworkState?selectedState=worker-1&selectedInterface=ens192&selectedInterfaceType=ethernet',
                owner: 'nmstate-console-plugin',
                target: null,
            }]);
        });

        it('renders nothing when the plugin is absent', () => {
            render(<SecondaryLinks target={iface} />, BARE);
            expect(container.innerHTML).toBe('');
        });
    });

    describe('in the physical drawer', () => {
        const facts = [{
            label: 'Physical Network',
            value: [{ text: 'physnet', target: { type: 'physical-network', name: 'physnet' } as LinkTarget }],
            provenance: 'declared' as const,
        }, {
            label: 'Configured By',
            value: [{
                text: 'storage-vlan',
                ref: { apiVersion: 'nmstate.io/v1', kind: 'NodeNetworkConfigurationPolicy', name: 'storage-vlan' },
            }],
            provenance: 'observed' as const,
        }, {
            label: 'Namespace',
            value: [{ text: 'demo', href: '/k8s/cluster/projects/demo' }],
            provenance: 'declared' as const,
        }];

        it('links a physical network only where the console has the page', () => {
            render(<FactList facts={facts} />, OCP_5_1);
            expect(anchors().find((a) => a.text === 'physnet')).toMatchObject({
                href: '/physical-networks', owner: 'networking-console-plugin',
            });

            render(<FactList facts={facts} />, BARE);
            expect(anchors().find((a) => a.text === 'physnet')).toBeUndefined();
            expect(container.textContent).toContain('physnet');
        });

        it('sends an NNCP to nmstate\'s page and keeps every fact link in-app', () => {
            render(<FactList facts={facts} />, OCP_4_22);
            expect(anchors().find((a) => a.text === 'storage-vlan')).toMatchObject({
                href: '/k8s/cluster/nmstate.io~v1~NodeNetworkConfigurationPolicy/storage-vlan',
                owner: 'nmstate-console-plugin',
            });
            expect(anchors().find((a) => a.text === 'demo')?.href).toBe('/k8s/cluster/projects/demo');
            expect(anchors().every((a) => a.target === null)).toBe(true);
        });

        it('resolves an identity chip to a link', () => {
            render(
                <ChipLink
                    chip={{
                        kind: 'Node',
                        value: 'worker-1',
                        target: { type: 'resource', ref: { apiVersion: 'v1', kind: 'Node', name: 'worker-1' } },
                    }}
                />,
                BARE,
            );
            expect(anchors()).toMatchObject([{ text: 'Node worker-1', href: '/k8s/cluster/core~v1~Node/worker-1' }]);
        });
    });

    describe('in the logical drawer', () => {
        const owner = {
            controller: 'default-network-controller',
            type: 'NetworkPolicy',
            name: 'demo:restrict',
            extra: {},
        };
        const roleOf = () => 'primary' as const;

        it('sends a policy owner to the networking plugin\'s page when it is loaded', () => {
            render(<OwnerName owner={owner} roleOf={roleOf} />, OCP_4_22);
            expect(anchors()).toEqual([{
                text: 'demo/restrict',
                href: '/k8s/ns/demo/networking.k8s.io~v1~NetworkPolicy/restrict',
                owner: 'networking-console-plugin',
                target: null,
            }]);
        });

        it('sends it to the console\'s page when the plugin is absent', () => {
            render(<OwnerName owner={owner} roleOf={roleOf} />, BARE);
            expect(anchors()).toMatchObject([{
                href: '/k8s/ns/demo/networking.k8s.io~v1~NetworkPolicy/restrict', owner: 'console',
            }]);
        });

        it('opens a namespace owner as its Project', () => {
            render(
                <OwnerName
                    owner={{ controller: 'default-network-controller', type: 'Namespace', name: 'demo', extra: {} }}
                    roleOf={roleOf}
                />,
                BARE,
            );
            expect(anchors()).toMatchObject([{ text: 'demo', href: '/k8s/cluster/projects/demo' }]);
        });
    });
});
