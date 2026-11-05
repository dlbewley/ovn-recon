import { Interface } from '../types';
import { GraphContext } from './context';

/**
 * What an interface *is* in the topology, as opposed to what nmstate calls it.
 *
 * The lanes used to key off the raw `type` string, and where type and role diverged
 * ad hoc heuristics filled the gap -- an isBridge() that answered "yes, unless a bridge
 * shadows this name, in which case no", paired with a logicalInterfaces filter that
 * re-included the very interface isBridge() had just rejected. Both are replaced by the
 * ordered rule table below, where each rule is named and says what nmstate reality it
 * encodes.
 *
 * Two roles are not drawn at all, and that is deliberate rather than accidental:
 * `unmanaged` and `patch`, nothing else. They were previously excluded by a negation
 * that never said so.
 */
export type InterfaceRole =
    /** A physical NIC. */
    | 'physical'
    /** A link aggregation. */
    | 'bond'
    /** A VLAN or MACVLAN device layered on a base interface. */
    | 'vlan'
    /** A VXLAN tunnel device: a VTEP, enslaved to a bridge and carried on an underlay. */
    | 'vxlan'
    /** A bridge, whether declared as one or acting as one. */
    | 'bridge'
    /** An OVS internal port on a bridge. */
    | 'bridge-port'
    /** A VRF routing domain. */
    | 'vrf'
    /** Present but not managed by nmstate. Not drawn. */
    | 'unmanaged'
    /** An OVS patch port joining two bridges. Not drawn. */
    | 'patch'
    /** A real device that is not a topology participant: loopback, veth. */
    | 'host-local'
    /**
     * The Geneve tunnel device carrying the OVN overlay between nodes. Drawn at the
     * foot of the canvas with no edges: nmstate reports the device and nothing that
     * references it, so tying a network to it would be assertion, not inference.
     */
    | 'overlay-tunnel'
    /** No rule matched. Drawn in the catch-all, and a prompt to add a rule. */
    | 'unclassified';

export interface Classification {
    role: InterfaceRole;
    /** The rule that matched, for explaining the result. See ovn-recon-s3t.30. */
    reason: string;
}

const DECLARED_BRIDGE_TYPES = ['linux-bridge', 'ovs-bridge', 'openvswitch'];
const VLAN_TYPES = ['vlan', 'mac-vlan'];
/** Kernel devices that exist on every node and take no part in the topology. */
const HOST_LOCAL_TYPES = ['loopback', 'veth'];
/** OVS names the kernel's Geneve device `genev_sys_<udp port>`, 6081 by default. */
const GENEVE_DEVICE_PREFIX = 'genev_sys_';

type Rule = {
    role: InterfaceRole;
    reason: string;
    when: (iface: Interface, ctx: GraphContext) => boolean;
};

/**
 * Ordered: the first match wins. Order is load-bearing in three places, all marked.
 */
