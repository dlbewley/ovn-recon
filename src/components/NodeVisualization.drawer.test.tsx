import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { ClusterUserDefinedNetwork, NodeNetworkState } from '../types';
import NodeVisualization from './NodeVisualization';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    useK8sWatchResource: () => [[]]
}));

/**
 * Smoke coverage for the detail drawer, added ahead of ovn-recon-s3t.5.
 *
 * The drawer is the largest thing that extraction moves -- nodeKindRegistry is
 * ~500 lines of per-kind JSX written against `any`, so a botched move surfaces as
 * a blank panel or a thrown render rather than as a compile error. Until now no
 * test opened the drawer at all.
 *
 * Deliberately shallow. It asserts that each kind opens, that every tab renders
 * something, and that a handful of load-bearing values arrive. It does NOT pin
 * down wording: that prose is about to be replaced by the Fact model in
 * ovn-recon-s3t.12, and tests asserting today's phrasing would be deleted with it.
 */

const TABS = ['Summary', 'Details', 'Links', 'YAML'] as const;

const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

describe('NodeVisualization drawer', () => {
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

    const renderPrimary = () => {
        act(() => {
            root.render(
                <NodeVisualization
                    nns={fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json')}
                    cudns={fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json')}
                    udns={[]} nads={[]} routeAdvertisements={[]}
                />
            );
        });
    };

    const renderBonded = () => {
        act(() => {
            root.render(
                <NodeVisualization
                    nns={fixture<NodeNetworkState>('nns', 'bonded-lldp.json')}
                    cudns={[]} udns={[]} nads={[]} routeAdvertisements={[]}
                />
            );
        });
    };

    const toggle = (id: string) => {
        const input = container.querySelector<HTMLInputElement>(`#${id}`);
        expect(input).not.toBeNull();
        act(() => input!.click());
    };

    /** Node groups are the ones drawing their own rect; the others are layout wrappers. */
    const nodeGroups = () =>
        Array.from(container.querySelectorAll('g'))
            .filter((g) => Array.from(g.children).some((c) => c.tagName.toLowerCase() === 'rect'));

    const clickNode = (title: string) => {
        const group = nodeGroups().find((g) => g.querySelector('title')?.textContent === title);
        if (!group) {
            throw new Error(`no node titled "${title}". Present: ${
                nodeGroups().map((g) => g.querySelector('title')?.textContent).join(', ')}`);
        }
        act(() => { group.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    };

    const drawerTitle = () => container.querySelector('h2')?.textContent ?? '';

    const tabButton = (name: string) =>
        Array.from(container.querySelectorAll('button'))
            .find((b) => (b.textContent ?? '').trim() === name);

    const selectTab = (name: string) => {
        const button = tabButton(name);
        expect(button).toBeDefined();
        act(() => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    };

    const panelText = () => {
        const panel = container.querySelector('.pf-v6-c-drawer__panel');
        return (panel ?? container).textContent ?? '';
    };

    /** Every tab renders, produces content, and does not throw. */
    const expectEveryTabRenders = (nodeTitle: string) => {
        TABS.forEach((tab) => {
            expect(() => selectTab(tab)).not.toThrow();
            expect(tabButton(tab)).toBeDefined();
            // An explicit empty state ("No links available.") is content; a blank
            // panel is the failure this guards against.
            expect(panelText().trim().length).toBeGreaterThan(20);
        });
        // Selecting tabs must not lose the selection.
        expect(drawerTitle().length).toBeGreaterThan(0);
        expect(nodeTitle).toContain(drawerTitle());
    };

    describe('opens for every node kind the fixtures reach', () => {
        it.each([
            ['interface (ethernet)', 'ens192 (ethernet)', 'ens192'],
            ['interface (ovs-bridge)', 'br-ex (ovs-bridge)', 'br-ex'],
            ['ovn-mapping', 'physnet (OVN Bridge Mapping)', 'physnet'],
            ['vrf', 'example-p-cudn (VRF)', 'example-p-cudn'],
            ['cudn', 'machinenet (CUDN)', 'machinenet'],
            ['attachment', 'machinenet (NAD)', 'machinenet']
        ])('%s', (_kind, nodeTitle, expectedTitle) => {
            renderPrimary();
            clickNode(nodeTitle);
            expect(drawerTitle()).toBe(expectedTitle);
            expectEveryTabRenders(nodeTitle);
        });

        it('interface (ovs-interface), which lives in the hidden lane', () => {
            renderPrimary();
            toggle('show-hidden-columns-toggle');
            clickNode('br-ex (ovs-interface)');
            expect(drawerTitle()).toBe('br-ex');
            expectEveryTabRenders('br-ex (ovs-interface)');
        });

        it('lldp-neighbor', () => {
            renderBonded();
            toggle('show-lldp-neighbors-toggle');
            clickNode('lab-fabric-lf001 (LLDP)');
            expect(drawerTitle()).toBe('lab-fabric-lf001');
            expectEveryTabRenders('lab-fabric-lf001 (LLDP)');
        });
    });

    describe('load-bearing values reach the panel', () => {
        it('shows every address on the interface holding the node IP', () => {
            // Regression for the prefix-length bug: this panel read only the
            // underscored spelling and rendered "192.0.2.72/undefined", and it
            // showed only the first of two addresses.
            renderPrimary();
            toggle('show-hidden-columns-toggle');
            clickNode('br-ex (ovs-interface)');
            selectTab('Details');

            expect(panelText()).toContain('192.0.2.72/24');
            expect(panelText()).toContain('169.254.0.2/17');
            expect(panelText()).not.toContain('undefined');
        });

        it('shows the VRF route table, its routes and its br-int port', () => {
            renderPrimary();
            clickNode('example-p-cudn (VRF)');
            selectTab('Details');
            const text = panelText();

            expect(text).toContain('5775');
            expect(text).toContain('0.0.0.0/0');
            expect(text).toContain('ovn-k8s-mp3');
            expect(text).toContain('10.1.2.2/24');
        });

        it('shows CUDN topology, role and subnets', () => {
            renderPrimary();
            clickNode('example-p-cudn (CUDN)');
            selectTab('Details');
            const text = panelText();

            expect(text).toContain('Layer2');
            expect(text).toContain('Primary');
            expect(text).toContain('10.1.2.0/24');
        });

        it('shows which CUDNs reference a bridge mapping', () => {
            renderPrimary();
            clickNode('physnet (OVN Bridge Mapping)');
            selectTab('Details');
            const text = panelText();

            expect(text).toContain('br-ex');
            expect(text).toContain('machinenet');
        });

        it('shows the namespaces behind an attachment', () => {
            renderPrimary();
            clickNode('example-p-cudn (NAD)');
            selectTab('Details');

            expect(panelText()).toContain('demo-vm-primary-udn');
        });

        it('shows the LLDP neighbour identity', () => {
            renderBonded();
            toggle('show-lldp-neighbors-toggle');
            clickNode('lab-fabric-lf001 (LLDP)');
            selectTab('Details');
            const text = panelText();

            expect(text).toContain('lab-fabric-lf001');
            expect(text).toContain('Eth1/22');
            expect(text).toContain('topology/pod-1/node-101');
        });

        it('lists bridge ports on a bridge', () => {
            renderPrimary();
            clickNode('br-vmdata (ovs-bridge)');
            selectTab('Details');
            const text = panelText();

            expect(text).toContain('ens224');
            expect(text).toContain('ovs-vlan-1920');
        });
    });

    describe('selection behaviour', () => {
        it('dims unrelated nodes while a node is selected, and restores them on close', () => {
            renderPrimary();
            const dimmed = () => nodeGroups().filter((g) => g.getAttribute('style')?.includes('0.3')).length;

            expect(dimmed()).toBe(0);
            clickNode('example-p-cudn (VRF)');
            expect(dimmed()).toBeGreaterThan(0);

            const close = container.querySelector<HTMLButtonElement>('button[aria-label*="lose"]');
            expect(close).not.toBeNull();
            act(() => { close!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

            expect(drawerTitle()).toBe('');
            expect(dimmed()).toBe(0);
        });

        it('switches selection between nodes without losing the drawer', () => {
            renderPrimary();
            clickNode('ens192 (ethernet)');
            expect(drawerTitle()).toBe('ens192');

            clickNode('example-p-cudn (VRF)');
            expect(drawerTitle()).toBe('example-p-cudn');
            expect(panelText()).toContain('VRF');
        });
    });

    /**
     * Not covered, for want of fixtures rather than for want of interest:
     * the `udn` and `nad` node kinds. Recorded on ovn-recon-s3t.23.
     */
    it('records that two node kinds have no fixture coverage', () => {
        renderPrimary();
        toggle('show-hidden-columns-toggle');
        const titles = nodeGroups().map((g) => g.querySelector('title')?.textContent ?? '');

        expect(titles.some((t) => t.includes('(UDN'))).toBe(false);
        // With no NADs supplied, every "(NAD)" node is an attachment, not a nad.
        expect(titles.filter((t) => t.endsWith('(NAD)')).length).toBeGreaterThan(0);
    });
});
