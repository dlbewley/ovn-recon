import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

import ViewToolbar, { ViewToolbarProps } from './ViewToolbar';
import { hasViewOption, toggleViewOption, toolbarButton, viewOptionInput } from './viewToolbarTestUtils';

jest.mock('@patternfly/react-code-editor', () => ({
    CodeEditor: ({ code }: { code: string }) => <pre data-testid="json-code">{code}</pre>,
    Language: { json: 'json' },
}));

/** ovn-recon-nt4.3: one toolbar for the three graph views. */
describe('ViewToolbar', () => {
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

    const calls: string[] = [];
    const base: ViewToolbarProps = {
        label: 'Test view',
        filters: <input aria-label="Filter by network" />,
        zoom: {
            onZoomOut: () => calls.push('out'),
            onZoomIn: () => calls.push('in'),
            onReset: () => calls.push('reset'),
        },
        legend: <span>legend body</span>,
        refresh: { onRefresh: () => calls.push('refresh') },
        json: { label: 'node-1 cached snapshot', filename: 'node-1-snapshot.json', payload: { hello: 'world' } },
        status: <span data-testid="status-line">Fresh</span>,
    };

    /** Holds the option's state the way a body does. */
    const Host: React.FC<Partial<ViewToolbarProps>> = (props) => {
        const [nads, setNads] = React.useState(false);
        return (
            <ViewToolbar
                {...base}
                viewOptions={[{ id: 'show-nads-toggle', label: 'Net Attach Defs', checked: nads, onChange: setNads }]}
                {...props}
            />
        );
    };

    const render = async (props: Partial<ViewToolbarProps> = {}) => {
        await act(async () => {
            root.render(<Host {...props} />);
        });
    };

    it('lays its controls out left to right, which is the keyboard order', async () => {
        await render();
        const toolbar = container.querySelector('[data-testid="view-toolbar"]')!;
        expect(toolbar.getAttribute('aria-label')).toBe('Test view');
        const focusable = Array.from(toolbar.querySelectorAll<HTMLElement>('input, button'))
            .map((element) => element.getAttribute('aria-label') || element.textContent?.trim());
        expect(focusable).toEqual([
            'Filter by network',
            'View options',
            'Zoom out',
            'Zoom in',
            'Reset view',
            'Legend',
            'Refresh now',
            'More actions',
        ]);
        // The status line sits after Legend, right before the refresh it belongs to,
        // in one group at the end.
        const status = toolbar.querySelector('[data-testid="status-line"]')!;
        const legend = Array.from(toolbar.querySelectorAll('button')).find((button) => button.textContent === 'Legend')!;
        const refresh = toolbarButton(container, 'Refresh now')!;
        expect(legend.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(status.compareDocumentPosition(refresh) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        const endGroup = status.closest('.pf-v6-c-toolbar__group');
        expect(endGroup?.contains(refresh)).toBe(true);
        expect(endGroup?.contains(toolbarButton(container, 'More actions'))).toBe(true);
    });

    it('calls the zoom and refresh handlers', async () => {
        calls.length = 0;
        await render();
        ['Zoom out', 'Zoom in', 'Reset view', 'Refresh now'].forEach((label) => {
            act(() => toolbarButton(container, label)!.click());
        });
        expect(calls).toEqual(['out', 'in', 'reset', 'refresh']);
    });

    it('disables refresh while loading', async () => {
        await render({ refresh: { onRefresh: () => undefined, isLoading: true } });
        expect(toolbarButton(container, 'Refresh now')!.disabled).toBe(true);
    });

    it('flips a display toggle from the View options menu and counts what is on', async () => {
        await render();
        const toggle = container.querySelector('[data-testid="view-options-toggle"]')!;
        expect(viewOptionInput(container, 'show-nads-toggle')!.checked).toBe(false);
        toggleViewOption(container, 'show-nads-toggle');
        expect(viewOptionInput(container, 'show-nads-toggle')!.checked).toBe(true);
        expect(toggle.textContent).toContain('1');
        toggleViewOption(container, 'show-nads-toggle');
        expect(viewOptionInput(container, 'show-nads-toggle')!.checked).toBe(false);
    });

    it('leaves out the menu, refresh and more actions when a view has none', async () => {
        await render({ viewOptions: [], refresh: undefined, json: undefined, status: undefined });
        expect(container.querySelector('[data-testid="view-options-toggle"]')).toBeNull();
        expect(hasViewOption(container, 'show-nads-toggle')).toBe(false);
        expect(toolbarButton(container, 'Refresh now')).toBeNull();
        expect(toolbarButton(container, 'More actions')).toBeNull();
    });

    it('opens the raw JSON from the overflow menu', async () => {
        await render();
        act(() => toolbarButton(container, 'More actions')!.click());
        const item = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
            .find((button) => button.textContent === 'View JSON');
        expect(item).toBeDefined();
        await act(async () => item!.click());
        expect(document.querySelector('[data-testid="json-code"]')?.textContent).toContain('"hello": "world"');
        expect(document.body.textContent).toContain('Download node-1-snapshot.json');

        // Closing it returns focus to the menu's toggle, not the page.
        jest.useFakeTimers();
        const close = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
            .find((button) => button.textContent === 'Close')!;
        act(() => close.click());
        act(() => jest.runOnlyPendingTimers());
        jest.useRealTimers();
        expect(document.activeElement).toBe(toolbarButton(container, 'More actions'));
    });

    it('is the toolbar of all three graph views', () => {
        // Each body draws its controls through ViewToolbar, not a row of its own.
        ['NodeVisualization.tsx', 'NodeLogicalTopologyDetails.tsx', 'ClusterLogicalTopologyDetails.tsx'].forEach((file) => {
            const source = fs.readFileSync(path.join(__dirname, file), 'utf-8');
            expect(source).toContain('<ViewToolbar');
            expect(source).not.toMatch(/>\s*Reset view\s*</);
            expect(source).not.toMatch(/>\s*Refresh now\s*</);
            expect(source).not.toContain('SnapshotJsonModal');
        });
    });
});
