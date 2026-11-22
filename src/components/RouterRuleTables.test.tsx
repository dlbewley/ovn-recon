import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

import { LogicalDatabase, LogicalTopologySnapshot, NATRow, StaticRouteRow } from '../types';
import { NatRuleTable, NatRuleTableProps, StaticRouteTable } from './RouterRuleTables';
import { TestRouter } from './testRouter';
import {
    UDN_EGRESS_IP,
    UDN_EGRESS_POD_IP,
    UDN_GATEWAY_ROUTER,
    UDN_MASQUERADE_IP,
    UDN_NETWORK,
    UDN_NODE_IP,
    udnGatewayRouterDatabase,
} from './masqueradeGatewayRouterFixture';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';

const rowsOf = (database: LogicalDatabase, routerName: string) => {
    const router = database.logicalRouters.find((row) => row.name === routerName)!;
    const nats = new Map(database.nats.map((nat) => [nat.uuid, nat]));
    const routes = new Map(database.staticRoutes.map((route) => [route.uuid, route]));
    return {
        nats: (router.nat ?? []).map((uuid) => nats.get(uuid) as NATRow),
        routes: (router.staticRoutes ?? []).map((uuid) => routes.get(uuid) as StaticRouteRow),
        network: router.externalIds?.['k8s.ovn.org/network'] ?? 'default',
    };
};

