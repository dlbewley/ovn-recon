import type { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import type { ClusterUserDefinedNetwork, NetworkAttachmentDefinition } from '../types';

/*
 * Fixtures for the masquerade rule tests (ovn-recon-2n6.5), hand-written from the
 * API shapes. The primary CUDN matches the collector snapshot fixtures
 * (collector/fixtures/snapshots/cnv-1.json): example-p-cudn, network ID 3, whose
 * gateway routers SNAT to 169.254.0.15. Not imported by any shipped module.
 */

export const DEFAULT_ANNOTATION = '{"ipv4":"169.254.0.0/17","ipv6":"fd69::/112"}';
export const LEGACY_ANNOTATION = '{"ipv4":"169.254.169.0/29","ipv6":"fd69::/125"}';

export const masqueradeNode = (name: string, annotation: string | undefined = DEFAULT_ANNOTATION): K8sResourceCommon => ({
    apiVersion: 'v1',
    kind: 'Node',
    metadata: {
        name,
        ...(annotation ? { annotations: { 'k8s.ovn.org/node-masquerade-subnet': annotation } } : {})
    }
});

export const SNAPSHOT_NODES = ['cnv-1', 'cnv-2', 'ctrl-1'];

export const nadFor = (
    name: string,
    namespace: string,
    networkId: number,
    role: 'primary' | 'secondary',
    ovnName = `cluster_udn_${name}`
): NetworkAttachmentDefinition => ({
    apiVersion: 'k8s.cni.cncf.io/v1',
    kind: 'NetworkAttachmentDefinition',
    metadata: { name, namespace, annotations: { 'k8s.ovn.org/network-id': String(networkId) } },
    spec: {
        config: JSON.stringify({
            cniVersion: '1.0.0',
            name: ovnName,
            type: 'ovn-k8s-cni-overlay',
            topology: 'layer2',
            role,
            subnets: '10.1.2.0/24',
            netAttachDefName: `${namespace}/${name}`
        })
    }
} as NetworkAttachmentDefinition);

/** The primary CUDN of the snapshot fixtures, and its NAD. */
export const primaryCudn: ClusterUserDefinedNetwork = {
    apiVersion: 'k8s.ovn.org/v1',
    kind: 'ClusterUserDefinedNetwork',
    metadata: { name: 'example-p-cudn' },
    spec: {
        network: {
            topology: 'Layer2',
            layer2: { role: 'Primary', subnets: ['10.1.2.0/24'] }
        }
    }
};

export const primaryNad = nadFor('example-p-cudn', 'example-ns', 3, 'primary');
