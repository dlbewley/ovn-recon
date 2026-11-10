import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { LogicalDatabase, LogicalTopologySnapshot } from '../types';
import { buildLadderModel } from './logicalLadderModel';
import LogicalLadderView, {
    constructMatches,
    ladderSearchMatches,
    networkDisplayName,
} from './LogicalLadderView';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';

const database = (cnv1 as unknown as LogicalTopologySnapshot).database as LogicalDatabase;

describe('LogicalLadderView', () => {
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

    const render = (props: Partial<React.ComponentProps<typeof LogicalLadderView>> = {}) => {
        const model = buildLadderModel(database);
        act(() => {
            root.render(
                <LogicalLadderView
                    model={model}
                    selectedUuid={null}
                    onSelect={jest.fn()}
                    {...props}
                />,
            );
        });
        return model;
    };

    it('chips CUDN and UDN bands by kind, leaving the default band bare', () => {
        render();
        expect(
            container.querySelector('[data-testid="network-kind-cluster_udn_example-p-cudn"]')?.textContent,
        ).toBe('CUDN');
        expect(
            container.querySelector('[data-testid="network-kind-demo-mirror_example-l3-udn"]')?.textContent,
        ).toBe('UDN');
        expect(container.querySelector('[data-testid="network-kind-default"]')).toBeNull();
    });

    it('renders one labelled band per network', () => {
        const model = render();
        const text = container.textContent ?? '';
        for (const network of model.networks) {
            expect(text).toContain(networkDisplayName(network));
        }
        expect(text).toContain('Default cluster network');
        expect(text).toContain('example-p-cudn');
    });

    it('renders tier labels and construct cards with their stats', () => {
        render();
        const text = container.textContent ?? '';
        expect(text).toContain('Gateway routers');
        expect(text).toContain('Cluster routing');
        expect(container.querySelector('[data-testid="construct-ovn_cluster_router"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="construct-GR_cnv-1"]')).not.toBeNull();
        // The node switch advertises its subnet and pod count.
        expect(text).toContain('10.131.0.0/23');
        expect(text).toMatch(/\d+ pods/);
        // The transit switch advertises its tunnel peers.
        expect(text).toMatch(/⇄ \d+ nodes/);
    });

    it('labels edges with their function and router port addresses', () => {
        render();
        const text = container.textContent ?? '';
        expect(text).toContain('join · 100.64.0.1/16');
        expect(text).toContain('tunnel · 100.88.0.5/16');
        expect(text).toContain('gateway · 10.131.0.1/23');
        // Interconnect legs annotate each address's function.
        expect(text).toContain('interconnect · router 100.65.0.5/16 p2p 100.88.0.11/31 ⇄ p2p 100.88.0.10/31');
    });

    it('wraps a long edge label into lines and keeps the whole label as its title', () => {
        const model = render();
        const interconnect = model.edges.find((edge) => edge.role === 'interconnect');
        expect(interconnect).toBeDefined();
        const label = container.querySelector(`[data-testid="edge-label-${interconnect?.id}"]`);
        expect(label).not.toBeNull();
        const lines = [...(label?.querySelectorAll('tspan') ?? [])].map((line) => line.textContent);
        expect(lines).toEqual(['interconnect · router 100.65.0.5/16', 'p2p 100.88.0.11/31 ⇄ p2p 100.88.0.10/31']);
        expect(label?.querySelector('title')?.textContent).toBe(
            'interconnect · router 100.65.0.5/16 p2p 100.88.0.11/31 ⇄ p2p 100.88.0.10/31',
        );
        // A label that fits stays on one line.
        const short = model.edges.find((edge) => edge.role === 'tunnel');
        expect(
            container.querySelectorAll(`[data-testid="edge-label-${short?.id}"] tspan`),
        ).toHaveLength(1);
    });

    it('shortens long names in the middle and titles the card with the full name', () => {
        render();
        const nameOnCard = (name: string) => {
            const card = container.querySelector(`[data-testid="construct-${name}"]`);
            expect(card).not.toBeNull();
            // The card's accessible title is the whole name...
            expect(card?.firstElementChild?.tagName).toBe('title');
            expect(card?.firstElementChild?.textContent).toBe(name);
            // ...and its first text line is what the card shows.
            return card?.querySelector('text')?.textContent ?? '';
        };
        // A network's Layer 2 switch and its transit router used to read the same.
        const layer2Switch = nameOnCard('cluster_udn_example.p.cudn_ovn_layer2_switch');
        const transitRouter = nameOnCard('cluster_udn_example.p.cudn_transit_router');
        expect(layer2Switch).toBe('cluster_udn_exa…_layer2_switch');
        expect(transitRouter).toBe('cluster_udn_ex…_transit_router');
        // A name that fits is shown as it is.
        expect(nameOnCard('ovn_cluster_router')).toBe('ovn_cluster_router');
    });

    it('reports selection on construct click', () => {
        const onSelect = jest.fn();
        const model = render({ onSelect });
        const card = container.querySelector('[data-testid="construct-GR_cnv-1"]');
        expect(card).not.toBeNull();
        act(() => {
            card?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        const gateway = model.constructs.find((construct) => construct.name === 'GR_cnv-1');
        expect(onSelect).toHaveBeenCalledWith(gateway?.uuid);
    });

    it('narrows to a single band under a network filter', () => {
        render({ networkFilter: 'cluster_udn_machinenet' });
        const text = container.textContent ?? '';
        expect(text).toContain('machinenet');
        expect(text).not.toContain('Default cluster network');
        expect(container.querySelector('[data-testid="construct-ovn_cluster_router"]')).toBeNull();
    });

    it('answers a reveal request with the construct position, once per nonce', () => {
        const model = buildLadderModel(database);
        const target = model.constructs.find((construct) => construct.name === 'ovn_cluster_router');
        expect(target).toBeDefined();
        const onRevealPosition = jest.fn();
        const renderWith = (nonce: number) =>
            act(() => {
                root.render(
                    <LogicalLadderView
                        model={model}
                        selectedUuid={target!.uuid}
                        onSelect={jest.fn()}
                        revealRequest={{ uuid: target!.uuid, nonce }}
                        onRevealPosition={onRevealPosition}
                    />,
                );
            });
        renderWith(1);
        expect(onRevealPosition).toHaveBeenCalledTimes(1);
        const position = onRevealPosition.mock.calls[0][0];
        expect(position.x).toBeGreaterThan(0);
        expect(position.y).toBeGreaterThan(0);
        // Same nonce re-rendered: no second answer (a later layout change
        // must not re-yank the viewport).
        renderWith(1);
        expect(onRevealPosition).toHaveBeenCalledTimes(1);
        // A new nonce for the same uuid answers again.
        renderWith(2);
        expect(onRevealPosition).toHaveBeenCalledTimes(2);
    });
});

/**
 * The search box promised "name, role, node, or subnet" but matched the raw role
 * id, so typing the label drawn on a card ("Node switch") dimmed every construct
 * (ovn-recon-nt4.6).
 */
describe('ladder search matching', () => {
    const model = buildLadderModel(database);
    const byValue = (value: string) =>
        model.constructs.find((construct) => `${construct.kind}:${construct.name}` === value)!;

    it('matches the role label drawn on the card, not only the role id', () => {
        const nodeSwitch = byValue('switch:cnv-1');
        expect(constructMatches(nodeSwitch, 'node switch')).toBe(true);
        expect(constructMatches(nodeSwitch, 'node-switch')).toBe(true);
        expect(constructMatches(byValue('switch:join'), 'node switch')).toBe(false);
        expect(constructMatches(byValue('router:GR_cnv-1'), 'gateway router')).toBe(true);
    });

    it('matches the network display name as well as its OVN identity', () => {
        const udnSwitch = byValue('switch:demo.mirror_example.l3.udn_cnv-1');
        expect(networkDisplayName(udnSwitch.network)).toBe('demo-mirror/example-l3-udn');
        expect(constructMatches(udnSwitch, 'demo-mirror/example')).toBe(true);
        expect(constructMatches(byValue('switch:cnv-1'), 'default cluster network')).toBe(true);
    });

    it('lists matches in reading order under the network filter, and none for an empty query', () => {
        const all = ladderSearchMatches(model, 'all', '  Node Switch ').map((construct) => construct.name);
        expect(all.sort()).toEqual(['cnv-1', 'demo.mirror_example.l3.udn_cnv-1']);
        expect(ladderSearchMatches(model, 'default', 'node switch').map((construct) => construct.name))
            .toEqual(['cnv-1']);
        expect(ladderSearchMatches(model, 'all', '   ')).toEqual([]);

        // Top tier first: routers on the gateway tier come before switches.
        const names = ladderSearchMatches(model, 'default', 'cnv-1').map((construct) => construct.name);
        expect(names.indexOf('GR_cnv-1')).toBeLessThan(names.indexOf('cnv-1'));
    });

    it('stops dimming a construct that matches by its label', () => {
        const container = document.createElement('div');
        const root = createRoot(container);
        act(() => {
            root.render(<LogicalLadderView model={model} selectedUuid={null} onSelect={jest.fn()} search="node switch" />);
        });
        const opacity = (name: string) =>
            container.querySelector(`[data-testid="construct-${name}"]`)!.getAttribute('opacity');
        expect(opacity('cnv-1')).toBe('1');
        expect(opacity('join')).toBe('0.25');
        act(() => root.unmount());
    });
});
