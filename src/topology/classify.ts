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
 * Three roles are not drawn at all, and that is deliberate rather than accidental:
 * `unmanaged`, `patch` and nothing else. They were previously excluded by a negation
 * that never said so.
 */
export type InterfaceRole =
    /** A physical NIC. */
    | 'physical'
    /** A link aggregation. */
    | 'bond'
    /** A VLAN or MACVLAN device layered on a base interface. */
    | 'vlan'
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

type Rule = {
    role: InterfaceRole;
    reason: string;
    when: (iface: Interface, ctx: GraphContext) => boolean;
};

/**
 * Ordered: the first match wins. Order is load-bearing in two places, both marked.
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
        // NOT a top-level rule: an ignored interface of an unrecognised type -- the
        // Geneve tunnel, for one -- has always been drawn in the catch-all, and hoisting
        // this rule would silently remove it.
        when: (iface) =>
            iface.state === 'ignore' && ['ethernet', 'ovs-interface'].includes(iface.type)
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

/** All interfaces resolving to a role, in their original order. */
export const interfacesWithRole = (ctx: GraphContext, role: InterfaceRole): Interface[] =>
    ctx.interfaces.filter((iface) => roleOf(iface, ctx) === role);
