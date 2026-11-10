import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

/** A port on a bridge interface. OVS records an access VLAN tag here. */
export interface BridgePort {
    name: string;
    vlan?: { mode?: string; tag?: number };
}

/**
 * nmstate emits `prefix-length`; some captures and older shapes use
 * `prefix_length`. Both are declared so call sites are forced to consider it --
 * see getIpv4Addresses in nodeVisualizationSelectors.
 */
export interface Ipv4AddressEntry {
    ip: string;
    'prefix-length'?: number;
    prefix_length?: number;
}

/**
 * One virtual function of an SR-IOV NIC, as its physical function reports it.
 * `iface-name` is present only while the VF is a host interface: a VF moved into a
 * pod's network namespace or bound to a userspace driver keeps its entry but loses
 * the name, which is how the host says it is in use elsewhere.
 */
export interface SriovVf {
    id: number;
    'iface-name'?: string;
    'mac-address'?: string;
    trust?: boolean;
    'spoof-check'?: boolean;
    'vlan-id'?: number;
    'vlan-proto'?: string;
    qos?: number;
    'min-tx-rate'?: number;
    'max-tx-rate'?: number;
}

/** `ethernet.sr-iov` on a physical function. Reported only by NICs that support it. */
export interface SriovConfig {
    'total-vfs'?: number;
    'max-vfs'?: number;
    'drivers-autoprobe'?: boolean;
    vfs?: SriovVf[];
}

