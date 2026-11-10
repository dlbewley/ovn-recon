import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import RuleTable, { RuleColumn } from './RuleTable';

jest.mock('react-router', () => ({
    Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={String(to)}>{children}</a>,
}));

interface Item {
    id: string;
    n: number;
}

const items = (count: number, label = 'r'): Item[] =>
    Array.from({ length: count }, (_, index) => ({ id: `${label}${index}`, n: index }));

const columns: RuleColumn<Item>[] = [
    { key: 'id', title: 'Id', cell: (item) => item.id },
    { key: 'n', title: 'N', cell: (item) => item.n, sortValue: (item) => item.n },
];

describe('RuleTable paging (optional pageSize)', () => {
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

    const render = (rows: Item[], pageSize?: number) =>
        act(() => {
            root.render(<RuleTable ariaLabel="Items" columns={columns} rows={rows} rowKey={(item) => item.id} pageSize={pageSize} />);
        });
    const shown = () => [...container.querySelectorAll('tr[data-testid^="rule-row-"]')].map((row) => row.textContent);
    const click = (element: Element | null | undefined) => {
        expect(element).toBeTruthy();
        act(() => {
            element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    };
    const nextPage = () => click(container.querySelector('button[aria-label="Go to next page"]'));

    it('renders every row and no pager without pageSize, or when the rows fit', () => {
        render(items(30));
        expect(shown()).toHaveLength(30);
        expect(container.querySelector('[data-testid="rule-table-pager"]')).toBeNull();

        render(items(10), 10);
        expect(shown()).toHaveLength(10);
        expect(container.querySelector('[data-testid="rule-table-pager"]')).toBeNull();
    });

    it('pages rows after sorting all of them', () => {
        render(items(25), 10);
        expect(container.querySelector('[data-testid="rule-table-pager"]')).not.toBeNull();
        expect(shown()).toHaveLength(10);
        expect(shown()[0]).toBe('r00');

        // Descending sort over all 25 rows, not just the visible page.
        const header = [...container.querySelectorAll('th button')].find((button) => button.textContent === 'N');
        click(header);
        click(header);
        expect(shown()[0]).toBe('r2424');

        nextPage();
        nextPage();
        expect(shown()).toHaveLength(5);
        expect(shown()[4]).toBe('r00');
    });

    it('returns to the first page for a different row set, and stays put for the same rows rebuilt', () => {
        render(items(25), 10);
        nextPage();
        expect(shown()[0]).toBe('r1010');

        // Same keys, new array (fresher data): the page holds.
        render(items(25), 10);
        expect(shown()[0]).toBe('r1010');

        // A filter changed the set: back to page one.
        render(items(25).filter((item) => item.n % 2 === 0), 10);
        expect(shown()[0]).toBe('r00');
    });
});

describe('RuleTable page options (filter, facets, focus)', () => {
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

    const shown = () => [...container.querySelectorAll('tr[data-testid^="rule-row-"]')].map((row) => row.textContent);
    const setValue = (element: HTMLInputElement | HTMLSelectElement, value: string) =>
        act(() => {
            const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
            element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
        });
    const parity = (item: Item) => (item.n % 2 === 0 ? 'even' : 'odd');

    const render = (props: Partial<React.ComponentProps<typeof RuleTable<Item>>> = {}, rows = items(12)) =>
        act(() => {
            root.render(
                <RuleTable<Item>
                    ariaLabel="Items"
                    columns={columns}
                    rows={rows}
                    rowKey={(item) => item.id}
                    filter={{
                        ariaLabel: 'Filter items',
                        placeholder: (total) => `Filter ${total} items`,
                        matches: (item, query) => item.id.includes(query),
                    }}
                    facets={[{ key: 'parity', ariaLabel: 'Parity', allLabel: (total) => `All (${total})`, valueOf: parity }]}
                    summary={({ shown: count, total }) => <span data-testid="counts">{count} of {total}</span>}
                    emptyMessage={{ none: 'Nothing here.', noMatch: 'Nothing matches.' }}
                    expandedContent={(item) => <span data-testid={`detail-${item.id}`}>detail {item.id}</span>}
                    {...props}
                />,
            );
        });

    it('filters by text and by facet, and counts what is left', () => {
        render();
        const input = container.querySelector<HTMLInputElement>('input[aria-label="Filter items"]')!;
        expect(input.getAttribute('placeholder')).toBe('Filter 12 items');
        const select = container.querySelector<HTMLSelectElement>('select[aria-label="Parity"]')!;
        expect([...select.options].map((option) => option.textContent)).toEqual(['All (12)', 'even (6)', 'odd (6)']);

        setValue(select, 'odd');
        expect(shown()).toHaveLength(6);
        setValue(input, 'r1');
        // r1, r11 are odd; r10 is even.
        expect(shown().map((text) => text?.slice(0, 3))).toEqual(['r11', 'r11']);
        expect(container.querySelector('[data-testid="counts"]')?.textContent).toBe('2 of 12');

        setValue(input, 'zzz');
        expect(container.textContent).toContain('Nothing matches.');

        render({}, []);
        expect(container.textContent).toContain('Nothing here.');
    });

    it('takes a controlled filter value and reports changes', () => {
        const onChange = jest.fn();
        render({
            filter: { ariaLabel: 'Filter items', placeholder: 'Filter', matches: (item, query) => item.id === query, value: 'r3', onChange },
        });
        expect(shown()).toHaveLength(1);
        setValue(container.querySelector<HTMLInputElement>('input[aria-label="Filter items"]')!, 'r4');
        expect(onChange).toHaveBeenCalledWith('r4');
        // Still controlled: the parent has not changed the value.
        expect(shown()[0]?.startsWith('r33')).toBe(true);
    });

    it('expands and turns to a focused row, once, and reports toggles', () => {
        const onToggleRow = jest.fn();
        const scroll = jest.fn();
        Element.prototype.scrollIntoView = scroll;
        render({ pageSize: 5, perPageOptions: [5, 10], focusKey: 'r7', onToggleRow }, items(12));
        expect(container.querySelector('[data-testid="detail-r7"]')).not.toBeNull();
        expect(shown()[0]?.startsWith('r55')).toBe(true);
        expect(scroll).toHaveBeenCalledTimes(1);

        // Collapsing it is the user's call and stays done.
        const row = [...container.querySelectorAll('tr[data-testid="rule-row-r7"]')][0];
        act(() => row.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        expect(onToggleRow).toHaveBeenCalledWith('r7', false);
        render({ pageSize: 5, perPageOptions: [5, 10], focusKey: 'r7', onToggleRow }, items(12));
        expect(container.querySelector('[data-testid="detail-r7"]')).toBeNull();
        expect(scroll).toHaveBeenCalledTimes(1);
    });
});