describe('router rule tables: masquerade (ovn-recon-2n6.2)', () => {
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

    const render = (element: React.ReactElement) =>
        act(() => {
            root.render(<TestRouter>{element}</TestRouter>);
        });

    const natTable = (database: LogicalDatabase, routerName: string, props: Partial<NatRuleTableProps> = {}) => {
        const { nats, network } = rowsOf(database, routerName);
        return (
            <NatRuleTable
                nats={nats}
                database={database}
                databaseNode="node-a"
                network={network}
                routerName={routerName}
                {...props}
            />
        );
    };
    const routeTable = (database: LogicalDatabase, routerName: string, query?: string) => (
        <StaticRouteTable routes={rowsOf(database, routerName).routes} routerName={routerName} database={database} query={query} />
    );

    const natRows = () => [...container.querySelectorAll('table[aria-label="NAT rules"] tr[data-testid^="rule-row-"]')];
    const routeRows = () => [...container.querySelectorAll('table[aria-label="Static routes"] tr[data-testid^="rule-row-"]')];
    const texts = (selector: string) => [...container.querySelectorAll(selector)].map((element) => element.textContent);

    describe('a primary UDN gateway router', () => {
        const udn = udnGatewayRouterDatabase();

        it('names the masquerade IP, its network linked to the network scope, and each row\'s intent', () => {
            render(natTable(udn, UDN_GATEWAY_ROUTER));
            expect(natRows()).toHaveLength(2);
            expect(texts('[data-testid="nat-masquerade-owner"]')).toEqual([
                'masquerade IP of demo/tenant (network ID 2)',
                'masquerade IP of demo/tenant (network ID 2)',
            ]);
            const link = container.querySelector<HTMLAnchorElement>('[data-testid="nat-masquerade-owner"] a');
            expect(link?.getAttribute('href')).toBe('/ovn-recon/networks/udn/demo/tenant');
            expect(texts('[data-testid="nat-logical-intent"]').sort()).toEqual([
                'pod subnet of demo/tenant',
                "this router's join address",
            ]);
        });

        it('explains the second SNAT on the page, not in the drawer', () => {
            render(natTable(udn, UDN_GATEWAY_ROUTER, { explainEgress: true }));
            const line = container.querySelector('[data-testid="nat-masquerade-egress"]');
            expect(line?.textContent).toBe(
                `Egress from demo/tenant leaves OVN as ${UDN_MASQUERADE_IP}; br-ex then rewrites it to the node address ` +
                    `${UDN_NODE_IP}. That second step is an OVS flow and is not listed here. ` +
                    'Pods an EgressIP selects leave as its egress IP instead, from whichever node holds it.',
            );
            expect(line?.querySelector('a')?.getAttribute('href')).toBe('/ovn-recon/networks/udn/demo/tenant');

            render(natTable(udn, UDN_GATEWAY_ROUTER));
            expect(container.querySelector('[data-testid="nat-masquerade-egress"]')).toBeNull();
            expect(container.querySelectorAll('[data-testid="nat-masquerade-owner"]')).toHaveLength(2);
        });

        it("names the router's EgressIP addresses in the line and leaves the EgressIP row undescribed", () => {
            const withEip = udnGatewayRouterDatabase({ egressIp: true });
            render(natTable(withEip, UDN_GATEWAY_ROUTER, { explainEgress: true, grouped: false }));
            expect(natRows()).toHaveLength(3);
            expect(container.querySelector('[data-testid="nat-masquerade-egress-ip-caveat"]')?.textContent).toBe(
                `Pods an EgressIP selects leave as its egress IP instead (on this router: ${UDN_EGRESS_IP}).`,
            );
            // The two masquerade rows keep their notes; the EgressIP row gets neither.
            expect(container.querySelectorAll('[data-testid="nat-masquerade-owner"]')).toHaveLength(2);
            expect(container.querySelectorAll('[data-testid="nat-logical-intent"]')).toHaveLength(2);
            const eipRow = natRows().find((row) => row.textContent?.includes(UDN_EGRESS_POD_IP));
            expect(eipRow?.querySelector('[data-testid="nat-logical-intent"]')).toBeNull();
            expect(eipRow?.querySelector('[data-testid="nat-masquerade-owner"]')).toBeNull();
        });

        it('matches "masquerade", the network name and the intent in the filter', () => {
            for (const query of ['masquerade', 'tenant', UDN_NETWORK, 'join address', 'pod subnet']) {
                render(natTable(udn, UDN_GATEWAY_ROUTER, { query }));
                expect([query, natRows().length]).toEqual([query, query === 'join address' || query === 'pod subnet' ? 1 : 2]);
            }
            render(natTable(udn, UDN_GATEWAY_ROUTER, { query: 'no-such-thing' }));
            expect(natRows()).toHaveLength(0);
        });

        it('labels the masquerade subnet route and its dummy next hop, and filters on them', () => {
            render(routeTable(udn, UDN_GATEWAY_ROUTER));
            expect(texts('[data-testid="masquerade-subnet-route"]')).toEqual(['masquerade subnet']);
            expect(texts('[data-testid="nexthop-masquerade-role"]')).toEqual(['Dummy next hop']);

            render(routeTable(udn, UDN_GATEWAY_ROUTER, 'masquerade'));
            expect(routeRows()).toHaveLength(1);
            render(routeTable(udn, UDN_GATEWAY_ROUTER, 'dummy next hop'));
            expect(routeRows()).toHaveLength(1);
        });
    });

    describe("the fixture zone's other routers", () => {
        const database = (cnv1 as unknown as LogicalTopologySnapshot).database as LogicalDatabase;

        it("leaves the default network's gateway router NAT table as it was", () => {
            render(natTable(database, 'GR_cnv-1', { explainEgress: true, grouped: false }));
            expect(container.querySelector('[data-testid="nat-masquerade-egress"]')).toBeNull();
            expect(container.querySelector('[data-testid="nat-masquerade-owner"]')).toBeNull();
            expect(container.querySelector('[data-testid="nat-logical-intent"]')).toBeNull();
        });

        it("resolves only the dummy next hop and masquerade route on the default network's gateway router", () => {
            render(routeTable(database, 'GR_cnv-1'));
            expect(texts('[data-testid="masquerade-subnet-route"]')).toEqual(['masquerade subnet']);
            expect(texts('[data-testid="nexthop-masquerade-role"]')).toEqual(['Dummy next hop']);
        });

        it('adds nothing on ovn_cluster_router', () => {
            render(routeTable(database, 'ovn_cluster_router'));
            expect(routeRows().length).toBeGreaterThan(0);
            expect(container.querySelector('[data-testid="masquerade-subnet-route"]')).toBeNull();
            expect(container.querySelector('[data-testid="nexthop-masquerade-role"]')).toBeNull();
        });

        it('explains the Layer2 CUDN gateway router in the fixture', () => {
            render(natTable(database, 'GR_cluster_udn_example.p.cudn_cnv-1', { explainEgress: true }));
            expect(container.querySelector('[data-testid="nat-masquerade-egress"]')?.textContent).toContain(
                'Egress from example-p-cudn leaves OVN as 169.254.0.15; br-ex then rewrites it to the node address 192.168.4.72.',
            );
            expect(texts('[data-testid="nat-masquerade-owner"]')).toEqual([
                'masquerade IP of example-p-cudn (network ID 3)',
                'masquerade IP of example-p-cudn (network ID 3)',
            ]);
        });
    });
});
