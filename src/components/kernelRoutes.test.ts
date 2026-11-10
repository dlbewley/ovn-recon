import fs from 'fs';
import path from 'path';

import { NodeNetworkState } from '../types';
import {
    buildKernelRouteTables,
    isOnLinkNextHop,
    kernelRouteSummary,
    kernelTableLabel,
    KernelRouteRow,
    MAIN_TABLE_ID,
    routeTablesVia,
} from './kernelRoutes';
import { getRoutesViaInterface, getRunningRoutes, getVrfRoutesForInterface, NnsRoute } from './nodeVisualizationSelectors';

const loadNns = (name: string): NodeNetworkState =>
    JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'nns', `${name}.json`), 'utf-8'),
    ) as NodeNetworkState;

/** "203.0.113.0/24 m20" — destination and metric, enough to read an order. */
const brief = (row: KernelRouteRow): string => `${row.destination}${row.metric !== undefined ? ` m${row.metric}` : ''}`;

const mainTable = (routes: NnsRoute[]) => {
    const main = buildKernelRouteTables(routes).find((group) => group.tableId === MAIN_TABLE_ID);
    if (!main) throw new Error('no main table');
    return main;
};

describe('reading routes.running', () => {
    it('reads every table and only running entries', () => {
        const routes = getRunningRoutes(loadNns('kernel-routes'));
        expect(routes).toHaveLength(13);
        expect(new Set(routes.map((route) => route.tableId))).toEqual(new Set([254, 100]));
    });

    it('keeps the fields NodeNetworkState reports and adds none', () => {
        const routes = getRunningRoutes(loadNns('primary-cudn-vrf'));
        expect(routes.find((route) => route.destination === '172.30.0.0/16' && route.tableId === 5775)).toEqual({
            destination: '172.30.0.0/16',
            nextHopAddress: '169.254.0.4',
            nextHopInterface: 'br-ex',
            tableId: 5775,
            vrfName: 'example-p-cudn',
            mtu: 1400,
        });
        expect(routes.find((route) => route.destination === '0.0.0.0/0' && route.tableId === 254)?.metric).toBe(48);
    });

    it('accepts the dotted routes.running key and other key spellings', () => {
        expect(getRunningRoutes(loadNns('partial-missing-fields'))).toEqual([
            { destination: '203.0.113.0/24', nextHopInterface: 'ovn-k8s-mp2' },
        ]);
        const mixed = getRunningRoutes(loadNns('vrf-mixed-routes'));
        expect(mixed.find((route) => route.destination === '172.30.0.0/16')).toMatchObject({
            nextHopInterface: 'ovn-k8s-mp1',
            tableId: 1001,
            metric: 100,
        });
        expect(mixed.find((route) => route.destination === '198.51.100.0/24')).toMatchObject({
            nextHopInterface: 'eno2',
            tableId: 254,
        });
    });

    it('selects the routes leaving through one device, from every table', () => {
        const routes = getRoutesViaInterface('ens4', loadNns('kernel-routes'));
        expect(routes).toHaveLength(5);
        expect(routes.every((route) => route.nextHopInterface === 'ens4')).toBe(true);
        expect(new Set(routes.map((route) => route.tableId))).toEqual(new Set([254, 100]));
        expect(getRoutesViaInterface('', loadNns('kernel-routes'))).toEqual([]);
    });
});