export interface Interface {
    name: string;
    type: string;
    state: string;
    controller?: string;
    master?: string;
    vlan?: { 'base-iface': string; id?: number; protocol?: string };
    'mac-vlan'?: { 'base-iface': string };
    /** OVS patch port: nmstate reports the reciprocal peer port. */
    patch?: { peer?: string };
    /** Present on bridge interfaces. Not to be confused with OvnBridgeMapping.bridge, which is a name. */
    bridge?: { port?: BridgePort[]; ports?: BridgePort[] };
    localnet?: string;
    mtu?: number;
    mac_address?: string;
    'mac-address'?: string;
    vrf?: { port?: string[] | string; 'route-table-id'?: number };
    /**
     * A VXLAN tunnel device. `local` is the VTEP address, which some other interface on
     * this node holds; `id` is the VNI, and 0 when VNIs are mapped per VLAN on the bridge
     * the device is enslaved to (the EVPN shape).
     */
    vxlan?: {
        id?: number;
        local?: string;
        remote?: string;
        'destination-port'?: number;
        learning?: boolean;
    };
    ipv4?: { enabled?: boolean; address?: Ipv4AddressEntry[] };
    /** The kernel driver bound to the device, e.g. `igc` or `vmxnet3`. */
    driver?: string;
    'pci-address'?: string;
    /** The address the hardware reports, which `mac-address` may have been set away from. */
    'permanent-mac-address'?: string;
    'alt-names'?: { name?: string }[];
    'min-mtu'?: number;
    'max-mtu'?: number;
    /** Negotiated link. `speed` is in Mb/s, and not positive when the link is down. */
    ethernet?: { speed?: number; duplex?: string; 'auto-negotiation'?: boolean; 'sr-iov'?: SriovConfig };
    /** Each neighbour is a list of TLV objects; see normalizeLldpNeighbor. */
    lldp?: { enabled?: boolean; neighbors?: unknown[] };
    /**
     * A bond. `port` lists the member interfaces (`slaves` in older nmstate). `options`
     * are the kernel bonding options as nmstate reports them, which may be strings,
     * numbers or booleans, and may be absent altogether.
     */
    'link-aggregation'?: {
        mode?: string;
        port?: string[];
        slaves?: string[];
        options?: Record<string, string | number | boolean | null | undefined>;
    };
    [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface OvnBridgeMapping {
    localnet: string;
    bridge: string;
    state?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
}

export interface NodeNetworkState extends K8sResourceCommon {
    status?: {
        currentState?: {
            interfaces: Interface[];
            ovn?: {
                'bridge-mappings': OvnBridgeMapping[];
            };
        };
    };
}

/** metav1.LabelSelector, as used by CUDN namespaceSelector and RA network selectors. */
export interface LabelSelector {
    matchLabels?: { [key: string]: string };
    matchExpressions?: { key: string; operator: string; values?: string[] }[];
}

/**
 * Layer3 subnets are objects, unlike Layer2's plain CIDR strings — the CRD
 * schemas genuinely differ per topology.
 */
export interface Layer3Subnet {
    cidr: string;
    hostSubnet?: number;
}

export interface UserDefinedNetwork extends K8sResourceCommon {
    spec?: {
        topology?: string; // 'Layer2' | 'Layer3' (UserDefinedNetworkSpec has topology at spec level)
        layer2?: { role?: 'Primary' | 'Secondary'; subnets?: string[] };
        layer3?: { role?: 'Primary' | 'Secondary'; subnets?: Layer3Subnet[] };
    };
    status?: {
        conditions?: { type: string; status: string; message?: string }[];
        /** As ClusterUserDefinedNetwork.status.vrfName. */
        vrfName?: string;
    };
}

export interface ClusterUserDefinedNetwork extends K8sResourceCommon {
    spec?: {
        /** The declared rule that scopes namespaces into this network. */
        namespaceSelector?: LabelSelector;
        network?: {
            topology: string;
            // Same shape as `localnet`; both capitalizations appear in the wild.
            localNet?: {
                physicalNetworkName: string;
                role?: 'Primary' | 'Secondary';
                vlan?: { access: { id: number } };
            };
            localnet?: {
                physicalNetworkName: string;
                role?: 'Primary' | 'Secondary';
                vlan?: { access: { id: number } };
            };
            layer2?: {
                role?: 'Primary' | 'Secondary';
                subnets?: string[];
                joinSubnets?: string[];
            };
            layer3?: {
                role?: 'Primary' | 'Secondary';
                subnets?: Layer3Subnet[];
                joinSubnets?: string[];
            };
            /** 'EVPN' when the network is carried over VXLAN/EVPN rather than Geneve. */
            transport?: string;
            evpn?: EvpnNetworkConfig;
        };
    };
    status?: {
        conditions?: { type: string; status: string; message?: string }[];
        /**
         * The Linux VRF device OVN-Kubernetes creates for a Primary network on each
         * node. Published by newer releases so consumers need not derive the name;
         * absent on older ones, where it has to be worked out.
         */
        vrfName?: string;
    };
}

/** One VRF of an EVPN network: its VXLAN network identifier and BGP route target. */
export interface EvpnVrfConfig {
    vni?: number;
    routeTarget?: string;
}

/**
 * `spec.network.evpn` on a ClusterUserDefinedNetwork. `vtep` names the cluster-scoped
 * VTEP whose devices carry the network; a Layer2 network has a MAC-VRF, a routed one
 * an IP-VRF, and a network may have both.
 */
export interface EvpnNetworkConfig {
    vtep?: string;
    macVRF?: EvpnVrfConfig;
    ipVRF?: EvpnVrfConfig;
}

/**
 * The cluster-scoped `k8s.ovn.org/v1` VTEP: the address pool EVPN tunnels terminate
 * on. In `Unmanaged` mode OVN-Kubernetes discovers one existing node address inside
 * `spec.cidrs` and records it on the Node; the kernel devices it creates for the VTEP
 * are named after the VTEP (see the EVPN selectors).
 */
export interface Vtep extends K8sResourceCommon {
    spec?: {
        cidrs?: string[];
        mode?: string;
    };
    status?: {
        conditions?: { type: string; status: string; reason?: string; message?: string }[];
    };
}

/**
 * One VF group of a physical function in SriovNetworkNodeState.spec: the VFs in
 * `vfRange` ("0-3") are carved for the device-plugin resource `resourceName` (without
 * the `openshift.io/` prefix a NAD's annotation carries), bound to `deviceType`
 * (`netdevice` or `vfio-pci`), at the direction of SriovNetworkNodePolicy `policyName`.
 */
export interface SriovVfGroup {
    resourceName?: string;
    policyName?: string;
    deviceType?: string;
    vfRange?: string;
    mtu?: number;
}

/** A physical function as SriovNetworkNodeState.spec configures it. */
export interface SriovNodeStateSpecInterface {
    name?: string;
    pciAddress?: string;
    numVfs?: number;
    mtu?: number;
    externallyManaged?: boolean;
    vfGroups?: SriovVfGroup[];
}

/**
 * A VF as SriovNetworkNodeState.status reports it. `name` and `mac` are present only
 * while the VF is a host netdevice; a vfio-pci VF has a driver and a PCI address.
 */
export interface SriovNodeStateVf {
    vfID?: number;
    driver?: string;
    pciAddress?: string;
    name?: string;
    mac?: string;
    mtu?: number;
    vendor?: string;
    deviceID?: string;
}

/** A physical function as SriovNetworkNodeState.status reports it. */
export interface SriovNodeStateStatusInterface {
    name?: string;
    pciAddress?: string;
    driver?: string;
    mac?: string;
    numVfs?: number;
    totalvfs?: number;
    linkSpeed?: string;
    eSwitchMode?: string;
    externallyManaged?: boolean;
    Vfs?: SriovNodeStateVf[];
}

/**
 * The SR-IOV Network Operator's per-node record (`sriovnetwork.openshift.io/v1`, in
 * the operator's namespace, named for the node). Absent on clusters without the
 * operator. spec is what the policies asked for on this node; status is what the
 * config daemon found.
 */
export interface SriovNetworkNodeState extends K8sResourceCommon {
    spec?: {
        interfaces?: SriovNodeStateSpecInterface[];
    };
    status?: {
        interfaces?: SriovNodeStateStatusInterface[];
        syncStatus?: string;
        lastSyncError?: string;
    };
}

/**
 * The per-node record of an applied NodeNetworkConfigurationPolicy. Its
 * status.desiredState names exactly which interfaces and bridge mappings the
 * policy configured on this node -- an observation, not a name-matching guess.
 */
export interface NodeNetworkConfigurationEnactment extends K8sResourceCommon {
    status?: {
        desiredState?: {
            interfaces?: { name: string; type?: string }[];
            ovn?: { 'bridge-mappings'?: { bridge?: string; localnet?: string; state?: string }[] };
        };
        conditions?: { type: string; status: string; reason?: string; message?: string }[];
        policyGeneration?: number;
    };
}

export interface NetworkAttachmentDefinition extends K8sResourceCommon {
    spec?: {
        config: string;
    };
}

export interface RouteAdvertisements extends K8sResourceCommon {
    spec?: {
        networkSelectors?: {
            clusterUserDefinedNetworkSelector?: {
                networkSelector?: {
                    matchLabels?: { [key: string]: string };
                    matchExpressions?: { key: string; operator: string; values: string[] }[];
                };
            };
        }[];
    };
}

export interface LogicalTopologyMetadata {
    schemaVersion: string;
    generatedAt: string;
    sourceHealth: string;
    nodeName: string;
}

export interface LogicalTopologyWarning {
    code: string;
    message: string;
}

/** @deprecated v1 graph payload; v2 consumers read LogicalDatabase instead. */
export interface LogicalTopologyNode {
    id: string;
    kind: string;
    label: string;
    data?: Record<string, unknown>;
}

/** @deprecated v1 graph payload; v2 consumers read LogicalDatabase instead. */
export interface LogicalTopologyEdge {
    id: string;
    source: string;
    target: string;
    kind: string;
    data?: Record<string, unknown>;
}

/** @deprecated v1 graph payload; v2 consumers read LogicalDatabase instead. */
export interface LogicalTopologyGroup {
    id: string;
    label: string;
    nodeIds: string[];
}

// v2 snapshot contract (metadata.schemaVersion === LOGICAL_TOPOLOGY_SCHEMA_V2):
// a table-oriented transcription of the OVN NB tables. Mirrors
// collector/internal/snapshot/types.go and
// collector/api/logical-topology-snapshot.schema.json.
export const LOGICAL_TOPOLOGY_SCHEMA_V2 = '2';

export interface LogicalRouterRow {
    uuid: string;
    name: string;
    ports: string[];
    nat?: string[];
    staticRoutes?: string[];
    /** Administrative state; absent when unset, which OVN treats as enabled. */
    enabled?: boolean;
    /** Logical_Router_Policy uuids (table not yet collected). */
    policies?: string[];
    /** Load_Balancer / Load_Balancer_Group uuids, resolved by the `services`
     * section (LogicalDatabase.loadBalancers, loadBalancerGroups). */
    loadBalancer?: string[];
    loadBalancerGroup?: string[];
    /** Copp uuid when control-plane policing is attached. */
    copp?: string;
    options?: Record<string, string>;
    externalIds?: Record<string, string>;
}

export interface LogicalRouterPortRow {
    uuid: string;
    name: string;
    mac?: string;
    networks?: string[];
    peer?: string;
    /** Administrative state; absent when unset (enabled). */
    enabled?: boolean;
    /** Gateway_Chassis uuids, resolved by LogicalDatabase.gatewayChassis. */
    gatewayChassis?: string[];
    /** northd-written status; `hosting-chassis` names the chassis hosting a
     * distributed gateway port. */
    status?: Record<string, string>;
    options?: Record<string, string>;
    externalIds?: Record<string, string>;
}

export interface LogicalSwitchRow {
    uuid: string;
    name: string;
    ports: string[];
    /** ACL uuids set on the switch itself, resolved by the `policy` section
     * (LogicalDatabase.acls). ACLs also reach the switch's ports through
     * port groups: see policyIndex.ts. */
    acls?: string[];
    /** Load_Balancer / Load_Balancer_Group uuids, resolved by the `services`
     * section (LogicalDatabase.loadBalancers, loadBalancerGroups). */
    loadBalancer?: string[];
    loadBalancerGroup?: string[];
    /** QoS uuids (table not yet collected). */
    qosRules?: string[];
    otherConfig?: Record<string, string>;
    externalIds?: Record<string, string>;
}

export interface LogicalSwitchPortRow {
    uuid: string;
    name: string;
    type?: string;
    addresses?: string[];
    /** VLAN tag on localnet/l2gateway ports, when set. */
    tag?: string;
    /** Allowed source MAC (and IP) addresses; ovn-kubernetes sets it on every pod port. */
    portSecurity?: string[];
    /** northd-reported binding state; absent when the optional column is unset. */
    up?: boolean;
    /** Administrative state; absent (unset) means enabled. */
    enabled?: boolean;
    /** Address northd allocated for a port whose addresses hold "dynamic". */
    dynamicAddresses?: string;
    /** Requested VLAN tag; the allocated tag is in `tag`. */
    tagRequest?: string;
    /** Parent port of a nested (container) port. */
    parentName?: string;
    options?: Record<string, string>;
    externalIds?: Record<string, string>;
}

/** Per-node chassis state: localnet name → physical OVS bridge. */
export interface BridgeMappingRow {
    localnet: string;
    bridge: string;
}

export type NATType = 'snat' | 'dnat' | 'dnat_and_snat';

export interface NATRow {
    uuid: string;
    type: NATType;
    externalIp?: string;
    logicalIp?: string;
    logicalPort?: string;
    externalMac?: string;
    /** Logical_Router_Port uuid the rule applies on. */
    gatewayPort?: string;
    /** Packet match narrowing the rule; empty on classic NAT rows. */
    match?: string;
    /** Orders rules sharing a match; absent when zero. */
    priority?: number;
    /** L4 source port range for SNAT. */
    externalPortRange?: string;
    options?: Record<string, string>;
    externalIds?: Record<string, string>;
}

export interface StaticRouteRow {
    uuid: string;
    ipPrefix: string;
    nexthop?: string;
    policy?: string;
    outputPort?: string;
    /** Named route table; empty for the main table. */
    routeTable?: string;
    /** BFD uuid guarding the nexthop. */
    bfd?: string;
    /** ECMP hash fields when set. */
    selectionFields?: string[];
    options?: Record<string, string>;
    externalIds?: Record<string, string>;
}

/** A chassis that may host a distributed gateway port, with its priority. */
export interface GatewayChassisRow {
    uuid: string;
    name: string;
    /** SB Chassis name (a UUID string), equal to the Node's
     * k8s.ovn.org/node-chassis-id annotation. */
    chassisName: string;
    priority: number;
    options?: Record<string, string>;
    externalIds?: Record<string, string>;
}

/**
 * The zone's single NB_Global row. nb_cfg is bumped by the CMS; sb_cfg and
 * hv_cfg follow as northd and the chassis catch up, so equal values mean
 * every chassis has applied the current configuration.
 */
export interface NBGlobalRow {
    uuid: string;
    /** Zone name under interconnect (also options.name). */
    name?: string;
    nbCfg: number;
    sbCfg: number;
    hvCfg: number;
    /** Carries northd_internal_version among others. */
    options?: Record<string, string>;
    externalIds?: Record<string, string>;
}

/**
 * One NB Load_Balancer row. ovn-kubernetes writes one per Service, protocol
 * and scope, encodes the scope in the name
 * (`Service_<ns>/<name>_<PROTO>_cluster`, or `..._node_router+switch_<node>`,
 * `..._node_router_<node>`, `..._node_switch_<node>`) and names the owner in
 * externalIds (`k8s.ovn.org/kind`, `k8s.ovn.org/owner` = namespace/name).
 */
export interface LoadBalancerRow {
    uuid: string;
    name: string;
    /** tcp, udp or sctp; absent when unset, which OVN treats as tcp. */
    protocol?: string;
    /**
     * `"vip:port"` (IPv6 as `"[addr]:port"`) to the comma-separated
     * `"backend:port"` list, as stored. An empty string is a VIP without
     * endpoints; split with `splitBackends` (serviceIndex.ts).
     */
    vips: Record<string, string>;
    options?: Record<string, string>;
    /** Hash fields for backend selection, when set. */
    selectionFields?: string[];
    /** Load_Balancer_Health_Check uuids (table not collected). */
    healthCheck?: string[];
    /** Backend IP to `port_name:source_ip`, for health checks. */
    ipPortMappings?: Record<string, string>;
    externalIds?: Record<string, string>;
}

/**
 * One NB Load_Balancer_Group row: a named set of load balancers a switch or
 * router attaches as a unit. The table has no external_ids column.
 */
export interface LoadBalancerGroupRow {
    uuid: string;
    name: string;
    /** Member LoadBalancerRow uuids; empty for a group without members. */
    loadBalancers: string[];
}

/**
 * One NB ACL row. An ACL applies where it is attached: on a port group
 * (PortGroupRow.acls, the usual case) or on a switch (LogicalSwitchRow.acls).
 * ovn-kubernetes names the owner in externalIds (`k8s.ovn.org/owner-controller`,
 * `k8s.ovn.org/owner-type`, `k8s.ovn.org/name`, `k8s.ovn.org/id`); read it
 * with `ownerOf` (ovnOwner.ts).
 */
export interface ACLRow {
    uuid: string;
    /** Optional in the NB schema; absent on several owner types. */
    name?: string;
    priority: number;
    /** `from-lport` (traffic leaving a workload: egress policy) or `to-lport`
     * (traffic towards it: ingress policy). */
    direction: string;
    /** allow, allow-related, allow-stateless, drop, reject or pass. */
    action: string;
    /**
     * The OVN match expression as stored. `@name` refers to a port group and
     * `$name` to an address set, both by their `name`; parse with `matchRefs`
     * (policyIndex.ts).
     */
    match: string;
    /** Evaluation tier: tier 0 is evaluated first, priority orders within a tier. */
    tier: number;
    /** ACL logging; absent when false. */
    log?: boolean;
    severity?: string;
    meter?: string;
    /** Sampling label; absent when zero. */
    label?: number;
    options?: Record<string, string>;
    externalIds?: Record<string, string>;
}

/**
 * One NB Port_Group row: a named set of switch ports that ACLs apply to and
 * that a match names as `@name`. ovn-kubernetes names groups by hash; the
 * readable name and the owner are in externalIds.
 */
export interface PortGroupRow {
    uuid: string;
    name: string;
    /** Member LogicalSwitchPortRow uuids. Under interconnect a zone's group
     * lists only that zone's own ports; empty for a group with no local member. */
    ports: string[];
    /** ACLRow uuids applied to every member port. */
    acls: string[];
    externalIds?: Record<string, string>;
}

/** One NB Address_Set row: a named set of addresses a match names as `$name`. */
export interface AddressSetRow {
    uuid: string;
    name: string;
    /** IPs, CIDRs or MACs as stored; empty for a set without members. */
    addresses: string[];
    externalIds?: Record<string, string>;
}

export interface LogicalDatabase {
    logicalRouters: LogicalRouterRow[];
    logicalRouterPorts: LogicalRouterPortRow[];
    logicalSwitches: LogicalSwitchRow[];
    logicalSwitchPorts: LogicalSwitchPortRow[];
    nats: NATRow[];
    staticRoutes: StaticRouteRow[];
    /** Absent on snapshots from collectors older than the field. */
    bridgeMappings?: BridgeMappingRow[];
    /** Resolves LogicalRouterPortRow.gatewayChassis; absent on snapshots from
     * collectors older than the field. */
    gatewayChassis?: GatewayChassisRow[];
    /** Absent on snapshots from collectors older than the field. */
    nbGlobal?: NBGlobalRow;

    // Optional sections: present only when the request names the section
    // (see SnapshotSection). An absent key means "not requested, or
    // not collected"; an empty array means "collected, and the table is empty".
    /** Section `policy`. */
    acls?: ACLRow[];
    /** Section `policy`. */
    portGroups?: PortGroupRow[];
    /** Section `policy`. */
    addressSets?: AddressSetRow[];
    /** Section `services`. */
    loadBalancers?: LoadBalancerRow[];
    /** Section `services`. */
    loadBalancerGroups?: LoadBalancerGroupRow[];
}

/**
 * Optional groups of database tables the collector delivers on request:
 * `GET /api/v1/sections/policy,services/snapshots[/:node]` (the plugin's
 * spelling, because the console drops query strings) or the equivalent
 * `GET /api/v1/snapshots[/:node]?include=policy,services`. Without either a
 * snapshot carries the ladder tables only.
 */
export type SnapshotSection = 'policy' | 'services';

/** The database keys each section adds to a snapshot. */
export const SNAPSHOT_SECTION_KEYS = {
    policy: ['acls', 'portGroups', 'addressSets'],
    services: ['loadBalancers', 'loadBalancerGroups'],
} as const satisfies Record<SnapshotSection, readonly (keyof LogicalDatabase)[]>;

export interface LogicalTopologySnapshot {
    metadata: LogicalTopologyMetadata;
    /** v2 payload; absent on v1 snapshots from a not-yet-upgraded collector. */
    database?: LogicalDatabase;
    /** @deprecated v1 graph payload. */
    nodes: LogicalTopologyNode[];
    /** @deprecated v1 graph payload. */
    edges: LogicalTopologyEdge[];
    /** @deprecated v1 graph payload. */
    groups: LogicalTopologyGroup[];
    warnings: LogicalTopologyWarning[];
}

/** Aggregate payload from GET /api/v1/snapshots: one zone snapshot per node. */
export interface ClusterLogicalTopology {
    metadata: {
        schemaVersion: string;
        generatedAt: string;
        sourceHealth: string;
    };
    snapshots: LogicalTopologySnapshot[];
    warnings: LogicalTopologyWarning[];
}

// Lookup contract: the response of GET /api/v1/lookup/{kind}/{value}, which
// answers "where is this address or name?" across every stored zone snapshot
// (ovn-recon-tpp.1). Mirrors collector/internal/snapshot/lookup_types.go and
// collector/api/lookup-response.schema.json; src/lookupContract.test.ts
// checks the value lists below against the schema.

/** What a lookup value is. `name` is a case-insensitive substring. */
export const LOOKUP_KINDS = ['ip', 'mac', 'cidr', 'name'] as const;
export type LookupKind = (typeof LOOKUP_KINDS)[number];

/**
 * How a stored value matched, best first (the order hits arrive in):
 * `exact` the stored address, CIDR or name equals the query; `containment`
 * a stored CIDR contains the queried address or CIDR, so the row is about a
 * range the query falls in; `within` the stored address or CIDR lies inside
 * the queried CIDR; `substring` the stored name contains the queried text.
 */
export const LOOKUP_MATCH_TYPES = ['exact', 'containment', 'within', 'substring'] as const;
export type LookupMatchType = (typeof LOOKUP_MATCH_TYPES)[number];

/** The northbound table of a hit's row, as OVN spells it. */
export const LOOKUP_TABLES = [
    'Logical_Switch',
    'Logical_Router',
    'Logical_Switch_Port',
    'Logical_Router_Port',
    'NAT',
    'Logical_Router_Static_Route',
    'Load_Balancer',
] as const;
export type LookupTable = (typeof LOOKUP_TABLES)[number];

/** The field that matched, as the path of the value in the snapshot row. */
export const LOOKUP_FIELDS = [
    'name',
    'addresses',
    'dynamicAddresses',
    'portSecurity',
    'networks',
    'mac',
    'externalIp',
    'logicalIp',
    'externalMac',
    'ipPrefix',
    'vips',
    'otherConfig.subnet',
    'otherConfig.ipv6_prefix',
    'externalIds.namespace',
    'externalIds.k8s.ovn.org/network',
] as const;
export type LookupField = (typeof LOOKUP_FIELDS)[number];

export const LOOKUP_CONSTRUCT_KINDS = ['switch', 'router'] as const;
export type LookupConstructKind = (typeof LOOKUP_CONSTRUCT_KINDS)[number];

export interface LookupQuery {
    kind: LookupKind;
    /** Normalised by the collector: a CIDR masked to its network, a MAC in
     * lower-case colon form, a name trimmed. */
    value: string;
}

/** The logical switch or router a row belongs to (or is). */
export interface LookupConstruct {
    kind: LookupConstructKind;
    name: string;
    uuid: string;
}

/** The Kubernetes object a row's external_ids name. */
export interface LookupOwner {
    /** `Pod` for a pod's switch port, `Service` for a load balancer, else
     * the row's `k8s.ovn.org/owner-type`. */
    kind: string;
    /** Absent for a cluster-scoped owner and for an owner type whose name
     * format the collector does not split. */
    namespace?: string;
    name: string;
}

/**
 * One matching row in one zone. The same address in another zone, or in
 * another network of the same zone, is another hit: user-defined network
 * subnets may overlap, so hits are never merged and none is "the" answer.
 */
export interface LookupHit {
    /** The zone: the node whose snapshot holds the row. */
    node: string;
    table: LookupTable;
    rowUuid: string;
    /** Absent for the tables without a name column (NAT, static routes). */
    rowName?: string;
    /** Absent for a load balancer (attached to many switches and routers)
     * and for a row nothing in the zone references. */
    construct?: LookupConstruct;
    /** The `k8s.ovn.org/network` identity: `default`, `cluster_udn_<name>`
     * or `<namespace>_<name>`. */
    network: string;
    /** Present only when the row's external_ids name an owner. */
    owner?: LookupOwner;
    matchedField: LookupField;
    /** The matched value as stored: one address entry, one network, one VIP
     * key, the name. */
    matchedValue: string;
    matchType: LookupMatchType;
    /** When the zone's snapshot was collected: how old this answer is. */
    snapshotGeneratedAt: string;
}

/** One zone snapshot that was searched. */
export interface LookupZone {
    node: string;
    snapshotGeneratedAt: string;
    sourceHealth: string;
}

export interface LookupResponse {
    query: LookupQuery;
    /** Best match first, then by node, table and row name; cut to `limit`. */
    hits: LookupHit[];
    /** Every matching row, including the ones cut by `limit`. */
    total: number;
    limit: number;
    /** True when `total` exceeds `limit`. */
    truncated: boolean;
    /** The zones that were searched. A lookup reads stored snapshots only
     * and never collects, so a node missing here was not searched (see
     * `warnings`: `ZONE_NOT_CACHED`, `LOOKUP_CACHE_DISABLED`). */
    zones: LookupZone[];
    warnings: LogicalTopologyWarning[];
}

export interface OvnRecon extends K8sResourceCommon {
    spec?: {
        collector?: {
            enabled?: boolean;
        };
    };
}
