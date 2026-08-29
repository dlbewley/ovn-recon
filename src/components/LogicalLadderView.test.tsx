import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { LogicalDatabase, LogicalTopologySnapshot } from '../types';
import { buildLadderModel } from './logicalLadderModel';
import LogicalLadderView, { networkDisplayName } from './LogicalLadderView';

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
});