const RULES: Rule[] = [
    {
        role: 'bridge',
        reason: 'nmstate reports it as a bridge type',
        when: (iface) => DECLARED_BRIDGE_TYPES.includes(iface.type)
    },
    {
        role: 'vrf',
        reason: 'nmstate reports it as a VRF',
        when: (iface) => iface.type === 'vrf'
    },
    {
        role: 'bond',
        reason: 'nmstate reports it as a link aggregation',
        when: (iface) => iface.type === 'bond'
    },
    {
        role: 'vlan',
        reason: 'a VLAN or MACVLAN device on a base interface',
        when: (iface) => VLAN_TYPES.includes(iface.type)
    },
    {
        role: 'vxlan',
        reason: 'a VXLAN tunnel device (VTEP) on an underlay address',
        when: (iface) => iface.type === 'vxlan'
    },
    {
        // ORDER MATTERS: this must precede the acting-as-a-bridge rule below. An OVS
        // bridge and its internal port share a name, and the port is not the bridge.
        role: 'bridge-port',
        reason: 'an OVS internal port sharing its name with the bridge it belongs to',
        when: (iface, ctx) =>
            iface.type === 'ovs-interface'
            && iface.state !== 'ignore'
            && ctx.explicitBridgeNames.has(iface.name)
    },
    {
        role: 'patch',
        reason: 'an OVS patch port joining two bridges',
        when: (iface) =>
            iface.type === 'ovs-interface'
            && (Boolean(iface.patch) || iface.name.startsWith('patch'))
    },
    {
        // ORDER MATTERS: after the shadowing rule, so a port that shares a bridge's
        // name is never mistaken for the bridge itself.
        role: 'bridge',
        reason: 'an OVS interface that other interfaces are enslaved to, so it acts as a bridge',
        when: (iface, ctx) =>
            iface.type === 'ovs-interface'
            && iface.state !== 'ignore'
            && ctx.controllerNames.has(iface.name)
            && !iface.patch
    },
    {
        role: 'unmanaged',
        reason: 'nmstate reports state: ignore, so it is present but not managed',
        // Applies only to the types whose lanes previously filtered on it. Deliberately
        // NOT a top-level rule: an ignored interface of an unrecognised type has always
        // been drawn in the catch-all, and hoisting this rule would silently remove it.
        when: (iface) =>
            iface.state === 'ignore' && ['ethernet', 'ovs-interface'].includes(iface.type)
    },
    {
        // ORDER MATTERS: after `unmanaged`, and that is a deliberate limit rather than
        // an oversight. nmstate cannot type this device and its guess varies: `unknown`
        // in two captures, where the tunnel used to fall through every rule to
        // `unclassified`, and `ethernet` in a third, where the rule above already hides
        // it as an ignored NIC. This rule gives the first case a name and changes what
        // NO cluster draws. Hoisting it would make the role the same everywhere, and
        // would also start drawing the tunnel on clusters that hide it today -- whether
        // it should be a node at all is a question ovn-recon-s3t.29 left open.
        role: 'overlay-tunnel',
        reason: 'the Geneve tunnel device OVS creates for the OVN overlay, recognised by its genev_sys_ name',
        when: (iface) => iface.name.startsWith(GENEVE_DEVICE_PREFIX)
    },
    {
        role: 'bridge-port',
        reason: 'an OVS internal port',
        when: (iface) => iface.type === 'ovs-interface'
    },
    {
        role: 'physical',
        reason: 'a physical NIC',
        when: (iface) => iface.type === 'ethernet'
    },
    {
        role: 'host-local',
        reason: 'a kernel device that takes no part in the topology',
        when: (iface) => HOST_LOCAL_TYPES.includes(iface.type)
    }
];

/**
 * Resolve an interface to its topology role.
 *
 * Total by construction: anything no rule matches is `unclassified` rather than falling
 * through a negation. That is what gives a new interface type -- a VTEP on a dummy, say
 * -- a declared home instead of the grey grid at the foot of the canvas.
 */
export const classify = (iface: Interface, ctx: GraphContext): Classification => {
    const matched = RULES.find((rule) => rule.when(iface, ctx));
    return matched
        ? { role: matched.role, reason: matched.reason }
        : { role: 'unclassified', reason: `no rule matched type "${iface.type}"` };
};

export const roleOf = (iface: Interface, ctx: GraphContext): InterfaceRole =>
    classify(iface, ctx).role;

/** Roles that are present in the data but deliberately not drawn. */
export const UNDRAWN_ROLES: InterfaceRole[] = ['unmanaged', 'patch'];

export const isDrawn = (role: InterfaceRole): boolean => !UNDRAWN_ROLES.includes(role);

/**
 * Roles drawn in the grid at the foot of the canvas rather than in a lane: real
 * devices this view can place in no relationship. `unclassified` landing here is a
 * prompt to add a rule, not a resting place.
 */
export const FOOT_GRID_ROLES: InterfaceRole[] = ['host-local', 'overlay-tunnel', 'unclassified'];

/** All interfaces resolving to a role, in their original order. */
export const interfacesWithRole = (ctx: GraphContext, role: InterfaceRole): Interface[] =>
    ctx.interfaces.filter((iface) => roleOf(iface, ctx) === role);
