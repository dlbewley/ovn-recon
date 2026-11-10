import { findPrimaryNetworkForVrf } from '../../components/nodeVisualizationSelectors';
import type { GraphContext } from '../../topology/context';
import { vrfNodeId } from '../../topology/ids';
import type { Interface } from '../../types';
import { getVrfPorts } from '../network';
import { interfacePath, interfaceRemedy, nnsFact, nodeNameOf } from '../node';
import { cudnRef, makeFinding } from '../refs';
import type { Evidence, K8sRef, PhysicalRule, Remedy } from '../types';

/**
 * Who owns a VRF, for the remedy. A Primary CUDN or UDN creates its VRF; anything
 * else was made by a NodeNetworkConfigurationPolicy or by hand. The match on the
 * network is a declared one only when the network's own status.vrfName names the
 * VRF; otherwise it rests on the naming convention and is marked inferred.
 */
const vrfOwner = (vrf: Interface, ctx: GraphContext): { remedy: Remedy; evidence?: Evidence } => {
    const match = findPrimaryNetworkForVrf(vrf, ctx.cudns, ctx.udns, ctx.interfaces, ctx.nads);
    if (match) {
        const ref: K8sRef = match.kind === 'cudn'
            ? cudnRef(match.name)
            : { group: 'k8s.ovn.org', version: 'v1', kind: 'UserDefinedNetwork', name: match.name, namespace: match.namespace };
        const declared = match.signals.includes('status');
        return {
            remedy: {
                text: `${ref.kind} ${ref.name} creates this VRF; OVN-Kubernetes manages its ports, so look at `
                    + `the network's status and the ovnkube-node logs on ${nodeNameOf(ctx)}.`,
                target: ref
            },
            evidence: {
                fact: `VRF ${vrf.name} belongs to ${ref.kind} ${ref.name}.`,
                sources: [ref],
                path: declared ? 'status.vrfName' : undefined,
                inferred: declared ? undefined : `Matched by ${match.signals.join(', ')}, not by a field that names the VRF.`
            }
        };
    }
    return {
        remedy: interfaceRemedy(
            ctx,
            vrf.name,
            (policy) => `Correct the ports of VRF ${vrf.name} in NodeNetworkConfigurationPolicy ${policy}.`,
            `Check what configures VRF ${vrf.name} on ${nodeNameOf(ctx)}; no enactment claims it.`
        )
    };
};

/**
 * vrf-port-unmatched: a VRF declares a port that no interface on the node carries.
 * Whatever was meant to be routed in that VRF through the port is not.
 */
export const vrfPortUnmatched: PhysicalRule = {
    id: 'vrf-port-unmatched',
    severity: 'warning',
    scope: 'node',
    domain: 'physical',
    title: 'VRF names a port that does not exist',
    evaluate: ({ node: ctx }) => {
        if (!ctx || ctx.interfaces.length === 0) return [];
        const node = nodeNameOf(ctx);
        const names = new Set(ctx.interfaces.map((iface) => iface.name));

        return ctx.interfaces.filter((iface) => iface.type === 'vrf').flatMap((vrf) => {
            const missing = getVrfPorts(vrf).filter((port) => !names.has(port));
            if (missing.length === 0) return [];
            const owner = vrfOwner(vrf, ctx);
            return missing.map((port) => makeFinding({
                ruleId: vrfPortUnmatched.id,
                severity: vrfPortUnmatched.severity,
                // One finding per missing port: the subject is the VRF, so the key needs the port.
                subject: { kind: 'graph-node', node, graphNodeId: vrfNodeId(vrf.name) },
                scope: { node },
                summary: `VRF ${vrf.name} on ${node} declares port ${port}, which no interface carries.`,
                evidence: [
                    nnsFact(ctx, `VRF ${vrf.name} declares port ${port}.`, interfacePath(vrf.name, 'vrf.port')),
                    nnsFact(ctx, `No interface named ${port} is reported.`, 'status.currentState.interfaces'),
                    ...(owner.evidence ? [owner.evidence] : [])
                ],
                remedy: owner.remedy
            }, port));
        });
    }
};
