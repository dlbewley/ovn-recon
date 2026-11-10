import { findEvpnNetworkForDevice, parseNadConfig } from '../components/nodeVisualizationSelectors';
import type { GraphContext } from '../topology/context';
import { interfaceNodeId } from '../topology/ids';
import type { Interface } from '../types';
import type { Finding } from './types';

/**
 * Surface gates (ovn-recon-7i6.1): findings the engine reports correctly but the
 * surfaces hold back while a question about them is open. The engine stays honest --
 * its rules and tests are unchanged -- and each gate is one entry in SURFACE_GATES,
 * so lifting it is deleting that line.
 */

/**
 * The EVPN network an interface was created for, when the interface is one of the
 * per-network devices OVN-Kubernetes makes for EVPN (its L2/L3 SVI, a port of the
 * network's VRF, or its OVS-side port) AND the network it resolves to declares EVPN.
 *
 * Read from the same data the EVPN drawer facts use (findEvpnNetworkForDevice: the
 * device name resolved through the CUDN names and the NADs' network-id annotation),
 * then confirmed against the network itself: a CUDN's spec.network.evpn, or the evpn
 * block of that network's NAD config. A device name that merely looks like svl2.* but
 * resolves to no network, or to one that declares no EVPN, is not matched.
 */
export const evpnNetworkOfInterface = (
    iface: Pick<Interface, 'name'>,
    ctx: Pick<GraphContext, 'cudns' | 'udns' | 'nads'>
): string | undefined => {
    const device = findEvpnNetworkForDevice(iface.name, ctx.cudns, ctx.udns, ctx.nads);
    const network = device?.network;
    if (!network) return undefined;
    if (network.kind === 'cudn') {
        const cudn = ctx.cudns.find((candidate) => candidate.metadata?.name === network.name);
        if (cudn?.spec?.network?.evpn) return `ClusterUserDefinedNetwork ${network.name}`;
    }
    const nad = device.nad && ctx.nads.find((candidate) =>
        candidate.metadata?.name === device.nad?.name
        && (candidate.metadata?.namespace || 'default') === device.nad?.namespace);
    if (nad && parseNadConfig(nad.spec?.config)?.evpn) {
        return network.kind === 'cudn'
            ? `ClusterUserDefinedNetwork ${network.name}`
            : `UserDefinedNetwork ${network.namespace}/${network.name}`;
    }
    return undefined;
};

/** The interface a graph-node finding is about, matched by its canonical graph id. */
const subjectInterface = (finding: Finding, ctx: GraphContext): Interface | undefined => {
    const { subject } = finding;
    if (subject.kind !== 'graph-node') return undefined;
    return ctx.interfaces.find((iface) => interfaceNodeId(iface, ctx) === subject.graphNodeId);
};

export interface SurfaceGate {
    /** The bead whose open question holds this back. */
    bead: string;
    ruleId: string;
    /** True to hold the finding back. `ctx` is the finding's node's context, when known. */
    hides: (finding: Finding, ctx: GraphContext | undefined) => boolean;
}

/**
 * GATE, ovn-recon-7i6.2: interface-down on the EVPN interfaces of a network.
 *
 * On the lab every node reports its EVPN network's SVI (a VLAN port of the network's
 * VRF) and its OVS-side port down, while the EVPN bridge and VXLAN device are up.
 * Whether that is normal for an idle EVPN network or a fault is not yet known, so
 * those interfaces show nothing until it is answered. Every other down interface --
 * including an ordinary port of the same VRF -- still shows.
 */
const evpnInterfaceDownGate: SurfaceGate = {
    bead: 'ovn-recon-7i6.2',
    ruleId: 'interface-down',
    hides: (finding, ctx) => {
        if (!ctx) return false;
        const iface = subjectInterface(finding, ctx);
        return Boolean(iface && evpnNetworkOfInterface(iface, ctx));
    }
};

export const SURFACE_GATES: readonly SurfaceGate[] = [
    evpnInterfaceDownGate, // ovn-recon-7i6.2: delete this line to show EVPN interface-down again
];

/**
 * The findings a surface shows: the engine's, less those a gate holds back.
 * `contextFor` gives the GraphContext of a finding's node, or undefined.
 */
export const applySurfaceGates = (
    findings: Finding[],
    contextFor: (node: string) => GraphContext | undefined,
    gates: readonly SurfaceGate[] = SURFACE_GATES
): Finding[] => {
    if (gates.length === 0 || findings.length === 0) return findings;
    const kept = findings.filter((finding) => !gates.some((gate) =>
        gate.ruleId === finding.ruleId
        && gate.hides(finding, finding.scope.node ? contextFor(finding.scope.node) : undefined)));
    return kept.length === findings.length ? findings : kept;
};
