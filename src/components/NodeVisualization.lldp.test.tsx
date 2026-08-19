import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import * as yaml from 'js-yaml';

import { NodeNetworkState } from '../types';
import NodeVisualization from './NodeVisualization';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    useK8sWatchResource: () => [[]]
}));

const loadFixture = (name: string): NodeNetworkState => {
    const fixturePath = path.join(process.cwd(), 'test', 'fixtures', 'nns', `${name}.json`);
    const fixtureContent = fs.readFileSync(fixturePath, 'utf-8');
    try {
        return JSON.parse(fixtureContent) as NodeNetworkState;
    } catch {
        return yaml.load(fixtureContent) as NodeNetworkState;
    }
};

describe('NodeVisualization LLDP', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => {
            root.unmount();
        });
        container.remove();
    });

    it('renders and toggles LLDP column without crashing', () => {
        const nns = loadFixture('host-lldp');

        act(() => {
            root.render(
                <NodeVisualization nns={nns} cudns={[]} udns={[]} nads={[]} routeAdvertisements={[]} />
            );
        });

        const lldpToggle = container.querySelector<HTMLInputElement>('#show-lldp-neighbors-toggle');
        expect(lldpToggle).not.toBeNull();
        expect(lldpToggle?.checked).toBe(false);

        act(() => {
            lldpToggle!.click();
        });

        const columnHeaders = Array.from(container.querySelectorAll('text')).map((node) => node.textContent);
        expect(columnHeaders).toContain('LLDP Neighbors');
    });
});
