import { getBondMembers, parseNadConfig } from '../../components/nodeVisualizationSelectors';
import { interfaceNodeId } from '../../topology/ids';
import type { Interface } from '../../types';
import { getActiveBridgeMappings, getBridgeUplinks, getVrfPorts } from '../network';
import { interfacePath, interfaceRemedy, nnsFact, nodeNameOf } from '../node';
import { makeFinding, nadRef } from '../refs';
import type { Evidence, PhysicalRule } from '../types';

const NAD_BRIDGE_TYPES = ['bridge', 'cnv-bridge'];

/**
 * interface-down: an interface that matters is down. It matters when it is
 *
 *   - a port of a VRF (named in vrf.port, or enslaved to the VRF), or
 *   - an uplink of a bridge one of this node's bridge mappings names, or
 *   - a bridge a bridge-type NAD attaches to, or an uplink of one.
 *
 * Unused NICs are down on most hosts and are not reported. Bond members are left to
 * bond-degraded, which can say how many of the bond's members remain.
 */
export const interfaceDown: PhysicalRule = {
    id: 'interface-down',
    severity: 'warning',
    scope: 'node',
    domain: 'physical',
    title: 'Interface carrying traffic is down',
    evaluate: ({ node: ctx }) => {
        if (!ctx || ctx.interfaces.length === 0) return [];
        const node = nodeNameOf(ctx);
        const byName = new Map(ctx.interfaces.map((iface) => [iface.name, iface]));
        const reasons = new Map<string, Evidence[]>();
        const addReason = (iface: Interface | undefined, evidence: Evidence) => {
            if (!iface) return;
            const list = reasons.get(iface.name) ?? [];
            if (!list.some((e) => e.fact === evidence.fact)) list.push(evidence);
            reasons.set(iface.name, list);
        };

        const vrfs = ctx.interfaces.filter((iface) => iface.type === 'vrf');
        vrfs.forEach((vrf) => getVrfPorts(vrf).forEach((port) => addReason(byName.get(port), nnsFact(
            ctx, `${port} is a port of VRF ${vrf.name}.`, interfacePath(vrf.name, 'vrf.port')))));
        const vrfNames = new Set(vrfs.map((vrf) => vrf.name));
        ctx.interfaces.forEach((iface) => {
            const controller = iface.controller || iface.master;
            if (controller && vrfNames.has(controller)) {
                addReason(iface, nnsFact(ctx, `${iface.name} is enslaved to VRF ${controller}.`,
                    interfacePath(iface.name, 'controller')));
            }
        });

        getActiveBridgeMappings(ctx.nns).forEach((mapping) => {
            getBridgeUplinks(mapping.bridge, ctx.interfaces).forEach((uplink) => addReason(uplink, nnsFact(
                ctx,
                `${uplink.name} is an uplink of bridge ${mapping.bridge}, which physical network ${mapping.localnet} is mapped to.`,
                interfacePath(uplink.name, 'controller'))));
        });

        ctx.nads.forEach((nad) => {
            const config = parseNadConfig(nad.spec?.config);
            const bridge = typeof config?.bridge === 'string' ? config.bridge : undefined;
            if (!bridge || !NAD_BRIDGE_TYPES.includes(String(config?.type))) return;
            const ref = nadRef(nad);
            const nadName = `${ref.namespace}/${ref.name}`;
            const fact = (text: string): Evidence => ({ fact: text, sources: [ref], path: 'spec.config.bridge' });
            addReason(byName.get(bridge), fact(`NetworkAttachmentDefinition ${nadName} attaches to bridge ${bridge}.`));
            getBridgeUplinks(bridge, ctx.interfaces).forEach((uplink) => addReason(uplink, fact(
                `${uplink.name} is an uplink of bridge ${bridge}, which NetworkAttachmentDefinition ${nadName} attaches to.`)));
        });

        const bondMembers = new Set(ctx.interfaces
            .filter((iface) => iface.type === 'bond')
            .flatMap((bond) => getBondMembers(bond)));

        return ctx.interfaces
            .filter((iface) => iface.state === 'down' && reasons.has(iface.name) && !bondMembers.has(iface.name))
            .map((iface) => makeFinding({
                ruleId: interfaceDown.id,
                severity: interfaceDown.severity,
                subject: { kind: 'graph-node', node, graphNodeId: interfaceNodeId(iface, ctx) },
                scope: { node },
                summary: `Interface ${iface.name} on ${node} is down.`,
                evidence: [
                    nnsFact(ctx, `${iface.name} (${iface.type}) is in state down.`, interfacePath(iface.name, 'state')),
                    ...(reasons.get(iface.name) ?? [])
                ],
                remedy: interfaceRemedy(
                    ctx,
                    iface.name,
                    (policy) => `Check ${iface.name} as NodeNetworkConfigurationPolicy ${policy} configures it, `
                        + 'and the link or device beneath it.',
                    `Check ${iface.name} on ${node}: the link, the switch port or device beneath it, `
                        + 'and whatever is meant to bring it up.'
                )
            }));
    }
};
