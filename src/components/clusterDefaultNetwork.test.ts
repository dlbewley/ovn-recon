import { clone, loadItems } from '../insights/testing';
import type { ClusterUserDefinedNetwork, NetworkAttachmentDefinition, UserDefinedNetwork } from '../types';
import {
    CLUSTER_DEFAULT_NETWORK_TEXT,
    clusterDefaultNetworkText,
    nodeNetworkStateUnavailableText,
    primaryUdnNamespaces,
} from './clusterDefaultNetwork';
import type { NetworkInputs } from './networkPageModel';

const inputs = (overrides: Partial<NetworkInputs> = {}): NetworkInputs => ({
    cudns: [],
    udns: [],
    nads: [],
    routeAdvertisements: [],
    ...overrides,
});

const udn = (namespace: string, role: string, name = 'tenant'): UserDefinedNetwork => ({
    metadata: { name, namespace },
    spec: { topology: 'Layer2', layer2: { role, subnets: ['10.20.0.0/24'] } },
} as UserDefinedNetwork);

const primaryCudns = loadItems<ClusterUserDefinedNetwork>('cudn', 'primary-cudn-vrf.json');

describe('primaryUdnNamespaces', () => {
    it('is empty when nothing primary is visible', () => {
        expect(primaryUdnNamespaces(inputs({ udns: [udn('blue', 'Secondary')] }))).toEqual([]);
    });

    it('takes a primary UDN\'s namespace, once and sorted', () => {
        const udns = [udn('green', 'Primary'), udn('blue', 'Primary'), udn('blue', 'Primary', 'other')];
        expect(primaryUdnNamespaces(inputs({ udns }))).toEqual(['blue', 'green']);
    });

    it('takes the namespaces a primary CUDN reports', () => {
        expect(primaryUdnNamespaces(inputs({ cudns: primaryCudns }))).toContain('demo-vm-primary-udn');
    });

    it('takes the namespace of a primary NAD with no network behind it', () => {
        const nad: NetworkAttachmentDefinition = {
            metadata: { name: 'tenant', namespace: 'red' },
            spec: { config: '{"type":"ovn-k8s-cni-overlay","topology":"layer2","role":"primary"}' },
        };
        expect(primaryUdnNamespaces(inputs({ nads: [nad] }))).toEqual(['red']);
    });

    it('leaves out a network OVN-Kubernetes did not create', () => {
        const failed = clone(udn('blue', 'Primary'));
        failed.status = { conditions: [{ type: 'NetworkCreated', status: 'False' }] } as UserDefinedNetwork['status'];
        expect(primaryUdnNamespaces(inputs({ udns: [failed] }))).toEqual([]);
    });
});

describe('clusterDefaultNetworkText', () => {
    it('says what the network is, claiming nothing about primary UDNs it cannot see', () => {
        expect(clusterDefaultNetworkText(inputs())).toBe(CLUSTER_DEFAULT_NETWORK_TEXT);
    });

    it('names one namespace', () => {
        expect(clusterDefaultNetworkText(inputs({ udns: [udn('blue', 'Primary')] })))
            .toBe(`${CLUSTER_DEFAULT_NETWORK_TEXT} Namespace with a primary UDN: blue.`);
    });

    it('names several namespaces', () => {
        expect(clusterDefaultNetworkText(inputs({ udns: [udn('green', 'Primary'), udn('blue', 'Primary')] })))
            .toBe(`${CLUSTER_DEFAULT_NETWORK_TEXT} Namespaces with a primary UDN: blue, green.`);
    });
});

describe('nodeNetworkStateUnavailableText', () => {
    it('costs the default network only its physical detail', () => {
        const text = nodeNetworkStateUnavailableText({ clusterDefault: true });
        expect(text).toContain('the per-node physical detail (br-ex, uplinks) cannot be drawn.');
        expect(text).not.toContain('wired');
    });

    it('costs any other network the answer to where it is wired', () => {
        expect(nodeNetworkStateUnavailableText({})).toBe(
            'This cluster does not serve NodeNetworkState (it comes with the Kubernetes NMState Operator), '
            + 'so where this network is wired cannot be shown.',
        );
    });
});
