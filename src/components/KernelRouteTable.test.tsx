import fs from 'fs';
import path from 'path';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { NodeNetworkState } from '../types';
import KernelRouteTable from './KernelRouteTable';
import { MAIN_TABLE_ID } from './kernelRoutes';
import { getRunningRoutes, NnsRoute } from './nodeVisualizationSelectors';

jest.mock('react-router', () => ({
    Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={String(to)}>{children}</a>,
}));

const loadNns = (name: string): NodeNetworkState =>
    JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'nns', `${name}.json`), 'utf-8'),
    ) as NodeNetworkState;

const allRoutes = getRunningRoutes(loadNns('kernel-routes'));
const mainRoutes = allRoutes.filter((route) => route.tableId === MAIN_TABLE_ID);

describe('KernelRouteTable', () => {
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

    const render = (element: React.ReactElement) => act(() => root.render(element));
    const headers = (table: Element = container) =>
        Array.from(table.querySelectorAll('thead th')).map((th) => (th.textContent ?? '').trim());
    const bodyRows = () => Array.from(container.querySelectorAll('tbody tr'));
    const cellText = (row: Element, column: string) =>
        (row.querySelector(`td[data-label="${column}"]`)?.textContent ?? '').trim();
    const rowFor = (destination: string, metric?: number) => {
        const row = bodyRows().find(
            (candidate) =>
                cellText(candidate, 'Destination').startsWith(destination) &&
                (metric === undefined || cellText(candidate, 'Metric') === String(metric)),
        );
        if (!row) throw new Error(`no row for ${destination} ${metric ?? ''}`);
        return row;
    };

    it('renders the main table in reading order with a summary', () => {
        render(<KernelRouteTable routes={mainRoutes} />);
        expect(container.querySelector('[data-testid="kernel-route-summary"]')?.textContent)
            .toBe('Table 254 (main) · 10 routes · 3 default · 1 ECMP');
        expect(headers()).toEqual(['Destination', 'Gateway', 'Interface', 'Metric', 'Source', 'MTU']);
        expect(bodyRows().map((row) => cellText(row, 'Destination').split(' ')[0]))
            .toEqual([
                '0.0.0.0/0', '0.0.0.0/0', '::/0', '203.0.113.64/26', '192.0.2.0/24',
                '198.51.100.0/24', '203.0.113.0/24', '203.0.113.0/24', '2001:db8:1::/64', '2001:db8:2::/64',
            ]);
    });

    it('tags default routes and marks the lowest-metric one in use, saying why', () => {
        render(<KernelRouteTable routes={mainRoutes} />);
        const preferred = rowFor('0.0.0.0/0', 48);
        expect(cellText(preferred, 'Destination')).toContain('default');
        expect(cellText(preferred, 'Destination')).toContain('in use');
        expect(preferred.querySelector('[data-testid="kernel-route-preferred"]')?.textContent)
            .toBe('lowest metric of 2 IPv4 default routes');
        const backup = rowFor('0.0.0.0/0', 100);
        expect(cellText(backup, 'Destination')).toContain('default');
        expect(cellText(backup, 'Destination')).not.toContain('in use');
        expect(cellText(rowFor('::/0'), 'Destination')).not.toContain('in use');
    });

    it('reads a 0.0.0.0 or :: next hop as on-link', () => {
        render(<KernelRouteTable routes={mainRoutes} />);
        expect(cellText(rowFor('192.0.2.0/24'), 'Gateway')).toBe('on-link');
        expect(cellText(rowFor('2001:db8:1::/64'), 'Gateway')).toBe('on-link');
        expect(container.textContent).not.toContain('0.0.0.0 ');
        expect(cellText(rowFor('0.0.0.0/0', 48), 'Gateway')).toBe('192.0.2.1');
    });

    it('shows an ECMP route as one row with a line per next hop', () => {
        render(<KernelRouteTable routes={mainRoutes} />);
        const row = rowFor('203.0.113.0/24', 20);
        expect(cellText(row, 'Destination')).toContain('ECMP');
        const gateways = Array.from(row.querySelectorAll('td[data-label="Gateway"] > div')).map((d) => d.textContent);
        expect(gateways).toEqual(['192.0.2.254 weight 1', '198.51.100.254 weight 1']);
        const interfaces = Array.from(row.querySelectorAll('td[data-label="Interface"] > div')).map((d) => d.textContent);
        expect(interfaces).toEqual(['br-ex', 'ens4']);
    });

    it('links interfaces the graph can select and leaves the others plain', () => {
        const selectBrEx = jest.fn();
        render(
            <KernelRouteTable
                routes={mainRoutes}
                selectInterface={(name) => (name === 'br-ex' ? selectBrEx : undefined)}
            />,
        );
        const row = rowFor('0.0.0.0/0', 48);
        const link = row.querySelector('td[data-label="Interface"] button');
        expect(link?.textContent).toBe('br-ex');
        act(() => (link as HTMLButtonElement).click());
        expect(selectBrEx).toHaveBeenCalledTimes(1);
        const plain = rowFor('0.0.0.0/0', 100).querySelector('td[data-label="Interface"]');
        expect(plain?.querySelector('button')).toBeNull();
        expect(plain?.querySelector('code')?.textContent).toBe('ens4');
    });

    it('renders names plainly without a selector', () => {
        render(<KernelRouteTable routes={mainRoutes} />);
        expect(container.querySelector('td[data-label="Interface"] button')).toBeNull();
    });

    it('groups by table when more than one is shown', () => {
        render(<KernelRouteTable routes={allRoutes} viaInterface="ens4" />);
        const summaries = Array.from(container.querySelectorAll('[data-testid="kernel-route-summary"]'))
            .map((summary) => summary.textContent);
        expect(summaries).toEqual([
            'Table 254 (main) · 3 routes · 1 default · 1 ECMP',
            'Table 100 · 2 routes · 1 default',
        ]);
        expect(Array.from(container.querySelectorAll('table')).map((table) => table.getAttribute('aria-label')))
            .toEqual(['Kernel routes, Table 254 (main)', 'Kernel routes, Table 100']);
    });

    it('keeps the Interface column in a via view only for ECMP routes leaving elsewhere too', () => {
        render(<KernelRouteTable routes={allRoutes} viaInterface="ens4" />);
        // The ECMP route's other next hop leaves through br-ex.
        expect(headers(container.querySelector('table')!)).toContain('Interface');

        const singlePath: NnsRoute[] = allRoutes.filter((route) => route.tableId === 100);
        render(<KernelRouteTable routes={singlePath} viaInterface="ens4" />);
        expect(headers()).toEqual(['Destination', 'Gateway', 'Metric']);
        expect(cellText(rowFor('198.51.100.0/24'), 'Metric')).toBe('—');
    });

    it('sorts by a column on request, keeping the default order otherwise', () => {
        render(<KernelRouteTable routes={mainRoutes} />);
        const metricHeader = Array.from(container.querySelectorAll('thead th button'))
            .find((button) => (button.textContent ?? '').includes('Metric')) as HTMLButtonElement;
        act(() => metricHeader.click());
        const metrics = bodyRows().map((row) => Number(cellText(row, 'Metric')));
        expect(metrics).toEqual([...metrics].sort((a, b) => a - b));
    });

    describe('narrow (ovn-recon-dp7.9 item 2)', () => {
        it('shows Destination, Gateway and Interface, and folds Metric, Source and MTU into the row', () => {
            render(<KernelRouteTable routes={mainRoutes} narrow />);
            expect(headers().filter((header) => header !== 'Row expansion')).toEqual(['Destination', 'Gateway', 'Interface']);
            const withMetric = bodyRows().find((row) => row.querySelector('button[aria-expanded="false"]'));
            expect(withMetric).toBeDefined();
            act(() => withMetric!.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click());
            const detail = container.querySelector('[data-testid="kernel-route-detail"]');
            expect(detail).not.toBeNull();
            expect(detail!.textContent).toMatch(/Metric|Source|MTU/);
        });

        it('keeps the full columns without the flag', () => {
            render(<KernelRouteTable routes={mainRoutes} />);
            expect(headers()).toEqual(expect.arrayContaining(['Destination', 'Gateway', 'Interface', 'Metric']));
            expect(container.querySelector('button[aria-expanded]')).toBeNull();
        });
    });
});
