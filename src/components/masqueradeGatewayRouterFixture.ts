import { LogicalDatabase } from '../types';

/**
 * Test fixture (ovn-recon-2n6.2): one zone holding a primary Layer3 UDN's
 * gateway router, in the shape ovn-kubernetes gives it. Network ID 2, so the
 * gateway router's masquerade address is 169.254.0.13 (10 + 2*2 - 1). Its
 * rtoe- port carries that address as a /32 beside the node address; its two
 * SNAT rows (the network's pod subnet and its own join address) both
 * translate to it; a static route sends the masquerade subnet to the dummy
 * next hop. Documentation addresses only.
 */
export const UDN_NETWORK = 'demo_tenant';
export const UDN_GATEWAY_ROUTER = 'GR_demo_tenant_node-a';
export const UDN_MASQUERADE_IP = '169.254.0.13';
export const UDN_NODE_IP = '192.0.2.10';
/** The egress IP of the optional EgressIP row, and the pod it selects. */
export const UDN_EGRESS_IP = '198.51.100.20';
export const UDN_EGRESS_POD_IP = '10.200.1.7';

const ids = { 'k8s.ovn.org/network': UDN_NETWORK, 'k8s.ovn.org/topology': 'layer3', 'k8s.ovn.org/role': 'primary' };

/**
 * With `egressIp`, the router also holds the SNAT row an EgressIP adds on its
 * egress node: one pod's address to the egress IP, tagged with its owner.
 */
export const udnGatewayRouterDatabase = ({ egressIp = false }: { egressIp?: boolean } = {}): LogicalDatabase => ({
    logicalRouters: [
        {
            uuid: 'gr',
            name: UDN_GATEWAY_ROUTER,
            ports: ['rtoj', 'rtoe'],
            nat: ['nat-pods', 'nat-join', ...(egressIp ? ['nat-eip'] : [])],
            staticRoutes: ['route-masq', 'route-default', 'route-cluster'],
            externalIds: { ...ids, physical_ip: UDN_NODE_IP, physical_ips: `${UDN_NODE_IP},${UDN_MASQUERADE_IP}` },
            options: { lb_force_snat_ip: '100.65.0.4', chassis: 'chassis-a' },
        },
    ],
    logicalRouterPorts: [
        { uuid: 'rtoj', name: `rtoj-${UDN_GATEWAY_ROUTER}`, mac: '0a:58:64:41:00:04', networks: ['100.65.0.4/16'] },
        {
            uuid: 'rtoe',
            name: `rtoe-${UDN_GATEWAY_ROUTER}`,
            mac: '0a:58:c0:00:02:0a',
            networks: [`${UDN_MASQUERADE_IP}/32`, `${UDN_NODE_IP}/24`],
        },
    ],
    logicalSwitches: [
        {
            uuid: 'node-switch',
            name: 'demo_tenant_node-a',
            ports: [],
            otherConfig: { subnet: '10.200.1.0/24' },
            externalIds: ids,
        },
    ],
    logicalSwitchPorts: [],
    nats: [
        {
            uuid: 'nat-pods',
            type: 'snat',
            externalIp: UDN_MASQUERADE_IP,
            logicalIp: '10.200.0.0/16',
            externalPortRange: '32768-60999',
            externalIds: ids,
        },
        {
            uuid: 'nat-join',
            type: 'snat',
            externalIp: UDN_MASQUERADE_IP,
            logicalIp: '100.65.0.4',
            externalPortRange: '32768-60999',
            externalIds: ids,
        },
        ...(egressIp
            ? [
                  {
                      uuid: 'nat-eip',
                      type: 'snat' as const,
                      externalIp: UDN_EGRESS_IP,
                      logicalIp: UDN_EGRESS_POD_IP,
                      externalIds: {
                          'k8s.ovn.org/owner-type': 'EgressIP',
                          'k8s.ovn.org/name': 'demo-egress',
                          'k8s.ovn.org/network': UDN_NETWORK,
                      },
                  },
              ]
            : []),
    ],
    staticRoutes: [
        { uuid: 'route-masq', ipPrefix: '169.254.0.0/17', nexthop: '169.254.0.4', outputPort: `rtoe-${UDN_GATEWAY_ROUTER}`, externalIds: ids },
        { uuid: 'route-default', ipPrefix: '0.0.0.0/0', nexthop: '192.0.2.1', outputPort: `rtoe-${UDN_GATEWAY_ROUTER}`, externalIds: ids },
        { uuid: 'route-cluster', ipPrefix: '10.200.0.0/16', nexthop: '100.65.0.1', outputPort: `rtoj-${UDN_GATEWAY_ROUTER}`, externalIds: ids },
    ],
});
