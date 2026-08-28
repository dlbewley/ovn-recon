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
 * A structural snapshot of the whole rendered graph: every node with its lane
 * position and label, every connector endpoint, and the drawer content for each
 * node kind.
 *
 * Its first job was to prove that ovn-recon-s3t.5 -- lifting the model out of the
 * component body -- changed nothing. It keeps that job for every later refactor:
 * the point of these is that the picture stays the same while the code moves.
 *
 * When the snapshot legitimately changes, review the diff line by line. A refactor
 * that alters it is either wrong or is not a refactor.
 */
const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

describe('NodeVisualization rendered structure', () => {
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

    const nodeGroups = () =>
        Array.from(container.querySelectorAll('g'))
            .filter((g) => Array.from(g.children).some((c) => c.tagName.toLowerCase() === 'rect'));

    const describeGraph = () => {
        const nodes = nodeGroups().map((g) => {
            const m = /translate\((-?[\d.]+),\s*(-?[\d.]+)\)/.exec(g.getAttribute('transform') ?? '');
            const texts = Array.from(g.querySelectorAll('text')).map((t) => t.textContent);
            return {
                title: g.querySelector('title')?.textContent ?? '',
                x: m ? Number(m[1]) : null,
                y: m ? Number(m[2]) : null,
                fill: g.querySelector('rect')?.getAttribute('fill') ?? '',
                labels: texts
            };
        }).sort((a, b) => `${a.x},${a.y},${a.title}`.localeCompare(`${b.x},${b.y},${b.title}`));

        // Endpoints AND appearance: a reference edge is dashed, and that distinction is
        // the whole point of ovn-recon-s3t.25, so the baseline has to be able to see it.
        const edges = [
            ...Array.from(container.querySelectorAll('line'))
                .map((l) => [
                    `${l.getAttribute('x1')},${l.getAttribute('y1')} -> ${l.getAttribute('x2')},${l.getAttribute('y2')}`,
                    l.getAttribute('stroke-dasharray') ? 'dashed' : 'solid',
                    l.querySelector('title')?.textContent ?? ''
                ].join('  ')),
            // Same-lane edges draw as arcs; the path carries the whole geometry.
            ...Array.from(container.querySelectorAll('path[d^="M "]'))
                .map((p) => [
                    `arc ${p.getAttribute('d')}`,
                    p.getAttribute('stroke-dasharray') ? 'dashed' : 'solid',
                    p.querySelector('title')?.textContent ?? ''
                ].join('  '))
        ].sort();

        const laneHeaders = Array.from(container.querySelectorAll('svg > text')).map((t) => t.textContent);

        return { nodes, edges, laneHeaders };
    };

    const drawerFor = (title: string) => {
        const group = nodeGroups().find((g) => g.querySelector('title')?.textContent === title)!;
        act(() => { group.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        const tabs: Record<string, string> = {};
        ['Overview', 'Relationships'].forEach((tab) => {
            const button = Array.from(container.querySelectorAll('button'))
                .find((b) => (b.textContent ?? '').trim() === tab)!;
            act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
            tabs[tab] = (container.querySelector('.pf-v6-c-drawer__panel')?.textContent ?? '').trim();
        });
        return tabs;
    };

    it('primary-cudn-vrf, default view', () => {
        act(() => {
            root.render(<NodeVisualization
                nns={fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json')}
                cudns={fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json')}
                udns={[]} nads={[]} routeAdvertisements={[]} />);
        });
        expect(describeGraph()).toMatchSnapshot();
    });

    it('primary-cudn-vrf, all lanes revealed', () => {
        act(() => {
            root.render(<NodeVisualization
                nns={fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json')}
                cudns={fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json')}
                udns={[]} nads={[]} routeAdvertisements={[]} />);
        });
        act(() => container.querySelector<HTMLInputElement>('#show-hidden-columns-toggle')!.click());
        expect(describeGraph()).toMatchSnapshot();
    });

    it('bonded-lldp, with neighbours shown', () => {
        act(() => {
            root.render(<NodeVisualization
                nns={fixture<NodeNetworkState>('nns', 'bonded-lldp.json')}
                cudns={[]} udns={[]} nads={[]} routeAdvertisements={[]} />);
        });
        act(() => container.querySelector<HTMLInputElement>('#show-lldp-neighbors-toggle')!.click());
        expect(describeGraph()).toMatchSnapshot();
    });

    it.each([
        ['ens192 (ethernet)'],
        ['br-ex (ovs-bridge)'],
        ['physnet (OVN Bridge Mapping)'],
        ['example-p-cudn (VRF)'],
        ['machinenet (CUDN)'],
        ['machinenet (NAD)']
    ])('drawer content for %s', (title) => {
        act(() => {
            root.render(<NodeVisualization
                nns={fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json')}
                cudns={fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json')}
                udns={[]} nads={[]} routeAdvertisements={[]} />);
        });
        expect(drawerFor(title)).toMatchSnapshot();
    });
});
