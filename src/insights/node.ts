import { getPoliciesClaimingBridgeMapping, getPoliciesClaimingInterface } from '../components/nodeVisualizationSelectors';
import type { GraphContext } from '../topology/context';
import { nncpRef, nnsRef, nodeRef } from './refs';
import type { Evidence, K8sRef, Remedy } from './types';

/** Helpers shared by the node-scope rules. */

export const nodeNameOf = (ctx: GraphContext): string => ctx.nns?.metadata?.name || '';

export const nnsSource = (ctx: GraphContext): K8sRef[] => [nnsRef(nodeNameOf(ctx))];

export const interfacePath = (name: string, field?: string): string =>
    `status.currentState.interfaces[name=${name}]${field ? `.${field}` : ''}`;

/** An evidence line read from this node's NodeNetworkState. */
export const nnsFact = (ctx: GraphContext, fact: string, path?: string): Evidence =>
    ({ fact, sources: nnsSource(ctx), path });

/**
 * The remedy for something a NodeNetworkConfigurationPolicy configured: edit that
 * policy, when an enactment on this node says one did. Otherwise the host itself,
 * since the installer or OVN-Kubernetes made it and there is no policy to edit.
 */
const policyOrNodeRemedy = (
    ctx: GraphContext,
    policies: string[],
    withPolicy: (policy: string) => string,
    withoutPolicy: string
): Remedy => (policies.length > 0
    ? { text: withPolicy(policies[0]), target: nncpRef(policies[0]) }
    : { text: withoutPolicy, target: nodeRef(nodeNameOf(ctx)) });

export const interfaceRemedy = (
    ctx: GraphContext,
    interfaceName: string,
    withPolicy: (policy: string) => string,
    withoutPolicy: string
): Remedy => policyOrNodeRemedy(
    ctx,
    getPoliciesClaimingInterface(interfaceName, ctx.enactments).map((claim) => claim.policyName),
    withPolicy,
    withoutPolicy
);

export const bridgeMappingRemedy = (
    ctx: GraphContext,
    localnet: string,
    withPolicy: (policy: string) => string,
    withoutPolicy: string
): Remedy => policyOrNodeRemedy(
    ctx,
    getPoliciesClaimingBridgeMapping(localnet, ctx.enactments).map((claim) => claim.policyName),
    withPolicy,
    withoutPolicy
);
