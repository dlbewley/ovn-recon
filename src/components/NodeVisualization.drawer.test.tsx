import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { ClusterUserDefinedNetwork, NodeNetworkConfigurationEnactment, NodeNetworkState } from '../types';
import * as viewModel from '../topology/viewModel';
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

const TABS = ['Overview', 'Relationships', 'Config'] as const;

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
            // An explicit empty state ("No relationships derived...") is content; a blank
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
            selectTab('Overview');

            expect(panelText()).toContain('192.0.2.72/24');
            expect(panelText()).toContain('169.254.0.2/17');
            expect(panelText()).not.toContain('undefined');
        });

        it('shows the VRF route table, its routes and its br-int port', () => {
            renderPrimary();
            clickNode('example-p-cudn (VRF)');
            selectTab('Overview');
            const text = panelText();

            expect(text).toContain('5775');
            expect(text).toContain('0.0.0.0/0');
            expect(text).toContain('ovn-k8s-mp3');
            expect(text).toContain('10.1.2.2/24');
        });

        it('shows CUDN topology, role and subnets', () => {
            renderPrimary();
            clickNode('example-p-cudn (CUDN)');
            selectTab('Overview');
            const text = panelText();

            expect(text).toContain('Layer2');
            expect(text).toContain('Primary');
            expect(text).toContain('10.1.2.0/24');
        });

        it('shows which CUDNs reference a bridge mapping', () => {
            renderPrimary();
            clickNode('physnet (OVN Bridge Mapping)');
            selectTab('Overview');
            const text = panelText();

            expect(text).toContain('br-ex');
            expect(text).toContain('machinenet');
        });

        it('shows the namespaces behind an attachment', () => {
            renderPrimary();
            clickNode('example-p-cudn (NAD)');
            selectTab('Overview');

            expect(panelText()).toContain('demo-vm-primary-udn');
        });

        it('shows the LLDP neighbour identity', () => {
            renderBonded();
            toggle('show-lldp-neighbors-toggle');
            clickNode('lab-fabric-lf001 (LLDP)');
            selectTab('Overview');
            const text = panelText();

            expect(text).toContain('lab-fabric-lf001');
            expect(text).toContain('Eth1/22');
            expect(text).toContain('topology/pod-1/node-101');
        });

        it('shows which NNCP configured a claimed interface, linked to the policy', () => {
            act(() => {
                root.render(
                    <NodeVisualization
                        nns={fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json')}
                        cudns={fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json')}
                        udns={[]} nads={[]} routeAdvertisements={[]}
                        enactments={fixture<NodeNetworkConfigurationEnactment[]>('nnce', 'primary-cudn-vrf.json')}
                    />
                );
            });
            clickNode('ens224.456 (vlan)');

            expect(panelText()).toContain('Configured By');
            const panel = container.querySelector('.pf-v6-c-drawer__panel')!;
            const link = Array.from(panel.querySelectorAll('a'))
                .find((a) => a.textContent === 'storage-vlan');
            expect(link?.getAttribute('href'))
                .toBe('/k8s/cluster/nmstate.io~v1~NodeNetworkConfigurationPolicy/storage-vlan');

            // Unclaimed resources say who DID create them.
            clickNode('ens192 (ethernet)');
            expect(panelText()).toContain('installer or OVN-Kubernetes');
        });

        it('lists bridge ports on a bridge', () => {
            renderPrimary();
            clickNode('br-vmdata (ovs-bridge)');
            selectTab('Overview');
            const text = panelText();

            expect(text).toContain('ens224');
            expect(text).toContain('ovs-vlan-1920');
        });
    });

    it('shows an icon in the drawer header, matching the one on the node', () => {
        // Regression: the drawer looked its icon up by a type string that changed
        // meaning when descriptors landed, so every interface silently fell back to the
        // default icon. Nothing covered it, which is why it nearly shipped.
        renderPrimary();
        clickNode('ens192 (ethernet)');

        const panel = container.querySelector('.pf-v6-c-drawer__panel')!;
        const headerIcon = panel.querySelector('svg');
        expect(headerIcon).not.toBeNull();

        // The node on the canvas draws the same icon.
        const nodeIcon = nodeGroups()
            .find((g) => g.querySelector('title')?.textContent === 'ens192 (ethernet)')!
            .querySelector('svg');
        expect(headerIcon!.innerHTML).toBe(nodeIcon!.innerHTML);
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

        it('navigates to a neighbor from the Relationships tab', () => {
            renderPrimary();
            clickNode('ens192 (ethernet)');
            selectTab('Relationships');

            const panel = container.querySelector('.pf-v6-c-drawer__panel')!;
            const neighbor = Array.from(panel.querySelectorAll('button'))
                .find((b) => (b.textContent ?? '').trim() === 'br-ex');
            expect(neighbor).toBeDefined();
            act(() => { neighbor!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

            // Selection moved, the tab was kept, and the neighbor's own
            // relationships now list where we came from.
            expect(drawerTitle()).toBe('br-ex');
            expect(panelText()).toContain('Upstream');
            expect(panelText()).toContain('ens192');

            // The flow path re-highlighted around the new selection.
            expect(nodeGroups().filter((g) => g.getAttribute('style')?.includes('0.3')).length)
                .toBeGreaterThan(0);
        });

        it('centers the view on a node reached via Relationships, but not on canvas clicks', () => {
            renderPrimary();
            // The canvas svg is the one drawing node rects; every other svg in the
            // document is an icon.
            const svg = () => Array.from(container.querySelectorAll('svg'))
                .find((s) => s.querySelector('rect'))!;

            clickNode('ens192 (ethernet)');
            const beforeNavigation = svg().getAttribute('viewBox');

            selectTab('Relationships');
            const panel = container.querySelector('.pf-v6-c-drawer__panel')!;
            const neighbor = Array.from(panel.querySelectorAll('button'))
                .find((b) => (b.textContent ?? '').trim() === 'br-ex')!;
            act(() => { neighbor.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

            // The view panned so the target node sits at the center, zoom kept.
            const target = nodeGroups()
                .find((g) => g.querySelector('title')?.textContent === 'br-ex (ovs-bridge)')!;
            const [, nodeX, nodeY] = target.getAttribute('transform')!
                .match(/translate\(([\d.-]+), ([\d.-]+)\)/)!.map(Number);
            const [viewX, viewY, viewWidth, viewHeight] = svg().getAttribute('viewBox')!
                .split(' ').map(Number);
            expect(viewX + viewWidth / 2).toBeCloseTo(nodeX + 80, 0);   // itemWidth / 2
            expect(viewY + viewHeight / 2).toBeCloseTo(nodeY + 40, 0);  // itemHeight / 2
            expect(`${viewWidth} ${viewHeight}`)
                .toBe(beforeNavigation!.split(' ').slice(2).join(' '));

            // A canvas click selects without yanking the view.
            const panned = svg().getAttribute('viewBox');
            clickNode('ens192 (ethernet)');
            expect(svg().getAttribute('viewBox')).toBe(panned);
        });

        it('shows an explicit empty state when no relationships are derived', () => {
            renderPrimary();
            clickNode('lo (loopback)');
            selectTab('Relationships');
            expect(panelText()).toContain('No relationships derived');
        });
    });

    /**
     * Keyboard accessibility and canvas interaction (ovn-recon-s3t.17).
     */
    describe('keyboard and canvas interaction', () => {
        const canvasSvg = () => Array.from(container.querySelectorAll('svg'))
            .find((s) => s.querySelector('rect'))!;

        it('makes every node reachable and activatable by keyboard', () => {
            renderPrimary();
            const node = nodeGroups().find((g) => g.getAttribute('aria-label') === 'ens192 (ethernet)')!;
            expect(node.getAttribute('role')).toBe('button');
            expect(node.getAttribute('tabindex')).toBe('0');

            act(() => {
                node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            });
            expect(drawerTitle()).toBe('ens192');

            const other = nodeGroups().find((g) => g.getAttribute('aria-label') === 'br-ex (ovs-bridge)')!;
            act(() => {
                other.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
            });
            expect(drawerTitle()).toBe('br-ex');
        });

        it('keeps a focused node fully visible through highlight dimming', () => {
            renderPrimary();
            clickNode('example-p-cudn (VRF)'); // dims unrelated nodes to 0.3

            const dimmedNode = nodeGroups().find((g) =>
                g.getAttribute('aria-label') === 'lldp' || g.getAttribute('style')?.includes('0.3'))!;
            // React delegates focus via focusin.
            act(() => { dimmedNode.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });

            expect(dimmedNode.getAttribute('style')).not.toContain('0.3');
            // The focus ring is drawn on the rect.
            expect(dimmedNode.querySelector('rect')?.getAttribute('stroke-width')).toBe('3');
        });

        it('does not close the drawer when a pan drag ends over the background', () => {
            renderPrimary();
            clickNode('ens192 (ethernet)');
            expect(drawerTitle()).toBe('ens192');

            const svg = canvasSvg();
            // One act per event: the pan flag depends on isPanning state set by
            // the previous event, so each must flush before the next fires.
            act(() => { svg.dispatchEvent(new MouseEvent('mousedown', { button: 0, shiftKey: true, clientX: 100, clientY: 100, bubbles: true })); });
            act(() => { svg.dispatchEvent(new MouseEvent('mousemove', { clientX: 160, clientY: 140, bubbles: true })); });
            act(() => { svg.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
            act(() => { svg.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
            expect(drawerTitle()).toBe('ens192');

            // A plain background click still deselects.
            act(() => { svg.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
            expect(drawerTitle()).toBe('');
        });

        it('grows the viewBox with the canvas until the user adjusts the view', () => {
            renderBonded();
            const before = canvasSvg().getAttribute('viewBox')!;
            toggle('show-lldp-neighbors-toggle');
            const after = canvasSvg().getAttribute('viewBox')!;
            // The LLDP lane fans neighbors downward, growing the canvas; the
            // default view must follow rather than clipping the new content.
            expect(Number(after.split(' ')[3])).toBeGreaterThanOrEqual(Number(before.split(' ')[3]));
            expect(after.split(' ').slice(0, 2)).toEqual(['0', '0']);
        });
    });

    /**
     * Wording and link corrections reported from the live console
     * (ovn-recon-s3t.37, ovn-recon-s3t.38).
     */
    describe('content corrections', () => {
        it('labels the bridge mapping summary with Bridge, not State -- a mapping is never up or down', () => {
            renderPrimary();
            clickNode('physnet (OVN Bridge Mapping)');
            selectTab('Overview');
            const text = panelText();

            expect(text).toContain('Bridge');
            expect(text).toContain('br-ex');
            expect(text).not.toContain('State');
        });

        it('describes a kernel VLAN interface without the OVN term Localnet', () => {
            renderPrimary();
            clickNode('ens224.456 (vlan)');
            selectTab('Overview');
            const text = panelText();

            expect(text).toContain('VLAN');
            expect(text).toContain('ens224');
            expect(text).not.toContain('Localnet');
        });

        it('links namespaces to the OpenShift Projects URL, never to a bare /k8s/ns path', () => {
            renderPrimary();
            clickNode('machinenet (NAD)');
            selectTab('Overview');

            const panel = container.querySelector('.pf-v6-c-drawer__panel')!;
            const hrefs = Array.from(panel.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');

            expect(hrefs.some((href) => href.startsWith('/k8s/cluster/projects/'))).toBe(true);
            // A bare namespace path (no resource segment after it) is not a valid
            // console destination on OpenShift.
            expect(hrefs.filter((href) => /^\/k8s\/ns\/[^/]+$/.test(href))).toEqual([]);
        });
    });

    /**
     * The drawer derives its content from the CURRENT watch data (ovn-recon-s3t.4).
     * It used to store the view model snapshotted at click time, so a resource edit
     * never reached an open drawer.
     */
    describe('live derivation', () => {
        it('updates an open drawer when the watched resource changes, without reselecting', () => {
            const nns = fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json');
            const cudns = fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json');
            const renderWith = (state: NodeNetworkState) => act(() => {
                root.render(
                    <NodeVisualization nns={state} cudns={cudns} udns={[]} nads={[]} routeAdvertisements={[]} />
                );
            });

            renderWith(nns);
            clickNode('ens192 (ethernet)');
            selectTab('Overview');
            expect(panelText()).toContain('1500');

            const updated = JSON.parse(JSON.stringify(nns)) as NodeNetworkState;
            const iface = updated.status!.currentState!.interfaces!.find((i) => i.name === 'ens192')!;
            iface.mtu = 9000;
            renderWith(updated);

            expect(drawerTitle()).toBe('ens192');
            expect(panelText()).toContain('9000');
            expect(panelText()).not.toContain('1500');
        });

        it('builds the full view model only for the selected node, never during graph render', () => {
            const spy = jest.spyOn(viewModel, 'buildNodeViewModel');
            renderPrimary();
            expect(spy).not.toHaveBeenCalled();

            clickNode('ens192 (ethernet)');
            expect(spy.mock.calls.length).toBeGreaterThan(0);
            // Every call is for the one selected item.
            expect(new Set(spy.mock.calls.map((call) => call[0])).size).toBe(1);
            spy.mockRestore();
        });

        it('clears the selection when the selected node stops being rendered', () => {
            renderPrimary();
            toggle('show-hidden-columns-toggle');
            clickNode('br-ex (ovs-interface)');
            expect(drawerTitle()).toBe('br-ex');

            // Hiding the lane removes the node; the drawer must close and the
            // graph must not stay dimmed against a selection that no longer exists.
            toggle('show-hidden-columns-toggle');
            expect(drawerTitle()).toBe('');
            expect(nodeGroups().filter((g) => g.getAttribute('style')?.includes('0.3')).length).toBe(0);
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