describe('kernel route tables', () => {
    const routes = getRunningRoutes(loadNns('kernel-routes'));

    it('pins default routes first, then longest prefix, address and metric', () => {
        expect(mainTable(routes).rows.map(brief)).toEqual([
            '0.0.0.0/0 m48',
            '0.0.0.0/0 m100',
            '::/0 m48',
            '203.0.113.64/26 m20',
            '192.0.2.0/24 m48',
            '198.51.100.0/24 m100',
            '203.0.113.0/24 m20',
            '203.0.113.0/24 m200',
            '2001:db8:1::/64 m48',
            '2001:db8:2::/64 m1024',
        ]);
    });

    it('orders a real worker\'s main table the same way', () => {
        expect(mainTable(getRunningRoutes(loadNns('primary-cudn-vrf'))).rows.map(brief)).toEqual([
            '0.0.0.0/0 m48',
            '169.254.0.1/32',
            '169.254.0.3/32',
            '172.30.0.0/16',
            '10.128.0.0/14',
        ]);
    });

    it('reads a next hop of 0.0.0.0, :: or none as on-link', () => {
        expect(isOnLinkNextHop('0.0.0.0')).toBe(true);
        expect(isOnLinkNextHop('::')).toBe(true);
        expect(isOnLinkNextHop('0:0::0')).toBe(true);
        expect(isOnLinkNextHop(undefined)).toBe(true);
        expect(isOnLinkNextHop('')).toBe(true);
        expect(isOnLinkNextHop('192.0.2.1')).toBe(false);
        expect(isOnLinkNextHop('2001:db8:1::1')).toBe(false);

        const rows = mainTable(routes).rows;
        expect(rows.find((row) => row.destination === '192.0.2.0/24')?.nextHops).toEqual([
            { gateway: undefined, interface: 'br-ex', weight: undefined },
        ]);
        expect(rows.find((row) => row.destination === '2001:db8:1::/64')?.nextHops[0].gateway).toBeUndefined();
        expect(rows.find((row) => row.destination === '::/0')?.nextHops[0].gateway).toBe('2001:db8:1::1');
    });

    it('marks the lowest-metric default route preferred when a table holds two', () => {
        const rows = mainTable(routes).rows;
        const defaults = rows.filter((row) => row.isDefault && row.family === 4);
        expect(defaults.map((row) => [row.metric, row.nextHops[0].interface, row.preferred])).toEqual([
            [48, 'br-ex', { among: 2 }],
            [100, 'ens4', undefined],
        ]);
        // The lone IPv6 default competes with nothing, so it carries no mark.
        expect(rows.find((row) => row.destination === '::/0')?.preferred).toBeUndefined();
        // Nor does the second table's lone default.
        const policyTable = buildKernelRouteTables(routes).find((group) => group.tableId === 100)!;
        expect(policyTable.rows.find((row) => row.isDefault)?.preferred).toBeUndefined();
    });

    it('marks nothing when a competing default route reports no metric', () => {
        const rows = mainTable([
            { destination: '0.0.0.0/0', nextHopAddress: '192.0.2.1', nextHopInterface: 'br-ex', tableId: 254 },
            { destination: '0.0.0.0/0', nextHopAddress: '198.51.100.1', nextHopInterface: 'ens4', metric: 100, tableId: 254 },
        ]).rows;
        expect(rows.map((row) => row.preferred)).toEqual([undefined, undefined]);
        // It still orders as metric 0, the value the kernel leaves unreported.
        expect(rows.map((row) => row.nextHops[0].interface)).toEqual(['br-ex', 'ens4']);
    });

    it('groups ECMP next hops to one destination at one metric under one row', () => {
        const rows = mainTable(routes).rows.filter((row) => row.destination === '203.0.113.0/24');
        expect(rows).toHaveLength(2);
        expect(rows[0].metric).toBe(20);
        expect(rows[0].nextHops).toEqual([
            { gateway: '192.0.2.254', interface: 'br-ex', weight: 1 },
            { gateway: '198.51.100.254', interface: 'ens4', weight: 1 },
        ]);
        // The same destination at another metric is another route.
        expect(rows[1].metric).toBe(200);
        expect(rows[1].nextHops).toHaveLength(1);
        expect(kernelRouteSummary(mainTable(routes).rows)).toBe('10 routes · 3 default · 1 ECMP');
    });

    it('carries IPv6 routes with their family and prefix length', () => {
        const row = mainTable(routes).rows.find((candidate) => candidate.destination === '2001:db8:2::/64')!;
        expect(row).toMatchObject({ family: 6, prefixLength: 64, metric: 1024, isDefault: false });
        expect(mainTable(routes).rows.find((candidate) => candidate.destination === '::/0')).toMatchObject({
            family: 6,
            isDefault: true,
        });
    });

    it('collects distinct sources and MTUs per row', () => {
        const rows = mainTable(routes).rows;
        expect(rows.find((row) => row.destination === '192.0.2.0/24')?.sources).toEqual(['192.0.2.10']);
        expect(rows.find((row) => row.destination === '203.0.113.64/26')?.mtus).toEqual([1400]);
        expect(rows.find((row) => row.destination === '0.0.0.0/0')?.sources).toEqual([]);
    });

    it('groups by table, main first, labelled with its id and VRF', () => {
        const groups = buildKernelRouteTables(getRunningRoutes(loadNns('primary-cudn-vrf')));
        expect(groups.map(kernelTableLabel)).toEqual([
            'Table 254 (main)',
            'Table 7',
            'Table 5775 · VRF example-p-cudn',
        ]);
        expect(kernelTableLabel({ tableId: undefined })).toBe('Table not reported');
    });

    it('shows a VRF the routes of its own table', () => {
        const nns = loadNns('evpn-vxlan');
        const vrf = nns.status!.currentState!.interfaces.find((iface) => iface.name === 'mp9-udn-vrf')!;
        const groups = buildKernelRouteTables(getVrfRoutesForInterface(vrf, nns));
        expect(groups.map(kernelTableLabel)).toEqual(['Table 1146 · VRF mp9-udn-vrf']);
        expect(groups[0].rows.map(brief)).toEqual(['169.254.0.3/32', '169.254.0.28/32', '172.30.0.0/16']);
        expect(groups[0].rows[1].nextHops).toEqual([{ gateway: undefined, interface: 'ovn-k8s-mp9', weight: undefined }]);
    });
});

describe('routes via an interface', () => {
    const groups = buildKernelRouteTables(getRunningRoutes(loadNns('kernel-routes')));

    it('keeps only rows with a next hop through the device, across tables', () => {
        const via = routeTablesVia(groups, 'ens4');
        expect(via.map(kernelTableLabel)).toEqual(['Table 254 (main)', 'Table 100']);
        expect(via[0].rows.map(brief)).toEqual(['0.0.0.0/0 m100', '198.51.100.0/24 m100', '203.0.113.0/24 m20']);
        expect(via[1].rows.map(brief)).toEqual(['0.0.0.0/0 m100', '198.51.100.0/24']);
    });

    it('keeps an ECMP route whole and the preferred mark from the whole table', () => {
        const via = routeTablesVia(groups, 'br-ex');
        const ecmp = via[0].rows.find((row) => row.destination === '203.0.113.0/24' && row.metric === 20)!;
        expect(ecmp.nextHops.map((hop) => hop.interface)).toEqual(['br-ex', 'ens4']);
        const defaults = via[0].rows.filter((row) => row.isDefault && row.family === 4);
        expect(defaults.map((row) => [row.metric, row.preferred])).toEqual([[48, { among: 2 }]]);
    });

    it('drops tables with no route through the device', () => {
        expect(routeTablesVia(groups, 'br-ex').map(kernelTableLabel)).toEqual(['Table 254 (main)']);
        expect(routeTablesVia(groups, 'ens3')).toEqual([]);
    });
});
