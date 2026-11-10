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
